import React, { useEffect, useRef, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SlidePanel } from '../SlidePanel';
import { MentionTextarea } from './MentionTextarea';
import { MentionText } from './MentionText';
import { CcSelect } from './CcSelect';
import { ReadReceipt } from './ReadReceipt';
import { supabase } from '../../lib/supabase';
import { useRoleContext } from '../../contexts/RoleContext';
import { useNotifications } from '../../contexts/NotificationsContext';
import { useToast } from '../ui/toast';
import { formatDateTime } from '../../lib/utils/formatting';
import {
  useDirectory, getNotes, getNotesCount, getWatchers, getReceipts, markNoteSeen,
  postNote, addWatchers, truncate, seenProfileIds, tickState,
  type EntityNote, type NoteReceipt,
} from '../../lib/mentions';

/**
 * A self-contained "Notes" button for any record — especially button-only
 * workflows that have no free-text field. Opens a thread where users can write
 * a note, @-tag people, and CC watchers. Tagged people are notified instantly;
 * CC'd people are persisted as watchers so future workflow changes notify them
 * too (via notifyWatchers at the status-transition points).
 *
 * Each note carries WhatsApp-style receipts: a tick by the author (sent →
 * delivered → seen, aggregated over everyone tagged) and per-person green
 * @chips once that person scrolls the comment into view.
 */
interface Props {
  entityType: string;
  entityId: string;
  entityLabel: string;
  route?: string | null;
  /** Override the trigger's class (defaults to the global `chip` style). */
  triggerClassName?: string;
  /** Render just an icon (for dense rows). */
  iconOnly?: boolean;
  /** Trigger + panel wording. A closed maintenance ticket says "Feedback". */
  variant?: 'notes' | 'feedback';
  /** Called after a note is posted (e.g. to show the Notes badge at once). */
  onPosted?: () => void;
}

type ReceiptMap = Record<string, NoteReceipt[]>;

function groupReceipts(list: NoteReceipt[]): ReceiptMap {
  const out: ReceiptMap = {};
  for (const r of list) (out[r.note_id] ??= []).push(r);
  return out;
}

/** Merge a single realtime/optimistic receipt row into the grouped map. */
function mergeReceipt(map: ReceiptMap, r: NoteReceipt): ReceiptMap {
  const existing = map[r.note_id] ?? [];
  const next = existing.filter((x) => x.profile_id !== r.profile_id);
  next.push(r);
  return { ...map, [r.note_id]: next };
}

export function NotesButton({ entityType, entityId, entityLabel, route, triggerClassName = 'chip', iconOnly, variant = 'notes', onPosted }: Props) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState<EntityNote[]>([]);
  const [receipts, setReceipts] = useState<ReceiptMap>({});
  const [loading, setLoading] = useState(false);
  const [body, setBody] = useState('');
  const [mentionIds, setMentionIds] = useState<string[]>([]);
  const [cc, setCc] = useState<string[]>([]);
  const [posting, setPosting] = useState(false);
  const [count, setCount] = useState(0);

  const { t } = useTranslation();
  const { activeProfile, activePersonId } = useRoleContext();
  const { addNotification } = useNotifications();
  const people = useDirectory();
  const toast = useToast();

  const ref = { entityType, entityId, entityLabel, route };
  // Author/self keys on the PERSONAL id (not the shared role id) so two
  // same-role people stay distinct for receipts, seen-state and self-exclusion.
  const actor = { id: activePersonId, name: activeProfile.name, role: activeProfile.roleLabel };

  async function load() {
    setLoading(true);
    const [n, w] = await Promise.all([getNotes(entityType, entityId), getWatchers(entityType, entityId)]);
    setNotes(n);
    setCount(n.length);
    setCc(w.filter((x) => x.kind === 'cc').map((x) => x.profile_id));
    setReceipts(groupReceipts(await getReceipts(n.map((x) => x.id))));
    setLoading(false);
  }

  // Fetch the thread (notes + watchers + receipts) when the panel opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    Promise.all([getNotes(entityType, entityId), getWatchers(entityType, entityId)]).then(async ([n, w]) => {
      if (cancelled) return;
      setNotes(n);
      setCount(n.length);
      setCc(w.filter((x) => x.kind === 'cc').map((x) => x.profile_id));
      const r = await getReceipts(n.map((x) => x.id));
      if (cancelled) return;
      setReceipts(groupReceipts(r));
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [open, entityType, entityId]);

  // Show how many notes exist on mount, so the button hints there's a trace.
  useEffect(() => {
    let cancelled = false;
    getNotesCount(entityType, entityId).then((c) => { if (!cancelled) setCount(c); });
    return () => { cancelled = true; };
  }, [entityType, entityId]);

  // Real-time: while the thread is open, append notes others post live.
  useEffect(() => {
    if (!open) return;
    const channel = supabase
      .channel(`entity_notes:${entityType}:${entityId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'entity_notes' }, (payload) => {
        const n = payload.new as EntityNote;
        if (n.entity_type !== entityType || n.entity_id !== entityId) return;
        setNotes((prev) => {
          if (prev.some((x) => x.id === n.id)) return prev;
          const next = [...prev, n];
          setCount(next.length);
          return next;
        });
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [open, entityType, entityId]);

  // Real-time: receipts (delivery + seen) for this entity → live ticks & chips.
  useEffect(() => {
    if (!open) return;
    const channel = supabase
      .channel(`entity_note_receipts:${entityType}:${entityId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'entity_note_receipts' }, (payload) => {
        const r = payload.new as (NoteReceipt & { entity_type?: string; entity_id?: string });
        if (!r?.note_id || r.entity_type !== entityType || r.entity_id !== entityId) return;
        setReceipts((prev) => mergeReceipt(prev, {
          note_id: r.note_id, profile_id: r.profile_id, delivered_at: r.delivered_at, seen_at: r.seen_at,
        }));
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [open, entityType, entityId]);

  // A tagged note scrolled into the viewer's view → mark it seen (once).
  // Keyed on the PERSONAL id so only this person's @chip greens — not everyone
  // who shares their role.
  function handleSeen(noteId: string) {
    markNoteSeen(noteId, activePersonId);
    setReceipts((prev) => {
      const row = (prev[noteId] ?? []).find((r) => r.profile_id === activePersonId);
      return mergeReceipt(prev, {
        note_id: noteId,
        profile_id: activePersonId,
        delivered_at: row?.delivered_at ?? new Date().toISOString(),
        seen_at: new Date().toISOString(),
      });
    });
  }

  async function post() {
    if (!body.trim()) return;
    setPosting(true);
    try {
      const text = body.trim();
      await postNote({ ref, actor, body: text, mentionIds, people, addNotification });
      onPosted?.();

      // Persist CC watchers and notify the ones not already pinged as mentions.
      const ccPeople = people.filter((p) => cc.includes(p.id));
      if (ccPeople.length) {
        await addWatchers(ref, ccPeople.map((p) => ({ id: p.id, name: p.name })), 'cc', actor.id);
        const ccTargets = cc.filter((id) => id !== actor.id && !mentionIds.includes(id));
        if (ccTargets.length) {
          await addNotification({
            target_roles: ccTargets,
            title: t('common.ccdYou', { defaultValue: '{{name}} CC’d you', name: actor.name }),
            body: `${entityLabel}: “${truncate(text)}”`,
            type: 'info',
            route: route ?? null,
            actor_name: actor.name,
            actor_role: actor.role,
            scope: 'personal', // a CC to specific people
          });
        }
      }

      const notified =
        mentionIds.filter((id) => id !== actor.id).length +
        cc.filter((id) => id !== actor.id && !mentionIds.includes(id)).length;
      toast.success(notified
        ? t('common.notePostedNotified', { defaultValue: 'Note posted · {{count}} notified', count: notified })
        : t('common.notePosted', 'Note posted'));
      setBody('');
      setMentionIds([]);
      await load();
    } catch {
      toast.error(t('common.notePostFailed', 'Could not post note'));
    } finally {
      setPosting(false);
    }
  }

  return (
    <>
      <button type="button" onClick={() => { setLoading(true); setOpen(true); }} className={triggerClassName} style={iconOnly ? undefined : { display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <MessageSquare size={13} />
        {!iconOnly && <span>{variant === 'feedback' ? t('common.feedback', 'Feedback') : t('common.notes', 'Notes')}{(notes.length || count) ? ` · ${notes.length || count}` : ''}</span>}
      </button>

      <SlidePanel open={open} onClose={() => setOpen(false)} title={variant === 'feedback' ? t('common.feedback', 'Feedback') : t('common.notesAndTags', 'Notes & tags')} subtitle={entityLabel}>
        {/* Existing thread */}
        {loading ? (
          <div style={{ fontSize: 13, color: '#94A3B8', padding: '8px 0' }}>{t('common.loading', 'Loading…')}</div>
        ) : notes.length === 0 ? (
          <div style={{ fontSize: 13, color: '#94A3B8', padding: '4px 0 12px' }}>
            {t('common.notesEmptyPre', 'No notes yet. Add one below — type')} <strong>@</strong> {t('common.notesEmptyPost', 'to tag a teammate.')}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
            {notes.map((n) => (
              <NoteRow key={n.id} note={n} receipts={receipts[n.id] ?? []} viewerId={activePersonId} onSeen={handleSeen} />
            ))}
          </div>
        )}

        {/* Composer */}
        <div style={{ marginBottom: 12 }}>
          <MentionTextarea
            value={body}
            onChange={setBody}
            onMentionsChange={setMentionIds}
            placeholder={t('common.notesPlaceholder', 'Write a note… type @ to tag someone for a heads-up')}
            excludeIds={[actor.id]}
          />
        </div>
        <div style={{ marginBottom: 16 }}>
          <CcSelect value={cc} onChange={setCc} excludeIds={[actor.id]} />
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <button
            type="button"
            onClick={() => setOpen(false)}
            style={{ flex: 1, padding: '11px 0', borderRadius: 24, border: '1px solid #E2E8F0', background: '#F8FAFC', fontSize: 13, fontWeight: 600, color: '#475569', cursor: 'pointer', fontFamily: 'inherit' }}
          >
            {t('common.close', 'Close')}
          </button>
          <button
            type="button"
            onClick={post}
            disabled={!body.trim() || posting}
            style={{ flex: 2, padding: '11px 0', borderRadius: 24, border: 'none', background: !body.trim() || posting ? '#CBD5E1' : '#F47651', fontSize: 13, fontWeight: 700, color: '#fff', cursor: !body.trim() || posting ? 'not-allowed' : 'pointer', fontFamily: 'inherit' }}
          >
            {posting ? t('common.posting', 'Posting…') : t('common.postNote', 'Post note')}
          </button>
        </div>
      </SlidePanel>
    </>
  );
}

/**
 * One note in the thread. Owns its own IntersectionObserver: when the viewer is
 * tagged and hasn't seen this note yet, scrolling it into view fires onSeen.
 */
function NoteRow({ note, receipts, viewerId, onSeen }: {
  note: EntityNote;
  receipts: NoteReceipt[];
  viewerId: string;
  onSeen: (noteId: string) => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const mentions = note.mentions ?? [];
  const amTagged = mentions.includes(viewerId);
  const alreadySeen = !!receipts.find((r) => r.profile_id === viewerId)?.seen_at;

  useEffect(() => {
    if (!amTagged || alreadySeen) return;
    const el = rowRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      // No observer support → fall back to marking seen on render.
      onSeen(note.id);
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        onSeen(note.id);
      }
    }, { threshold: 0.6 });
    io.observe(el);
    return () => io.disconnect();
    // onSeen is stable enough for this lifecycle; re-run only when seen-state flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amTagged, alreadySeen, note.id]);

  const seenIds = seenProfileIds(receipts);
  const tick = mentions.length ? tickState(mentions, receipts) : null;

  return (
    <div ref={rowRef} style={{ border: '1px solid #F1F5F9', borderRadius: 12, padding: '10px 12px', background: '#FCFCFD' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#0F172A' }}>{note.author_name}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ fontSize: 10, color: '#94A3B8' }}>{fmtTime(note.created_at)}</span>
          {tick && <ReadReceipt state={tick} />}
        </span>
      </div>
      <MentionText text={note.body} seenIds={seenIds} style={{ fontSize: 13, color: '#334155', lineHeight: 1.5 }} />
    </div>
  );
}

function fmtTime(iso: string): string {
  try {
    return formatDateTime(iso);
  } catch {
    return '';
  }
}
