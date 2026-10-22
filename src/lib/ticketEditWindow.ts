/**
 * Who may edit an already-raised maintenance ticket, and what.
 *
 *  • The person who raised it — for ONE HOUR after created_at. Enough to fix a
 *    typo or a wrong photo; after that the ticket is a record other people have
 *    acted on. The raiser can never change status here: status only moves
 *    through the workflow buttons.
 *  • An admin holding `backdate_tickets` (admins hold it implicitly) — any time,
 *    any status including closed, and may set a back date. Every admin change is
 *    written to the ticket's audit trail as who / when / old → new.
 *
 * Pure functions so the UI gate and the save-time re-check share one rule.
 */
import { istDayKey } from './utils/formatting';

export const RAISER_EDIT_WINDOW_MS = 60 * 60 * 1000;

export interface EditableTicket {
  created_at: string | null;
  raised_by: string | null;
  status: string;
}

export interface EditActor {
  name: string | null | undefined;
  isAdmin: boolean;
  /** Holds the admin edit / backdate capability. */
  canBackdate: boolean;
}

export type EditMode = 'admin' | 'raiser' | null;

/** Milliseconds left in the raiser's window (0 when expired / unknown). */
export function raiserWindowRemainingMs(ticket: Pick<EditableTicket, 'created_at'>, now: number = Date.now()): number {
  if (!ticket.created_at) return 0;
  const created = new Date(ticket.created_at).getTime();
  if (!Number.isFinite(created)) return 0;
  return Math.max(0, created + RAISER_EDIT_WINDOW_MS - now);
}

function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = (a || '').trim().toLowerCase();
  return !!x && x === (b || '').trim().toLowerCase();
}

/**
 * The edit mode available to `actor` on `ticket` right now.
 * Admin capability wins; otherwise the raiser inside the hour; otherwise none.
 */
export function ticketEditMode(ticket: EditableTicket, actor: EditActor, now: number = Date.now()): EditMode {
  if (actor.isAdmin && actor.canBackdate) return 'admin';
  if (ticket.status === 'closed') return null;
  if (sameName(ticket.raised_by, actor.name) && raiserWindowRemainingMs(ticket, now) > 0) return 'raiser';
  return null;
}

export interface TicketEditDraft {
  equipment: string;
  description: string;
  plant_id: string | null;
  /** 'YYYY-MM-DD' back date — admin only. Empty = unchanged. */
  backdate?: string;
}

export interface TicketEditChange { field: string; from: string; to: string }

/** Field-level diff for the audit trail (status is never part of an edit). */
export function diffTicketEdit(
  before: { equipment: string | null; description: string | null; plant_id: string | null; created_at: string | null },
  draft: TicketEditDraft,
  plantName: (id: string | null) => string = id => id ?? '—',
): TicketEditChange[] {
  const out: TicketEditChange[] = [];
  const norm = (v: string | null | undefined) => (v ?? '').trim();
  if (norm(before.equipment) !== norm(draft.equipment)) out.push({ field: 'equipment', from: norm(before.equipment) || '—', to: norm(draft.equipment) || '—' });
  if (norm(before.description) !== norm(draft.description)) out.push({ field: 'description', from: norm(before.description) || '—', to: norm(draft.description) || '—' });
  if ((before.plant_id ?? null) !== (draft.plant_id ?? null)) out.push({ field: 'plant', from: plantName(before.plant_id), to: plantName(draft.plant_id) });
  if (draft.backdate && istDayKey(before.created_at) !== draft.backdate) {
    out.push({ field: 'raised on', from: istDayKey(before.created_at) || '—', to: draft.backdate });
  }
  return out;
}

/** created_at for a back date: keep the original IST time-of-day on the new day. */
export function backdatedCreatedAt(originalIso: string | null, day: string): string {
  const orig = originalIso ? new Date(originalIso) : null;
  const istMs = orig && Number.isFinite(orig.getTime()) ? orig.getTime() + 330 * 60_000 : null;
  const time = istMs != null ? new Date(istMs).toISOString().slice(11, 19) : '09:00:00';
  return new Date(`${day}T${time}+05:30`).toISOString();
}

/** One audit line: "✎ Edited by Asha · equipment: Pump A → Pump B; plant: X → Y". */
export function auditLineForEdit(actorName: string, mode: Exclude<EditMode, null>, changes: TicketEditChange[]): string {
  const who = mode === 'admin' ? `✎ Admin edit by ${actorName}` : `✎ Edited by ${actorName} (within 1 h of raising)`;
  const what = changes.map(c => `${c.field}: ${c.from} → ${c.to}`).join('; ');
  return `${who} · ${what}`;
}
