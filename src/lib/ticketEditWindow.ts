/**
 * The one edit window for every screen (management, 29 Oct 2026).
 *
 * Default 1 hour. Admin changes it in Access & backup ("Edit window (hours)"),
 * saved on the ops_settings controls blob with the Edit / Delete ticks. No
 * per-screen hours.
 *
 * Who may edit:
 * - Inside the window, before the entry is approved or closed: the person who
 *   created it, with the module's Edit tick.
 * - Any time (after the window, or once approved / closed): Admin, Unit Head and
 *   management (Vijay ji). Unit Head and management still need the module's
 *   Edit tick; Admin does not.
 * - Until the saved settings have loaded: Admin only (fail-closed).
 * Every edit writes an audit note (field: old → new) and notifies the creator —
 * that is the caller's job.
 */
import { canEditModule, type ModuleKey, type OpsSettings } from './opsControls';
import { isAdminProfile, isManagementProfile, type MockProfile } from './profiles';
import { cleanEditWindowHours, DEFAULT_EDIT_WINDOW_HOURS } from './editWindowHours';

export { cleanEditWindowHours, DEFAULT_EDIT_WINDOW_HOURS, MAX_EDIT_WINDOW_HOURS } from './editWindowHours';

export function editWindowMs(hours: number = DEFAULT_EDIT_WINDOW_HOURS): number {
  return cleanEditWindowHours(hours) * 60 * 60 * 1000;
}

/** @deprecated the window is a setting now — use editWindowMs(settings.editWindowHours). */
export const TICKET_EDIT_WINDOW_MS = editWindowMs(DEFAULT_EDIT_WINDOW_HOURS);

export function ticketEditDeadline(createdAt: string | null | undefined, windowMs: number = TICKET_EDIT_WINDOW_MS): number | null {
  if (!createdAt) return null;
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return null;
  return t + windowMs;
}

export function canEditRaisedTicket(createdAt: string | null | undefined, now = Date.now(), windowMs: number = TICKET_EDIT_WINDOW_MS): boolean {
  const until = ticketEditDeadline(createdAt, windowMs);
  return until != null && now < until;
}

export function ticketEditMinutesLeft(createdAt: string | null | undefined, now = Date.now(), windowMs: number = TICKET_EDIT_WINDOW_MS): number {
  const until = ticketEditDeadline(createdAt, windowMs);
  if (until == null) return 0;
  return Math.max(0, Math.ceil((until - now) / 60_000));
}

/** "1 hour", "2 hours", "30 min", "1.5 hours" — for copy that must follow the saved value. */
export function editWindowText(hours: number): { n: number; unit: 'hour' | 'hours' | 'min' } {
  const h = cleanEditWindowHours(hours);
  if (h < 1) return { n: Math.round(h * 60), unit: 'min' };
  return { n: h, unit: h === 1 ? 'hour' : 'hours' };
}

/** Ticket statuses past the Unit Head's approval (or closed): the creator's window no longer applies. */
const TICKET_APPROVED = new Set([
  'pending_vijay', 'pending_buyer', 'pending_purchase', 'pending_purchase_manager',
  'pending_handover', 'pending_defective_return', 'closed',
]);

export function ticketIsApprovedOrClosed(status: string | null | undefined): boolean {
  return TICKET_APPROVED.has(status || '');
}

/** Admin, Unit Head or management (Vijay ji). */
export function isSeniorEditor(profile: MockProfile): boolean {
  return isManagementProfile(profile);
}

export type EditAccess = 'admin' | 'senior' | 'creator' | null;

/**
 * Why this person may edit this entry right now, or null.
 * 'senior' and 'admin' edits after the window must be audited + told to the creator.
 */
export function editAccess(opts: {
  profile: MockProfile;
  settings: OpsSettings;
  module: ModuleKey;
  createdAt: string | null | undefined;
  /** True once approved / closed. */
  locked: boolean;
  /** The logged-in person created this entry. */
  isCreator: boolean;
  /** Person id (db_<uuid>) for their own Edit override in User Management. */
  personId?: string | null;
  now?: number;
}): EditAccess {
  const { profile, settings, module } = opts;
  if (isAdminProfile(profile)) return 'admin';
  if (!settings.loaded) return null;
  if (!canEditModule(settings, profile, module, opts.personId)) return null;
  if (isSeniorEditor(profile)) return 'senior';
  const inWindow = canEditRaisedTicket(opts.createdAt, opts.now ?? Date.now(), editWindowMs(settings.editWindowHours));
  return opts.isCreator && inWindow && !opts.locked ? 'creator' : null;
}
