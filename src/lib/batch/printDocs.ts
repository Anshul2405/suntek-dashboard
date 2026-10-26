/**
 * Print / Save-as-PDF helpers for TDS and Certificate of Analysis.
 * Uses a print window (same pattern as FAR QR labels) — browser "Save as PDF" covers download.
 */
import { formatDate } from '../utils/formatting';

import {
  coaFamilyFromGrade,
  coaParamsForGravity,
  coaProductName,
  resolveCoaGravity,
  type CoaParamKey,
} from './coaCatalog';
import {
  TDS_APPEARANCE,
  TDS_BLURB,
  TDS_PARTICULARS,
  gradeCodeFor,
  tdsCell,
  tdsGradeColumns,
  type TdsFamily,
} from './tdsCatalog';

function escapeHtml(s: string): string {
  return (s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

function openPrintWindow(title: string, bodyHtml: string): void {
  const w = window.open('', '_blank', 'width=900,height=1100');
  if (!w) {
    window.alert('Pop-up blocked — allow pop-ups to print / save PDF.');
    return;
  }
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'IBM Plex Sans', system-ui, sans-serif; margin: 0; padding: 24px; color: #0F172A;
    background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .sheet { max-width: 780px; margin: 0 auto; position: relative; }
  .accent-bar { position: absolute; top: 0; right: 0; width: 10px; bottom: 0; background: #EF6C00; }
  .hdr { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
  .logo { display: flex; align-items: center; gap: 10px; }
  .logo img { width: 48px; height: 48px; object-fit: contain; }
  .logo-name { font-weight: 800; font-size: 15px; letter-spacing: 0.04em; }
  .logo-sub { font-size: 10px; color: #64748B; letter-spacing: 0.12em; text-transform: uppercase; }
  .badge { background: #E8D5B7; color: #334155; font-size: 11px; font-weight: 800; letter-spacing: 0.06em;
    padding: 8px 14px; border-radius: 999px; white-space: nowrap; }
  h1 { font-size: 20px; font-weight: 800; margin: 0 0 10px; text-transform: uppercase; }
  .blurb { font-size: 12px; line-height: 1.55; color: #334155; margin: 0 0 8px; }
  .appear { font-size: 12px; font-weight: 600; margin: 0 0 16px; }
  .apps { display: flex; flex-wrap: wrap; gap: 10px 18px; margin: 0 0 18px; font-size: 11px; color: #475569; }
  .apps span { font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; margin-bottom: 16px; }
  th { background: #EF6C00; color: #fff; padding: 8px 6px; text-align: center; font-weight: 700; }
  th:nth-child(2), td:nth-child(2) { text-align: left; }
  td { padding: 7px 6px; text-align: center; border-bottom: 1px solid #FED7AA; }
  tr:nth-child(even) td { background: #FFF7ED; }
  td.hl { background: #FFEDD5 !important; font-weight: 700; outline: 2px solid #EF6C00; }
  .meta { font-size: 11px; color: #64748B; margin-bottom: 10px; }
  .foot { font-size: 10px; color: #64748B; line-height: 1.45; }
  .coa-title { text-align: center; font-size: 18px; font-weight: 800; text-decoration: underline;
    margin: 12px 0 16px; letter-spacing: 0.04em; }
  .coa-product { font-size: 13px; font-weight: 700; margin-bottom: 12px; display: flex; justify-content: space-between; gap: 12px; }
  .sign { display: flex; justify-content: space-between; margin-top: 28px; font-size: 12px; }
  .toolbar { position: sticky; top: 0; z-index: 2; background: #0F172A; color: #fff; padding: 10px 16px;
    display: flex; gap: 10px; align-items: center; justify-content: space-between; margin: -24px -24px 20px; }
  .toolbar button { background: #EF6C00; color: #fff; border: none; border-radius: 8px; padding: 8px 14px;
    font-weight: 700; cursor: pointer; font-size: 13px; }
  @media print {
    .toolbar { display: none !important; }
    body { padding: 12px; }
    .accent-bar { print-color-adjust: exact; }
  }
</style></head>
<body>
  <div class="toolbar">
    <span>Use Print → <strong>Save as PDF</strong> to download</span>
    <button onclick="window.print()">Print / Save PDF</button>
  </div>
  ${bodyHtml}
  <script>window.focus();</script>
</body></html>`);
  w.document.close();
}

export function printTds(opts: {
  family: TdsFamily;
  oilRatio?: number | null;
  oilRatioLabel?: string | number | null;
  batchNo?: string | null;
  plantName?: string | null;
}): void {
  const cols = tdsGradeColumns(opts.family);
  const highlight = gradeCodeFor(opts.family, opts.oilRatio ?? null);
  const logo = `${window.location.origin}/brand/suntek-official.png`;

  const headCells = cols.map((c) =>
    `<th${c === highlight ? ' style="outline:2px solid #fff"' : ''}>${c}</th>`).join('');

  const rows = TDS_PARTICULARS.map((p, i) => {
    const cells = cols.map((c) => {
      const v = tdsCell(opts.family, c, i);
      return `<td class="${c === highlight ? 'hl' : ''}">${escapeHtml(v)}</td>`;
    }).join('');
    return `<tr><td>${i + 1}</td><td>${escapeHtml(p)}</td>${cells}</tr>`;
  }).join('');

  const metaBits = [
    opts.batchNo ? `Batch ${opts.batchNo}` : null,
    opts.plantName || null,
    `${opts.family} · grade ${highlight}`,
  ].filter(Boolean).join(' · ');

  const html = `
  <div class="sheet">
    <div class="accent-bar"></div>
    <div class="hdr">
      <div class="logo">
        <img src="${logo}" alt="Suntek" onerror="this.style.display='none'" />
        <div>
          <div class="logo-name">SUNTEK GROUP</div>
          <div class="logo-sub">Chlorides · CPW</div>
        </div>
      </div>
      <div class="badge">TECHNICAL DATA SHEET</div>
    </div>
    <h1>Suntek CPW (Chlorinated Paraffin Wax) — ${opts.family}</h1>
    <p class="blurb">${escapeHtml(TDS_BLURB)}</p>
    <p class="appear">${escapeHtml(TDS_APPEARANCE)}</p>
    <div class="apps">
      <span>Rubber Products</span>
      <span>PVC Cables &amp; Flooring</span>
      <span>Paints &amp; Coatings</span>
      <span>Sealants &amp; Adhesives</span>
      <span>Flame Retardant Formulations</span>
    </div>
    ${metaBits ? `<div class="meta">${escapeHtml(metaBits)}</div>` : ''}
    <table>
      <thead><tr><th>Sr.</th><th>Particulars</th>${headCells}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="foot">
      <p><strong>RoHS:</strong> All products comply with RoHS requirements.</p>
      <p><strong>NOTE:</strong> We manufacture various kinds of CPW short chain, medium chain, long chain and very long chain. Specific grades of CPW can be made on request.</p>
      <p>The above properties represent values tested in our labs. There is no guarantee/warranty. Suitability of the product for particular application may be verified before use.</p>
    </div>
  </div>`;

  openPrintWindow(`TDS ${opts.family} ${highlight}`, html);
}

export type CoaResultMap = Partial<Record<CoaParamKey, string>>;

export function printCoa(opts: {
  batchNo: string;
  oilRatio?: number | string | null;
  density: number;
  oilGrade?: string | null;
  results: CoaResultMap;
  date?: string;
  plantLine?: string;
}): void {
  const family = coaFamilyFromGrade(opts.oilGrade);
  const gravity = resolveCoaGravity(opts.density, opts.oilRatio);
  const params = coaParamsForGravity(gravity, family);
  const product = coaProductName();
  const logo = `${window.location.origin}/brand/suntek-official.png`;
  const dateStr = opts.date || formatDate(new Date());

  const rows = params.map((p) => {
    const result = opts.results[p.key] ?? '';
    return `<tr>
      <td>${p.sno}</td>
      <td>${escapeHtml(p.parameter)}</td>
      <td>${escapeHtml(p.standard)}</td>
      <td>${escapeHtml(result)}</td>
    </tr>`;
  }).join('');

  const html = `
  <div class="sheet">
    <div class="accent-bar" style="background:#DC2626;width:8px"></div>
    <div class="hdr">
      <div class="logo">
        <img src="${logo}" alt="Suntek" onerror="this.style.display='none'" />
        <div>
          <div class="logo-name">SUNTEK CHLORIDES LTD.</div>
          <div class="logo-sub">${escapeHtml(opts.plantLine || 'Near Grasim Industries Ltd. Garhwa Road Rehla, Distt. Palamu')}</div>
        </div>
      </div>
    </div>
    <div class="coa-title">CERTIFICATE OF ANALYSIS</div>
    <div class="coa-product">
      <span>PRODUCT NAME: ${escapeHtml(product)}</span>
      <span>BATCH NO — ${escapeHtml(opts.batchNo)}</span>
    </div>
    <table>
      <thead>
        <tr>
          <th>S.NO.</th><th>PARAMETERS</th><th>STANDARD</th><th>RESULT</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="blurb">Above certificate of analysis issued by department of QA &amp; QC.</p>
    <div class="sign">
      <div>
        <div>Date — ${escapeHtml(dateStr)}</div>
        <div style="margin-top:28px">Incharge</div>
      </div>
      <div style="text-align:right">
        <div>Signature (Quality Control)</div>
        <div style="margin-top:28px">Department — QA&amp;QC</div>
      </div>
    </div>
    <div class="foot" style="margin-top:24px">
      Registered &amp; Head Office: 502, Aggarwal Prestige Mall, near M2K, Rani Bagh, Pitampura, Delhi-110034.
      Ph: 1800-1200-09181 · contact@thesuntek.com · www.thesuntek.com
    </div>
  </div>`;

  openPrintWindow(`COA ${opts.batchNo}`, html);
}
