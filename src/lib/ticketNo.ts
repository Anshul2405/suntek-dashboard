/**
 * Human ticket / requisition numbers.
 * Prefer a text code already in the DB (`STK0001` from next_ticket_no).
 * Never invent MT-0042 when a plant code exists.
 */
import { useEffect, useState } from 'react';

type TicketLike = { id: string; ticket_no?: number | string | null; job_no?: string | null };

const cache = new Map<string, string>();

export function ticketNoLabel(t: TicketLike): string {
  const raw = t.ticket_no;
  if (typeof raw === 'string' && raw.trim()) {
    cache.set(t.id, raw.trim());
    return raw.trim();
  }
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    const label = `STK${String(raw).padStart(4, '0')}`;
    cache.set(t.id, label);
    return label;
  }
  if (t.job_no && String(t.job_no).trim()) {
    cache.set(t.id, String(t.job_no).trim());
    return String(t.job_no).trim();
  }
  return cache.get(t.id) ?? (t.id ? t.id.slice(0, 8) : '');
}

export function ticketNoForId(id: string | null | undefined): string {
  if (!id) return '';
  return cache.get(id) ?? id.slice(0, 8);
}

export function primeTicketNos(rows: TicketLike[]): void {
  for (const r of rows) ticketNoLabel(r);
}

export function ticketSearchTerms(t: TicketLike): string[] {
  const label = ticketNoLabel(t);
  const out = [label, label.replace(/-/g, ''), t.id, t.id.slice(0, 8)];
  const digits = label.match(/(\d+)$/)?.[1];
  if (digits) out.push(digits, String(Number(digits)));
  return out.map(s => s.toLowerCase());
}

export function matchesTicketNo(t: TicketLike, query: string): boolean {
  const q = query.trim().toLowerCase().replace(/\s+/g, '');
  if (!q) return false;
  return ticketSearchTerms(t).some(term => term.includes(q));
}

export async function fetchTicketNos(ids: string[]): Promise<void> {
  const missing = [...new Set(ids.filter(id => id && !cache.has(id)))];
  for (let i = 0; i < missing.length; i += 150) {
    const chunk = missing.slice(i, i + 150);
    try {
      const { supabase } = await import('./supabase');
      const { data, error } = await supabase.from('maintenance_tickets')
        .select('id, ticket_no').in('id', chunk);
      if (error) return;
      primeTicketNos((data || []) as TicketLike[]);
    } catch { return; }
  }
}

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

export function reqNoLabel(r: { id: string; req_no?: number | string | null }): string {
  const raw = r.req_no;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (Number.isFinite(n) && n > 0) return `SR-${String(n).padStart(4, '0')}`;
  return r.id.slice(0, 8);
}
