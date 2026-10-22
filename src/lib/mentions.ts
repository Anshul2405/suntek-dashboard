/**
 * @-mention tagging, CC / watchers, and per-entity notes.
 *
 * "People" you can tag are the profile directory from RoleContext
 * (active user_accounts rows mapped through the DB role catalog). A tag is just a
 * profile id, which is the SAME id the notification system already targets
 * via `notifications.target_roles` — so tagging a person lights up their
 * TopBar bell + realtime feed with no extra plumbing.
 *
 * Persistence (entity_notes / entity_watchers) degrades gracefully: if the
 * tables from 10_mentions.sql don't exist yet, the @-autocomplete and the
 * immediate mention notification still work (the notifications table already
 * exists); only the saved note thread / watcher list is skipped.
 */
import { useCallback, useMemo } from 'react';
import { supabase } from './supabase';
import { insertRows, updateRows } from './db';
import { useRoleContext } from '../contexts/RoleContext';
import type { AppNotification } from '../contexts/NotificationsContext';

export interface TaggablePerson {
  id: string;
  name: string;
  roleLabel: string;
  initials: string;
  plant?: string;
}

// Returns whether the notification row was created (delivered) so callers can
// stamp read-receipts and surface pipeline failures.
type AddNotification = (n: Omit<AppNotification, 'id' | 'created_at' | 'read_by'>) => Promise<boolean>;

export interface EntityRef {
  entityType: string;
  entityId: string;
  entityLabel: string;
  route?: string | null;
}

export interface Actor {
  id: string;
  name: string;
  /** Human-readable role label, e.g. "Unit Head". */
  role: string;
}

export interface EntityNote {
  id: string;
  entity_type: string;
  entity_id: string;
  author_id: string;
  author_name: string;
  author_role: string | null;
  body: string;
  mentions: string[];
  created_at: string;
}

export interface Watcher {
  profile_id: string;
  profile_name: string;
  kind: string;
}

/** A delivery/read receipt for one tagged person on one note. */
export interface NoteReceipt {
  note_id: string;
  profile_id: string;
  delivered_at: string | null;
  seen_at: string | null;
}

/**
 * Aggregate receipt state for a comment, mirroring WhatsApp:
 *   'sent'      → single grey tick  (posted, not delivered to all → pipeline issue)
 *   'delivered' → double grey tick  (notification created for everyone tagged)
 *   'seen'      → double blue tick  (every tagged person has viewed it)
 */
export type TickState = 'sent' | 'delivered' | 'seen';

/** The deduped, sorted directory of people who can be tagged or CC'd. */
export function useDirectory(): TaggablePerson[] {
  const { allProfiles } = useRoleContext();
  return useMemo(() => {
    const seen = new Set<string>();
    const out: TaggablePerson[] = [];
    for (const p of allProfiles) {
      // Role slugs (factory_operator, …) are not people. Tagging those made
      // unexpected names appear and picked chips vanish on reload.
      if (!p.id.startsWith('db_') && !p.authUserId) continue;
      const key = p.name.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: p.id, name: p.name, roleLabel: p.roleLabel, initials: p.initials, plant: p.plant });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, [allProfiles]);
}

/**
 * The one-liner every form should call on save. Pass the free-text value and a
 * reference to the record it was saved on; anyone @-tagged (except you) gets an
 * instant bell notification and becomes a watcher of that record. Safe to call
 * with text that has no mentions (it no-ops) and degrades gracefully if the
 * watcher table is missing.
 *
 *   const notifyMentions = useMentionNotifier();
 *   await notifyMentions(form.notes, { entityType: 'purchase_order', entityId: row.id,
 *       entityLabel: `PO ${row.vendor}`, route: '/dashboard/purchase/purchase' });
 */
export function useMentionNotifier() {
  const people = useDirectory();
  const { activeProfile, activePersonId } = useRoleContext();
  return useCallback(
    async (
      text: string | null | undefined,
      ref: { entityType?: string; entityId?: string; entityLabel: string; route?: string | null },
    ) => {
      // Exclude SELF by personal id — so a provisioned user tagging the mock
      // archetype that shares their role isn't mistaken for self-tagging.
      const ids = extractMentionIds(text || '', people).filter((id) => id !== activePersonId);
      if (!ids.length) return;
      // Direct insert (mirrors the app's other notify() helpers) so it works
      // regardless of NotificationsContext readiness. `delivered` drives the
      // receipt tick — false means the notification pipeline errored.
      let delivered = false;
      const notif = {
        target_roles: ids,
        title: `${activeProfile.name} mentioned you`,
        body: `${ref.entityLabel}: “${truncate(text || '')}”`,
        type: 'info' as const,
        route: ref.route ?? null,
        actor_name: activeProfile.name,
        actor_role: activeProfile.roleLabel,
        read_by: [],
      };
      await insertRows('notifications', { ...notif, scope: 'personal' }).then(() => { delivered = true; }, () => {});
      // Fallback for a DB without the scope column (pre-24 migration).
      if (!delivered) {
        await insertRows('notifications', notif).then(() => { delivered = true; }, () => {});
      }
      // When the tag is attached to a record, leave a persistent trace in that
      // record's Notes thread (so the tagged person can see what was said) and
      // make the tagged people watchers for future changes.
      if (ref.entityType && ref.entityId) {
        let noteId: string | null = null;
        try {
          const { data } = await insertRows('entity_notes', {
            entity_type: ref.entityType,
            entity_id: ref.entityId,
            author_id: activePersonId,
            author_name: activeProfile.name,
            author_role: activeProfile.roleLabel,
            body: text || '',
            mentions: ids,
          }).select('id').single();
          noteId = (data as { id: string } | null)?.id ?? null;
        } catch {
          /* persistence unavailable — notification above still fired */
        }
        const tagged = people.filter((p) => ids.includes(p.id));
        await addWatchers(
          { entityType: ref.entityType, entityId: ref.entityId, entityLabel: ref.entityLabel, route: ref.route },
          tagged.map((p) => ({ id: p.id, name: p.name })),
          'mention',
          activePersonId,
        );
        if (noteId) {
          await createReceipts({ noteId, entityType: ref.entityType, entityId: ref.entityId, mentionIds: ids, delivered });
        }
      }
    },
    [people, activeProfile, activePersonId],
  );
}

/** Resolve which people are tagged in a body of text by matching `@Full Name`. */
export function extractMentionIds(text: string, people: TaggablePerson[]): string[] {
  if (!text.includes('@')) return [];
  const ids: string[] = [];
  // Longest names first so "@Vijay Ji" wins over a hypothetical "@Vijay".
  const sorted = [...people].sort((a, b) => b.name.length - a.name.length);
  for (const p of sorted) {
    if (text.includes('@' + p.name)) ids.push(p.id);
  }
  return ids;
}

export function truncate(s: string, n = 120): string {
  const t = s.trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// ── Watchers ────────────────────────────────────────────────────────────────

export async function getWatchers(entityType: string, entityId: string): Promise<Watcher[]> {
  try {
    const { data, error } = await supabase
      .from('entity_watchers')
      .select('profile_id, profile_name, kind')
      .eq('entity_type', entityType)
      .eq('entity_id', entityId)
      .returns<Watcher[]>();
    if (error) return [];
    return data ?? [];
  } catch {
    return [];
  }
}

export async function addWatchers(
  ref: EntityRef,
  people: { id: string; name: string }[],
  kind: 'cc' | 'mention' | 'author',
  addedBy: string,
): Promise<void> {
  if (!people.length) return;
  const rows = people.map((p) => ({
    entity_type: ref.entityType,
    entity_id: ref.entityId,
    profile_id: p.id,
    profile_name: p.name,
    kind,
    added_by: addedBy,
  }));
  try {
    // Upsert on the (entity_type, entity_id, profile_id) unique key; keep the
    // first 'kind' that was recorded. Cast is local because upsert options
    // aren't expressible through the typed db.ts helpers.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase.from('entity_watchers') as any)
      .upsert(rows, { onConflict: 'entity_type,entity_id,profile_id', ignoreDuplicates: true });
  } catch {
    /* table missing — skip silently */
  }
}

// ── Notes ─────────────────────────────────────────────────────────────────────

/** Lightweight count of notes on an entity (for the Notes button badge). */
export async function getNotesCount(entityType: string, entityId: string): Promise<number> {
  try {
    const { count, error } = await supabase
      .from('entity_notes')
      .select('*', { count: 'exact', head: true })
      .eq('entity_type', entityType)
      .eq('entity_id', entityId);
    if (error) return 0;
    return count ?? 0;
  } catch {
    return 0;
  }
}

export async function getNotes(entityType: string, entityId: string): Promise<EntityNote[]> {
  try {
    const { data, error } = await supabase
      .from('entity_notes')
      .select('*')
      .eq('entity_type', entityType)
      .eq('entity_id', entityId)
      .order('created_at', { ascending: true })
      .returns<EntityNote[]>();
    if (error) return [];
    return data ?? [];
  } catch {
    return [];
  }
}

/**
 * Post a note on an entity: persists it, makes the author + mentioned people
 * watchers, and fires an immediate "X mentioned you" notification to everyone
 * tagged (except the author). Returns the saved note, or null if persistence
 * was unavailable (the mention notification still fires).
 */
export async function postNote(opts: {
  ref: EntityRef;
  actor: Actor;
  body: string;
  mentionIds: string[];
  people: TaggablePerson[];
  addNotification: AddNotification;
}): Promise<EntityNote | null> {
  const { ref, actor, body, mentionIds, people, addNotification } = opts;

  let note: EntityNote | null = null;
  try {
    const { data } = await insertRows('entity_notes', {
      entity_type: ref.entityType,
      entity_id: ref.entityId,
      author_id: actor.id,
      author_name: actor.name,
      author_role: actor.role,
      body,
      mentions: mentionIds,
    }).select().single();
    note = (data as EntityNote) ?? null;
  } catch {
    /* persistence unavailable — the mention notification below still fires */
  }

  // Author + tagged people become watchers for future changes.
  await addWatchers(ref, [{ id: actor.id, name: actor.name }], 'author', actor.id);
  const mentioned = people.filter((p) => mentionIds.includes(p.id));
  if (mentioned.length) {
    await addWatchers(ref, mentioned.map((p) => ({ id: p.id, name: p.name })), 'mention', actor.id);
  }

  // Immediate notification to everyone tagged (except yourself), then a receipt
  // per tagged person so the comment can show delivery / read ticks.
  const targets = mentionIds.filter((id) => id !== actor.id);
  if (targets.length) {
    const delivered = await addNotification({
      target_roles: targets,
      title: `${actor.name} mentioned you`,
      body: `${ref.entityLabel}: “${truncate(body)}”`,
      type: 'info',
      route: ref.route ?? null,
      actor_name: actor.name,
      actor_role: actor.role,
      scope: 'personal', // an @-mention — match strictly by personal id
    });
    if (note?.id) {
      await createReceipts({ noteId: note.id, entityType: ref.entityType, entityId: ref.entityId, mentionIds: targets, delivered });
    }
  }

  return note;
}

/**
 * Notify everyone watching an entity (CC'd, tagged, or author) that something
 * changed in its workflow. Used at status-transition points. The actor is
 * never notified about their own action. `extraIds` lets you fold in people
 * just-tagged in the same action who may not be persisted as watchers yet.
 */
export async function notifyWatchers(opts: {
  ref: EntityRef;
  actor: Actor;
  title: string;
  body: string;
  type?: AppNotification['type'];
  addNotification: AddNotification;
  extraIds?: string[];
}): Promise<void> {
  const watchers = await getWatchers(opts.ref.entityType, opts.ref.entityId);
  const ids = new Set<string>(watchers.map((w) => w.profile_id));
  (opts.extraIds ?? []).forEach((id) => ids.add(id));
  ids.delete(opts.actor.id);
  if (!ids.size) return;
  await opts.addNotification({
    target_roles: [...ids],
    title: opts.title,
    body: opts.body,
    type: opts.type ?? 'info',
    route: opts.ref.route ?? null,
    actor_name: opts.actor.name,
    actor_role: opts.actor.role,
    scope: 'personal', // specific watchers, not a role audience
  });
}

// ── Read / delivery receipts ────────────────────────────────────────────────

/**
 * Create one receipt row per tagged person for a freshly-posted note.
 * `delivered` reflects whether the mention notification was actually written
 * (false → the comment shows a single grey tick, flagging a pipeline failure).
 * Idempotent: re-posting / retries won't duplicate (unique note_id+profile_id).
 */
export async function createReceipts(opts: {
  noteId: string;
  entityType: string;
  entityId: string;
  mentionIds: string[];
  delivered: boolean;
}): Promise<void> {
  if (!opts.noteId || !opts.mentionIds.length) return;
  const stamp = opts.delivered ? new Date().toISOString() : null;
  const rows = opts.mentionIds.map((pid) => ({
    note_id: opts.noteId,
    entity_type: opts.entityType,
    entity_id: opts.entityId,
    profile_id: pid,
    delivered_at: stamp,
    seen_at: null,
  }));
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase.from('entity_note_receipts') as any)
      .upsert(rows, { onConflict: 'note_id,profile_id', ignoreDuplicates: true });
  } catch {
    /* table missing — receipts degrade to "no ticks", thread still works */
  }
}

/** Fetch all receipts for a set of notes (for the open thread). */
export async function getReceipts(noteIds: string[]): Promise<NoteReceipt[]> {
  if (!noteIds.length) return [];
  try {
    const { data, error } = await supabase
      .from('entity_note_receipts')
      .select('note_id, profile_id, delivered_at, seen_at')
      .in('note_id', noteIds)
      .returns<NoteReceipt[]>();
    if (error) return [];
    return data ?? [];
  } catch {
    return [];
  }
}

/**
 * Mark a note seen by a person (first view wins — only stamps when seen_at is
 * still null, so the "seen" time and the green chip don't keep moving).
 */
export async function markNoteSeen(noteId: string, profileId: string): Promise<void> {
  if (!noteId || !profileId) return;
  try {
    await updateRows('entity_note_receipts', { seen_at: new Date().toISOString() })
      .eq('note_id', noteId)
      .eq('profile_id', profileId)
      .is('seen_at', null)
      .then(() => {}, () => {});
  } catch {
    /* table missing — skip silently */
  }
}

/** Profile ids who have seen a note (drives the per-person green @chip). */
export function seenProfileIds(receipts: NoteReceipt[]): Set<string> {
  return new Set(receipts.filter((r) => r.seen_at).map((r) => r.profile_id));
}

/**
 * Aggregate tick state for a comment over the people it tagged. Returns null
 * when nobody was tagged (no recipients → no ticks). A tagged person with no
 * receipt row yet counts as not-delivered, keeping the comment at single-grey.
 */
export function tickState(mentionIds: string[], receipts: NoteReceipt[]): TickState | null {
  if (!mentionIds.length) return null;
  const byId = new Map(receipts.map((r) => [r.profile_id, r]));
  const allDelivered = mentionIds.every((id) => byId.get(id)?.delivered_at);
  const allSeen = mentionIds.every((id) => byId.get(id)?.seen_at);
  if (allSeen) return 'seen';
  if (allDelivered) return 'delivered';
  return 'sent';
}
