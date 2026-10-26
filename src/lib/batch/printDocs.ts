/**
 * Print / Save-as-PDF helpers for TDS and Certificate of Analysis.
 * Uses a print window (same pattern as FAR QR labels) — browser "Save as PDF" covers download.
 */

import {
  coaFamilyFromGrade,
  coaParamsForGravity,
  coaProductName,
  resolveCoaGravity,
  type CoaParamKey,
} from './coaCatalog';
import { coaLetterheadForPlant } from './coaLetterhead';
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

function openPrintWindow(title: string, bodyHtml: string, extraCss = ''): void {
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
    @page { size: A4; margin: 12mm; }
  }
  ${extraCss}
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
  const dateStr = formatCoaDate(opts.date);

  const rows = params.map((p) => {
    const result = opts.results[p.key] ?? '';
    return `<tr>
      <td class="sno">${p.sno}</td>
      <td class="param">${escapeHtml(p.parameter)}</td>
      <td>${escapeHtml(p.standard)}</td>
      <td>${escapeHtml(result)}</td>
    </tr>`;
  }).join('');

  const head = coaLetterheadForPlant(opts.plantLine);
  const html = `
  <div class="sheet coa">
    <div class="coa-bar"></div>
    <div class="coa-head">
      <img class="coa-logo" src="${logo}" alt="Suntek Group" onerror="this.style.display='none'" />
      <div class="coa-co">
        <div class="co-name">${escapeHtml(head.company)}</div>
        ${head.lines.map((line) => `<div>${escapeHtml(line)}</div>`).join('')}
      </div>
    </div>
    <div class="coa-title">CERTIFICATE OF ANALYSIS</div>
    <div class="coa-product">
      <span>PRODUCT NAME: ${escapeHtml(product)}</span>
      <span>BATCH NO- ${escapeHtml(opts.batchNo)}</span>
    </div>
    <table class="coa-table">
      <thead>
        <tr>
          <th>S.NO.</th><th>PARAMETERS</th><th>STANDARD</th><th>RESULT</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="coa-note">Above certificate of analysis issued by department of QA &amp; QC.</p>
    <div class="coa-sign">
      <div>Date- ${escapeHtml(dateStr)}</div>
      <div>Signature (Quality Control Incharge)</div>
    </div>
    <div class="coa-stamp-gap"></div>
    <hr class="coa-rule" />
  </div>`;

  openPrintWindow(`COA ${opts.batchNo}`, html, COA_PRINT_CSS);
}

function formatCoaDate(raw?: string): string {
  if (raw && /^\d{2}\/\d{2}\/\d{4}$/.test(raw.trim())) return raw.trim();
  const dt = raw ? new Date(raw) : new Date();
  if (Number.isNaN(dt.getTime())) {
    const now = new Date();
    return `${pad2(now.getDate())}/${pad2(now.getMonth() + 1)}/${now.getFullYear()}`;
  }
  return `${pad2(dt.getDate())}/${pad2(dt.getMonth() + 1)}/${dt.getFullYear()}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

const COA_PRINT_CSS = `
  .sheet.coa { max-width: 740px; min-height: 980px; padding: 8px 28px 8px 4px;
    font-family: Arial, Helvetica, sans-serif; color: #111; }
  .coa-bar { position: absolute; top: 0; right: 0; width: 16px; bottom: 0; background: #b5b5b5; }
  .coa-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
  .coa-logo { width: 132px; height: auto; object-fit: contain; }
  .coa-co { text-align: right; font-size: 12px; line-height: 1.35; font-weight: 600; }
  .coa-co .co-name { font-size: 14px; font-weight: 800; letter-spacing: 0.01em; margin-bottom: 2px; }
  .sheet.coa .coa-title { text-align: center; font-size: 16px; font-weight: 800; text-decoration: underline;
    letter-spacing: 0.06em; margin: 36px 0 26px; }
  .sheet.coa .coa-product { display: flex; justify-content: space-between; gap: 16px;
    font-size: 12.5px; font-weight: 800; margin: 0 0 14px; }
  table.coa-table { width: 100%; border-collapse: collapse; font-size: 12px; margin: 0; }
  table.coa-table th, table.coa-table td { background: #fff !important; color: #111 !important;
    border: 1px solid #111 !important; padding: 7px 8px; text-align: center; font-weight: 600; outline: none; }
  table.coa-table th { font-weight: 800; }
  table.coa-table th:nth-child(2), table.coa-table td.param { text-align: left; }
  table.coa-table td.sno, table.coa-table th:first-child { width: 52px; }
  table.coa-table th:nth-child(3), table.coa-table th:nth-child(4),
  table.coa-table td:nth-child(3), table.coa-table td:nth-child(4) { width: 110px; }
  .coa-note { font-size: 12px; font-weight: 600; margin: 18px 0 0; color: #111; }
  .coa-sign { display: flex; justify-content: space-between; align-items: flex-start;
    margin-top: 36px; font-size: 12.5px; font-weight: 700; }
  .coa-stamp-gap { height: 72px; }
  .coa-rule { border: none; border-top: 1px solid #111; margin: 8px 0 0; }
  @media print {
    .sheet.coa { min-height: 250mm; }
  }
`;
