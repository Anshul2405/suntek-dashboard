/**
 * Sequential job numbers (meeting 25 Sep): STK-001, STK-002 / FAR-001, FAR-002.
 * Placeholder marks like "(xxx)" from PM workbooks are not codes.
 */

import { supabase } from './supabase';
import { callRpc } from './db';

const PLACEHOLDER = /^(x{2,}|n\/?a|nil|none|tbd|todo|-|—|–)$/i;
const SEQ = /^(FAR|STK)-(\d+)$/i;

export function isPlaceholderMark(mark: string | null | undefined): boolean {
  return !((mark ?? '').trim()) || PLACEHOLDER.test(mark!.trim());
}

export function stripPlaceholderParen(label: string): string {
  return (label || '')
    .replace(/\s*\((x{2,}|n\/?a|nil|none|tbd|todo|-|—|–)\)\s*/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([—–-])/g, ' $1')
    .trim();
}

/** Swap a workbook placeholder like (XXX) for the FAR identification mark. */
export function labelWithRealMark(label: string, mark: string | null | undefined): string {
  const real = (mark ?? '').trim();
  if (!real || isPlaceholderMark(real)) return stripPlaceholderParen(label);
  const swapped = (label || '').replace(/\((x{2,}|n\/?a|nil|none|tbd|todo|-|—|–)\)/gi, `(${real})`);
  if (swapped !== (label || '')) return swapped.replace(/\s{2,}/g, ' ').trim();
  const clean = stripPlaceholderParen(label);
  if (clean.toLowerCase().includes(`(${real.toLowerCase()})`)) return clean;
  return clean ? `${clean} (${real})` : real;
}

export function formatJobNo(prefix: 'FAR' | 'STK', n: number): string {
  return `${prefix}-${String(n).padStart(3, '0')}`;
}

export function parseJobSeq(jobNo: string | null | undefined): { prefix: 'FAR' | 'STK'; n: number } | null {
  const m = (jobNo || '').trim().match(SEQ);
  if (!m) return null;
  return { prefix: m[1].toUpperCase() as 'FAR' | 'STK', n: parseInt(m[2], 10) };
}

export function nextJobNo(existing: (string | null | undefined)[], prefix: 'FAR' | 'STK'): string {
  let max = 0;
  for (const j of existing) {
    const parsed = parseJobSeq(j);
    if (parsed && parsed.prefix === prefix && parsed.n > max) max = parsed.n;
  }
  return formatJobNo(prefix, max + 1);
}

/** Next globally unique FAR/STK code. Uses next_job_no (0021) so plant-scoped RLS cannot collide. */
export async function allocateNextJobNos(prefix: 'FAR' | 'STK', count: number): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const { data, error } = await callRpc<string>('next_job_no', { p_prefix: prefix });
    if (error || data == null || data === '') return out;
    out.push(String(data));
  }
  return out;
}

type Row = { id: string; created_at?: string | null; job_no?: string | null };

/**
 * Stable sequential numbers: honour persisted job_no, then fill the rest in
 * created_at order so every row gets STK-001 / FAR-001 style codes.
 */
export function assignSequentialJobNos(rows: Row[], prefix: 'FAR' | 'STK'): Map<string, string> {
  const sorted = [...rows].sort((a, b) => {
    const ca = a.created_at || '';
    const cb = b.created_at || '';
    if (ca !== cb) return ca.localeCompare(cb);
    return a.id.localeCompare(b.id);
  });
  const map = new Map<string, string>();
  let next = 1;
  for (const r of sorted) {
    const parsed = parseJobSeq(r.job_no);
    if (parsed && parsed.prefix === prefix) {
      map.set(r.id, formatJobNo(prefix, parsed.n));
      if (parsed.n >= next) next = parsed.n + 1;
    }
  }
  for (const r of sorted) {
    if (map.has(r.id)) continue;
    map.set(r.id, formatJobNo(prefix, next));
    next += 1;
  }
  return map;
}

/** Write missing sequential job_no values. Safe if the column / RPC is not live yet. */
export async function persistMissingJobNos(
  table: 'fixed_assets' | 'store_items',
  rows: Row[],
  prefix: 'FAR' | 'STK',
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const r of rows) {
    const parsed = parseJobSeq(r.job_no);
    if (parsed && parsed.prefix === prefix) map.set(r.id, formatJobNo(prefix, parsed.n));
    else if (r.job_no && !isPlaceholderMark(r.job_no)) map.set(r.id, r.job_no);
  }
  const missing = rows.filter(r => !map.has(r.id));
  if (!missing.length) return map;

  const allocated = await allocateNextJobNos(prefix, missing.length);
  if (allocated.length !== missing.length) {
    // RPC not installed yet — scoped sequence so the register still shows codes.
    return assignSequentialJobNos(rows, prefix);
  }

  for (let i = 0; i < missing.length; i += 40) {
    await Promise.all(missing.slice(i, i + 40).map((r, idx) => {
      const job = allocated[i + idx];
      if (!job) return Promise.resolve();
      map.set(r.id, job);
      return supabase.from(table).update({ job_no: job } as never).eq('id', r.id);
    }));
  }
  return map;
}

export function jobNoFar(id: string, identificationMark?: string | null, assigned?: string | null): string {
  const persisted = parseJobSeq(assigned);
  if (persisted && persisted.prefix === 'FAR') return formatJobNo('FAR', persisted.n);
  if (assigned && !isPlaceholderMark(assigned)) return assigned;
  const mark = (identificationMark ?? '').trim();
  if (mark && !isPlaceholderMark(mark) && !SEQ.test(mark)) return mark;
  return assigned || `FAR-${id.replace(/-/g, '').slice(0, 3).toUpperCase()}`;
}

export function jobNoStock(id: string, assigned?: string | null): string {
  const persisted = parseJobSeq(assigned);
  if (persisted) return formatJobNo(persisted.prefix, persisted.n);
  if (assigned && !isPlaceholderMark(assigned)) return assigned;
  return `STK-${id.replace(/-/g, '').slice(0, 3).toUpperCase()}`;
}

export function ticketShort(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : '';
}
