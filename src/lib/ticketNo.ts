/**
 * One human ticket number everywhere: MT-0042.
 *
 * `maintenance_tickets.ticket_no` is a sequential integer (migration 0040,
 * back-filled in created_at order, then a DB sequence). Every screen that shows
 * or searches a ticket goes through `ticketNoLabel` — lists, the ticket panel,
 * Activity Log, Store Req, Stock Register, notifications, search.
 *
 * Screens that only hold a ticket *id* (Stock Register links, Store Req rows,
 * bell items) resolve it through a small shared cache: `primeTicketNos` from
 * any list that already loaded tickets, `useTicketNos(ids)` to fetch the rest.
 *
 * A TEXT code already allocated by the database (e.g. "STK0001" from another
 * branch's next_ticket_no) is shown verbatim — this module never renumbers a
 * ticket. Only a bare integer is formatted as MT-0042.
 *
 * Before any ticket-number migration is applied there is no number to show; the
 * fallback is a stable 6-character code from the id so the column is never
 * blank — it changes to the real number the moment the migration lands.
 */
import { useEffect, useState } from 'react';
import { supabase } from './supabase';

export const TICKET_PREFIX = 'MT';

type TicketLike = { id: string; ticket_no?: number | string | null };

export function formatTicketNo(n: number): string {
  return `${TICKET_PREFIX}-${String(n).padStart(4, '0')}`;
}

/** Fallback code before migration 0040: stable, but not sequential. */
export function fallbackTicketCode(id: string): string {
  return `${TICKET_PREFIX}-${id.replace(/-/g, '').slice(0, 6).toUpperCase()}`;
}

function parseNo(v: number | string | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/^\D+/, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

const cache = new Map<string, string>();

/** A DB-allocated text code ("STK0001", "MT-0042") — shown as is. */
function textCode(v: number | string | null | undefined): string | null {
  return typeof v === 'string' && /[A-Za-z]/.test(v) ? v.trim() : null;
}

/** Display label for a ticket row. Also primes the id → label cache. */
export function ticketNoLabel(t: TicketLike): string {
  const code = textCode(t.ticket_no);
  if (code) { cache.set(t.id, code); return code; }
  const n = parseNo(t.ticket_no);
  if (n != null) {
    const label = formatTicketNo(n);
    cache.set(t.id, label);
    return label;
  }
  return cache.get(t.id) ?? fallbackTicketCode(t.id);
}

/** Label from an id alone (cache, else fallback). */
export function ticketNoForId(id: string | null | undefined): string {
  if (!id) return '';
  return cache.get(id) ?? fallbackTicketCode(id);
}

export function primeTicketNos(rows: TicketLike[]): void {
  for (const r of rows) ticketNoLabel(r);
}

/**
 * Strings a search box should match for this ticket: "MT-0042", "0042", "42",
 * "mt42" and the raw id (old links / exports still carry it).
 */
export function ticketSearchTerms(t: TicketLike): string[] {
  const label = ticketNoLabel(t);
  const out = [label, label.replace('-', ''), t.id, t.id.slice(0, 8)];
  const digits = label.match(/(\d+)$/)?.[1];
  if (digits) out.push(digits, String(Number(digits)));
  const n = parseNo(t.ticket_no);
  if (n != null) out.push(String(n), String(n).padStart(4, '0'), `${TICKET_PREFIX}${n}`, `${TICKET_PREFIX}-${n}`);
  return out.map(s => s.toLowerCase());
}

/** Does a search query hit this ticket's number? (case/space-insensitive) */
export function matchesTicketNo(t: TicketLike, query: string): boolean {
  const q = query.trim().toLowerCase().replace(/\s+/g, '');
  if (!q) return false;
  return ticketSearchTerms(t).some(term => term.includes(q));
}

/** Fetch numbers for ids not yet cached. Never throws. */
export async function fetchTicketNos(ids: string[]): Promise<void> {
  const missing = [...new Set(ids.filter(id => id && !cache.has(id)))];
  for (let i = 0; i < missing.length; i += 150) {
    const chunk = missing.slice(i, i + 150);
    try {
      const { data, error } = await supabase.from('maintenance_tickets')
        .select('id, ticket_no').in('id', chunk)
        .returns<{ id: string; ticket_no: number | null }[]>();
      if (error) return; // column not there yet → fallback codes
      primeTicketNos(data || []);
    } catch { return; }
  }
}

/** Resolve ticket numbers for a set of ids; re-renders once they arrive. */
export function useTicketNos(ids: (string | null | undefined)[]): (id: string | null | undefined) => string {
  const key = [...new Set(ids.filter(Boolean) as string[])].sort().join(',');
  const [, bump] = useState(0);
  useEffect(() => {
    if (!key) return;
    let alive = true;
    fetchTicketNos(key.split(',')).then(() => { if (alive) bump(n => n + 1); });
    return () => { alive = false; };
  }, [key]);
  return ticketNoForId;
}

/** Requisition number for store_requisitions: SR-0007 (req_no, migration 0040). */
export function reqNoLabel(r: { id: string; req_no?: number | string | null }): string {
  const n = parseNo(r.req_no);
  return n != null ? `SR-${String(n).padStart(4, '0')}` : `SR-${r.id.replace(/-/g, '').slice(0, 6).toUpperCase()}`;
}

/** Incident number: INC-0003 (incident_reports.incident_no). */
export function incidentNoLabel(r: { id: string; incident_no?: number | string | null }): string {
  const n = parseNo(r.incident_no);
  return n != null ? `INC-${String(n).padStart(4, '0')}` : `INC-${r.id.replace(/-/g, '').slice(0, 6).toUpperCase()}`;
}
