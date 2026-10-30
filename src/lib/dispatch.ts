/**
 * Dispatch = the plant-to-plant consignment log (dispatch_logs).
 *
 * Anything sent between places — a file, a computer, a device, spare store
 * stock — is one row. The sender writes it and it is IN TRANSIT until the
 * receiving place fills the receive date. There is no status column: an empty
 * receive_date is "in transit".
 *
 * A part bought for the store with no maintenance ticket can ride in the same
 * vehicle. It is a dispatch row that names a supplier; on arrival the receiving
 * plant books it into the Stock register through Add purchase. Ticket parts are
 * never written here — they are followed on their ticket.
 */
import type { Database } from './database.types';
import { isValidIfsc } from './validate/ifsc';
import { vehicleNoForSave } from './validate/vehicleNo';

export type DispatchRow = Database['public']['Tables']['dispatch_logs']['Row'];

/** The head office is a sending / receiving place but not a plant. */
export const HEAD_OFFICE = 'Delhi office';

export function isInTransit(row: Pick<DispatchRow, 'receive_date'>): boolean {
  return !row.receive_date;
}

/** A store part bought from a supplier (goes to the Stock register on arrival). */
export function isStorePart(row: Pick<DispatchRow, 'supplier'>): boolean {
  return !!row.supplier?.trim();
}

export function normVehicle(v: string | null | undefined): string {
  return (v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export interface VehicleGroup {
  key: string;
  vehicle: string;
  date: string;
  rows: DispatchRow[];
}

/**
 * In-transit rows grouped by vehicle number + dispatch date, so dispatch items
 * and store parts in the same truck show together. Rows with no vehicle stay
 * one group each.
 */
export function groupInTransit(rows: DispatchRow[]): VehicleGroup[] {
  const groups = new Map<string, VehicleGroup>();
  for (const row of rows) {
    if (!isInTransit(row)) continue;
    const vehicle = normVehicle(row.vehicle_no);
    const key = vehicle ? `${vehicle}|${row.date}` : `row:${row.id}`;
    const g = groups.get(key) ?? { key, vehicle: row.vehicle_no?.trim() || '', date: row.date, rows: [] };
    g.rows.push(row);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.vehicle.localeCompare(b.vehicle));
}

/** PostgREST `or` filter: rows sent from, or going to, one of these places. */
export function placesOrFilter(places: string[]): string {
  const list = places.map(p => `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',');
  return `from_location.in.(${list}),destination.in.(${list})`;
}

/** The receiving place (or admin) fills the receive date. */
export function canReceive(row: Pick<DispatchRow, 'destination' | 'receive_date'>, myPlaces: Set<string>, admin: boolean): boolean {
  if (!isInTransit(row)) return false;
  return admin || (!!row.destination && myPlaces.has(row.destination));
}

/** Purchaser bill URL kept in remarks until a dedicated column exists. */
export function billUrlFromRemarks(remarks: string | null | undefined): string | null {
  const m = /(https?:\/\/[^\s]+)/i.exec(remarks || '');
  return m?.[1] ?? null;
}

export function withBillRemark(remarks: string, url: string): string {
  const base = remarks.trim();
  return base ? `${base} · bill ${url}` : `bill ${url}`;
}

// ── New dispatch form (pure, so the rules are tested without a browser) ──────

/** The fields of New dispatch that matter for order and saving. */
export interface DispatchFormInput {
  kind: 'item' | 'part';
  company: string;
  payee: string;
  manual: boolean;
  exceptionReason: string;
  ifsc: string;
  destination: string;
  date: string;
  item: string;
  sender: string;
  from: string;
  vehicle_no: string;
  supplier: string;
}

/**
 * The order the form asks for things. Busy company + payee only once migration
 * 0042 is applied (payeeLive); before that the form is today's.
 */
export function dispatchFieldOrder(payeeLive: boolean): string[] {
  return payeeLive
    ? ['company', 'from', 'destination', 'payee', 'date', 'item', 'vehicle', 'sender', 'receiver', 'remarks']
    : ['from', 'destination', 'date', 'item', 'vehicle', 'sender', 'receiver', 'remarks'];
}

/** Why New dispatch cannot be saved yet ([] = it can). Future dates are fine. */
export function dispatchSaveProblems(f: DispatchFormInput, opts: { payeeLive: boolean; hasBill: boolean }): string[] {
  const out: string[] = [];
  if (opts.payeeLive) {
    if (!f.company) out.push('company');
    if (!f.payee.trim()) out.push('payee');
    if (f.manual && !f.exceptionReason.trim()) out.push('exceptionReason');
    if (f.ifsc.trim() && !isValidIfsc(f.ifsc)) out.push('ifsc');
  }
  if (vehicleNoForSave(f.vehicle_no) === null) out.push('vehicle');
  if (!f.from) out.push('from');
  if (!f.destination || f.destination === f.from) out.push('destination');
  if (!f.date) out.push('date');
  if (!f.item.trim()) out.push('item');
  if (!f.sender.trim()) out.push('sender');
  if (f.kind === 'part' && (!f.supplier.trim() || !opts.hasBill)) out.push('supplier');
  return out;
}
