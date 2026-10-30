// @vitest-environment node
/**
 * Guards that read the source itself, so items 1–8 cannot quietly come back
 * without anyone opening a browser.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
/** Source without comments (a comment may mention <input type="date">). */
const code = (p: string) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const sources = walk(ROOT).filter((p) => /\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p) && !p.includes('/i18n/locales/'));

describe('release guards', () => {
  it('1 · no native date box is shown: every date field is the dd/mm/yyyy DateInput', () => {
    const offenders = sources.filter((p) => !p.endsWith('components/ui/DateInput.tsx'))
      .filter((p) => /<(?:input|PanelInput)\b[^>]*type="(?:date|datetime-local)"/.test(code(p)));
    expect(offenders).toEqual([]);
  });

  it('8 · Dispatch and Payments do not clamp dates to today (tomorrow is allowed)', () => {
    for (const f of ['routes/dashboard/purchase/DispatchLog.tsx', 'routes/dashboard/purchase/BookPayments.tsx']) {
      expect(read(f)).not.toMatch(/max=\{istToday\(\)\}/);
      expect(read(f)).toMatch(/<DateInput\b/);
    }
  });

  it('2 · Dispatch asks company → from → destination → payee (when 0042 is live)', () => {
    const src = read('routes/dashboard/purchase/DispatchLog.tsx');
    const at = (k: string) => src.indexOf(`t('dispatch.${k}'`);
    expect(at('company')).toBeGreaterThan(-1);
    expect(at('company')).toBeLessThan(at('from'));
    expect(at('from')).toBeLessThan(at('destination'));
    expect(at('destination')).toBeLessThan(at('payee'));
    // Hidden until migration 0042 is on the database.
    expect(src).toMatch(/useColumnLive\('dispatch_logs', 'company_code'\)/);
  });

  it('2 · migration 0042 has the IFSC rule (0 in 5th place) and four companies', () => {
    const sql = readFileSync(join(ROOT, '..', 'supabase/migrations/0042_dispatch_payee_activity_entity.sql'), 'utf8');
    expect(sql).toMatch(/add column if not exists company_code/);
    expect(sql).toMatch(/\^\[A-Z\]\{4\}0\[A-Z0-9\]\{6\}\$/);
    expect(sql).toMatch(/'0007', '0009', '0010', '0012'/);
  });

  it('6 · no Delete all / Delete filtered / Delete selected — buttons or strings', () => {
    const banned = /deleteAll\b|deleteFiltered|deleteSelected|deletingAll|handleDeleteAllEmergency/;
    expect(sources.filter((p) => banned.test(readFileSync(p, 'utf8')))).toEqual([]);
    for (const loc of ['i18n/locales/en.ts', 'i18n/locales/hi.ts']) expect(read(loc)).not.toMatch(banned);
  });

  it('A · still four Busy companies, no fifth; NKG · Kolkata label in both languages', () => {
    expect(read('lib/busyCompanies.ts').match(/code: '\d{4}'/g)).toEqual(["code: '0007'", "code: '0009'", "code: '0010'", "code: '0012'"]);
    expect(read('i18n/locales/en.ts')).toMatch(/tabKolkata: "NKG · Kolkata"/);
    expect(read('i18n/locales/hi.ts')).toMatch(/tabKolkata: "NKG · कोलकाता"/);
  });

  it('Payments shows full rupees (₹ 6,80,000), never the short ₹ 6.8 L, and matches Busy from any open stage', () => {
    const src = read('routes/dashboard/purchase/BookPayments.tsx');
    expect(src).not.toMatch(/\bfmtINR\(/);
    expect(src).toMatch(/fmtINRFull\(r\.amount\)/);
    expect(src).toMatch(/BUSY_OPEN_STATUSES/);
    expect(src).not.toMatch(/\.in\('status', \['payment_completed', 'payment_done'\]\)/);
  });

  it('Busy stays read only: no insert / update / delete against busy_feed from the app', () => {
    const writes = sources.filter((p) => /from\(['"]busy_feed['"]\)\s*\.(insert|update|upsert|delete)/.test(readFileSync(p, 'utf8')));
    expect(writes).toEqual([]);
  });
});
