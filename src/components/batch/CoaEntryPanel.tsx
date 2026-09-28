/**
 * Manual Certificate of Analysis entry — Result column only.
 * Standard column follows batch density (same grade bands as TDS).
 */
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  coaFamilyFromGrade,
  coaParamsForGravity,
  coaProductName,
  coaSpecLabel,
  resolveCoaGravity,
  type CoaParamKey,
} from '../../lib/batch/coaCatalog';
import { printCoa, type CoaResultMap } from '../../lib/batch/printDocs';
import { updateRows } from '../../lib/db';
import { humanizeError } from '../../lib/errors';
import { useToast } from '../ui/toast';

export interface CoaSheetTarget {
  id: string;
  batch_no: string;
  oil_ratio: number | string | null;
  oil_grade?: string | null;
  density: number;
  plantName?: string | null;
  source?: 'native' | 'legacy';
  legacyDetails?: Record<string, unknown> | null;
  /** Previously saved results */
  coa_results?: CoaResultMap | null;
}

export function CoaEntryPanel({
  sheet,
  onClose,
  onSaved,
}: {
  sheet: CoaSheetTarget;
  onClose: () => void;
  onSaved?: (results: CoaResultMap) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const family = coaFamilyFromGrade(sheet.oil_grade);
  const gravity = resolveCoaGravity(sheet.density, sheet.oil_ratio);
  const params = useMemo(() => coaParamsForGravity(gravity, family), [gravity, family]);
  const specLabel = useMemo(() => coaSpecLabel(gravity, family), [gravity, family]);
  const product = coaProductName();
  const [results, setResults] = useState<CoaResultMap>(() => ({ ...(sheet.coa_results ?? {}) }));
  const [saving, setSaving] = useState(false);

  function setResult(key: CoaParamKey, value: string) {
    setResults((prev) => ({ ...prev, [key]: value }));
  }

  async function save() {
    setSaving(true);
    try {
      if (sheet.source === 'legacy') {
        const { error } = await updateRows('active_batches', {
          sheet_details: { ...(sheet.legacyDetails ?? {}), coa_results: results },
        }).eq('id', sheet.id);
        if (error) throw error;
      } else {
        const { error } = await updateRows('production_batch_sheets', {
          coa_results: results,
          coa_issued_at: new Date().toISOString(),
        }).eq('id', sheet.id);
        if (error) throw error;
      }
      toast.success(t('batchProd.coaSaved', 'COA results saved'));
      onSaved?.(results);
    } catch (e) {
      toast.error(humanizeError(e, { action: 'save COA results', context: 'CoaEntryPanel' }));
    } finally {
      setSaving(false);
    }
  }

  function handlePrint() {
    printCoa({
      batchNo: sheet.batch_no,
      oilRatio: sheet.oil_ratio,
      density: sheet.density,
      oilGrade: sheet.oil_grade,
      results,
      plantLine: sheet.plantName ?? undefined,
    });
  }

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 280, display: 'flex', justifyContent: 'flex-end' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 520, background: '#fff', height: '100%', overflow: 'auto', boxShadow: '-12px 0 40px rgba(0,0,0,0.18)' }}
      >
        <div style={{ padding: '16px 18px', borderBottom: '1px solid #E2E8F0', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800 }}>{t('batchProd.coaTitle', 'Certificate of Analysis')}</div>
            <div style={{ fontSize: 12, color: '#64748B', marginTop: 4 }}>
              {sheet.batch_no} · {product}
            </div>
            <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 2 }}>
              {t('batchProd.coaHint', {
                defaultValue: 'Enter Result values only. Standard column follows {{spec}} (density {{density}}).',
                spec: specLabel,
                density: sheet.density,
              })}
            </div>
          </div>
          <button type="button" onClick={onClose} style={{ border: 'none', background: '#F1F5F9', width: 32, height: 32, borderRadius: 999, cursor: 'pointer' }}>✕</button>
        </div>

        <div style={{ padding: 16 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: '#0F172A', color: '#fff' }}>
                <th style={{ padding: 8, textAlign: 'left', width: 36 }}>#</th>
                <th style={{ padding: 8, textAlign: 'left' }}>Parameter</th>
                <th style={{ padding: 8, textAlign: 'left' }}>Standard</th>
                <th style={{ padding: 8, textAlign: 'left' }}>Result</th>
              </tr>
            </thead>
            <tbody>
              {params.map((p) => (
                <tr key={p.key} style={{ borderBottom: '1px solid #E2E8F0' }}>
                  <td style={{ padding: 8, color: '#94A3B8' }}>{p.sno}</td>
                  <td style={{ padding: 8 }}>{p.parameter}</td>
                  <td style={{ padding: 8, color: '#64748B', whiteSpace: 'nowrap' }}>{p.standard}</td>
                  <td style={{ padding: 8 }}>
                    <input
                      value={results[p.key] ?? ''}
                      onChange={(e) => setResult(p.key, e.target.value)}
                      placeholder={p.resultKind === 'text' ? 'e.g. NIL' : '—'}
                      style={{ width: '100%', padding: '6px 8px', borderRadius: 8, border: '1px solid #E2E8F0', fontSize: 12 }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ padding: '12px 16px 20px', display: 'flex', gap: 8, justifyContent: 'flex-end', borderTop: '1px solid #E2E8F0', position: 'sticky', bottom: 0, background: '#fff' }}>
          <button type="button" onClick={onClose} style={{ padding: '9px 14px', borderRadius: 10, border: '1px solid #E2E8F0', background: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
            {t('common.cancel', 'Cancel')}
          </button>
          <button type="button" onClick={() => void save()} disabled={saving} style={{ padding: '9px 14px', borderRadius: 10, border: 'none', background: '#0F172A', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
            {saving ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
          </button>
          <button type="button" onClick={handlePrint} style={{ padding: '9px 14px', borderRadius: 10, border: 'none', background: '#EF6C00', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
            {t('batchProd.printCoa', 'Print / PDF')}
          </button>
        </div>
      </div>
    </div>
  );
}
