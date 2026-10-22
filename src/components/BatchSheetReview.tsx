/**
 * BatchSheetReview
 *
 * Right panel after NVIDIA OCR extract. Editable against the physical CPW
 * batch sheet (dummy sheet + workflow PDF). Saves readings + full sheet
 * details, auto-computes oil CON ratio, and suggests opening balance from
 * the previous batch's closing balance.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { callRpc, insertRows, updateRows } from '../lib/db';
import { useBlacklistGuard } from '../lib/blacklist/guard';
import { useToast } from './ui/toast';
import { computeSheetOilConRatio } from '../lib/algorithms/batchSheetYield';
import {
  parsePressureToKg,
  parseBatchTimestamp,
  type ExtractedBatchSheet,
  type BatchReadingExtracted,
} from '../lib/nvidiaOcr';

interface EditableReading extends BatchReadingExtracted {
  _key: string;
}

interface BatchSheetReviewProps {
  data: ExtractedBatchSheet;
  imageUrl: string;
  batches: { id: string; batch_no?: string }[];
  ipAddress?: string;
  onSaved: (batchNo: string) => void;
  onCancel: () => void;
  readOnly?: boolean;
  plantId?: string | null;
}

function numStr(v: number | null | undefined): string {
  return v != null && Number.isFinite(v) ? String(v) : '';
}

export function BatchSheetReview({
  data,
  imageUrl,
  batches,
  ipAddress,
  onSaved,
  onCancel,
  readOnly = false,
  plantId = null,
}: BatchSheetReviewProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const screenBlacklist = useBlacklistGuard();

  const [batchNo, setBatchNo] = useState(data.batchNo ?? '');
  const [finalGravity, setFinalGravity] = useState(numStr(data.finalGravity));
  const [typeOfOil, setTypeOfOil] = useState(data.summary?.typeOfOil ?? '');
  const [totalBatchTime, setTotalBatchTime] = useState(data.processInfo?.totalBatchTime ?? '');

  const [paraffinWeight, setParaffinWeight] = useState(numStr(data.summary?.paraffinWeight));
  const [hclQty, setHclQty] = useState(numStr(data.summary?.hclQuantity));
  const [totalDrums, setTotalDrums] = useState(numStr(data.summary?.totalDrumsFilled));
  const [openingBal, setOpeningBal] = useState(numStr(data.summary?.openingBalance));
  const [closingBal, setClosingBal] = useState(numStr(data.summary?.closingBalance));
  const [operator, setOperator] = useState(data.summary?.operator ?? '');
  const [helper, setHelper] = useState(data.summary?.helper ?? '');
  const [melterNo, setMelterNo] = useState(data.summary?.melterNo ?? '');
  const [degasserNo, setDegasserNo] = useState(data.summary?.degasserNo ?? '');
  const [hsUsed, setHsUsed] = useState(numStr(data.summary?.hsUsed));
  const [brightener, setBrightener] = useState(data.summary?.brightener ?? '');
  const [freeCl2, setFreeCl2] = useState(data.summary?.freeCl2 ?? '');
  const [oilConFromSheet, setOilConFromSheet] = useState(numStr(data.summary?.oilConRatio));
  const [fillingInCharge, setFillingInCharge] = useState(data.summary?.fillingInCharge ?? '');
  const [spGravityTemp, setSpGravityTemp] = useState(data.summary?.spGravityTemp ?? '');
  const [technical, setTechnical] = useState(data.summary?.technical ?? '');
  const [coolingStopTemp, setCoolingStopTemp] = useState(numStr(data.summary?.coolingStopTemp));
  const [rxPurgeTemp, setRxPurgeTemp] = useState(numStr(data.summary?.reactorAirPurgingTemp));
  const [rxPurgeStart, setRxPurgeStart] = useState(data.summary?.reactorAirPurgingStartTime ?? '');
  const [rxPurgeEnd, setRxPurgeEnd] = useState(data.summary?.reactorAirPurgingEndTime ?? '');
  const [degPurgeStart, setDegPurgeStart] = useState(data.summary?.degasserAirPurgingStartTime ?? '');
  const [degPurgeEnd, setDegPurgeEnd] = useState(data.summary?.degasserAirPurgingEndTime ?? '');

  const [oilTime, setOilTime] = useState(data.processInfo?.oilTime ?? '');
  const [oilDate, setOilDate] = useState(data.processInfo?.oilDate ?? '');
  const [oilTemp, setOilTemp] = useState(numStr(data.processInfo?.oilTemp));
  const [cl2StartTime, setCl2StartTime] = useState(data.processInfo?.cl2StartingTime ?? '');
  const [cl2StartTemp, setCl2StartTemp] = useState(numStr(data.processInfo?.cl2StartingTemp));
  const [frrTime, setFrrTime] = useState(data.processInfo?.frrTime ?? '');
  const [frrTemp, setFrrTemp] = useState(numStr(data.processInfo?.frrTemp));
  const [frrPressure, setFrrPressure] = useState(data.processInfo?.frrPressure ?? data.processInfo?.pressure ?? '');

  const [notes, setNotes] = useState(data.notes ?? '');
  const [carryHint, setCarryHint] = useState<number | null>(null);

  const [readings, setReadings] = useState<EditableReading[]>(
    (data.readings ?? []).map((r, i) => ({ ...r, _key: `r-${i}` })),
  );

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Carry-forward: previous closing → this opening (if OCR left opening empty)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: prevClose, error } = await callRpc<number | null>('latest_batch_closing_balance', {
        p_plant_id: plantId,
      });
      if (cancelled || error || prevClose == null) return;
      setCarryHint(Number(prevClose));
      if (!data.summary?.openingBalance && data.summary?.openingBalance !== 0) {
        setOpeningBal(String(prevClose));
      }
    })();
    return () => { cancelled = true; };
  }, [plantId, data.summary?.openingBalance]);

  const yieldResult = useMemo(() => {
    const paraffin = paraffinWeight ? parseFloat(paraffinWeight) : NaN;
    const drums = totalDrums ? parseFloat(totalDrums) : NaN;
    const open = openingBal !== '' ? parseFloat(openingBal) : 0;
    const close = closingBal !== '' ? parseFloat(closingBal) : 0;
    if (!Number.isFinite(paraffin) || !Number.isFinite(drums)) return null;
    return computeSheetOilConRatio({
      paraffinWeightKg: paraffin,
      drumsFilled: drums,
      openingBalanceKg: Number.isFinite(open) ? open : 0,
      closingBalanceKg: Number.isFinite(close) ? close : 0,
    });
  }, [paraffinWeight, totalDrums, openingBal, closingBal]);

  const updateReading = (key: string, field: keyof BatchReadingExtracted, raw: string) => {
    setReadings(prev => prev.map(r => {
      if (r._key !== key) return r;
      if (field === 'temp' || field === 'cpGravity' || field === 'hclGravity') {
        return { ...r, [field]: raw === '' ? null : parseFloat(raw) };
      }
      return { ...r, [field]: raw === '' ? null : raw };
    }));
  };

  const deleteReading = (key: string) => setReadings(prev => prev.filter(r => r._key !== key));
  const addRow = () => setReadings(prev => [...prev, {
    _key: `new-${Date.now()}`, date: '', time: '', temp: null,
    cpGravity: null, cl2Pressure: null, cl2PipeLinePressure: null,
    hclGravity: null, operator: null,
  }]);

  const handleSave = async () => {
    if (!batchNo) { toast.error(t('batch.batchNoRequired', 'Batch number is required.')); return; }
    setSaving(true);
    setSaveError(null);

    try {
      const fgNum = finalGravity ? parseFloat(finalGravity) : null;
      const drumsNum = totalDrums ? parseInt(totalDrums, 10) : null;
      const parfNum = paraffinWeight ? parseFloat(paraffinWeight) : null;
      const hclNum = hclQty ? parseFloat(hclQty) : null;
      const openNum = openingBal !== '' ? parseFloat(openingBal) : null;
      const closeNum = closingBal !== '' ? parseFloat(closingBal) : null;
      const computedRatio = yieldResult?.ok ? yieldResult.oilConRatioGPerKg : null;
      const sheetRatio = oilConFromSheet ? parseFloat(oilConFromSheet) : null;
      const oilRatio = computedRatio ?? (Number.isFinite(sheetRatio) ? sheetRatio : null);

      const sheetDetails = {
        processInfo: {
          oilTime, oilDate, oilTemp: oilTemp ? parseFloat(oilTemp) : null,
          cl2StartingTime: cl2StartTime, cl2StartingTemp: cl2StartTemp ? parseFloat(cl2StartTemp) : null,
          frrTime, frrTemp: frrTemp ? parseFloat(frrTemp) : null, frrPressure,
          totalBatchTime, pressure: frrPressure,
        },
        summary: {
          typeOfOil, melterNo, degasserNo,
          openingBalance: openNum, totalDrumsFilled: drumsNum, closingBalance: closeNum,
          helper, operator, paraffinWeight: parfNum, hclQuantity: hclNum,
          reactorAirPurgingTemp: rxPurgeTemp ? parseFloat(rxPurgeTemp) : null,
          reactorAirPurgingStartTime: rxPurgeStart || null,
          reactorAirPurgingEndTime: rxPurgeEnd || null,
          coolingStopTemp: coolingStopTemp ? parseFloat(coolingStopTemp) : null,
          degasserAirPurgingStartTime: degPurgeStart || null,
          degasserAirPurgingEndTime: degPurgeEnd || null,
          hsUsed: hsUsed ? parseFloat(hsUsed) : null,
          brightener: brightener || null,
          freeCl2: freeCl2 || null,
          oilConRatio: oilRatio,
          oilConRatioFromSheet: sheetRatio,
          oilConRatioComputed: computedRatio,
          netCpKg: yieldResult?.netCpKg ?? null,
          fillingInCharge: fillingInCharge || null,
          spGravityTemp: spGravityTemp || null,
          technical: technical || null,
        },
        notes,
        companyName: data.companyName ?? null,
      };

      const batchPayload = {
        final_gravity: fgNum,
        total_drums: drumsNum,
        paraffin_weight: parfNum,
        hcl_quantity: hclNum,
        opening_balance: openNum,
        closing_balance: closeNum,
        oil_con_ratio_g_per_kg: oilRatio,
        net_cp_kg: yieldResult?.ok ? yieldResult.netCpKg : null,
        sheet_details: sheetDetails,
        helper_name: helper || null,
        operator_name: operator || null,
        technical_name: technical || null,
        type_of_oil: typeOfOil || null,
        total_batch_time: totalBatchTime || null,
        recipe: typeOfOil || 'Unknown',
        closed_at: new Date().toISOString(),
        status: 'closed' as const,
        ...(plantId ? { plant_id: plantId } : {}),
      };

      let batchId: string | null = null;
      const existing = batches.find(b => String(b.batch_no) === String(batchNo) && !b.id?.startsWith('mock-'));

      if (existing) {
        batchId = existing.id;
        const { error } = await updateRows('active_batches', batchPayload).eq('id', batchId);
        if (error) throw error;
      } else {
        const { data: nb, error: e } = await insertRows('active_batches', {
          batch_no: batchNo,
          target_qty: 0,
          ...batchPayload,
        }).select().single();
        if (e) throw e;
        batchId = nb.id;
      }
      if (!batchId) throw new Error(t('batch.errResolveBatchId', 'Could not resolve batch ID'));

      const toInsert = readings
        .filter(r => r.date || r.time || r.temp != null || r.cpGravity != null)
        .map(r => ({
          batch_id: batchId,
          timestamp: parseBatchTimestamp(r.date ?? '', r.time ?? ''),
          temp: r.temp,
          cp_gravity: r.cpGravity,
          cl2_pressure: parsePressureToKg(r.cl2Pressure),
          hcl_gravity: r.hclGravity,
          cl2_pipe_pressure: parsePressureToKg(r.cl2PipeLinePressure),
        }));

      if (toInsert.length > 0) {
        const { error: re } = await insertRows('batch_readings', toInsert);
        if (re) throw re;
      }

      await insertRows('batch_edit_logs', {
        ip_address: ipAddress ?? 'unknown',
        batch_no: batchNo,
        action_type: 'sheet_upload',
        details: {
          readings_count: toInsert.length,
          ...sheetDetails,
          yield: yieldResult,
        },
        created_at: new Date().toISOString(),
      });

      const hits = await screenBlacklist(
        [
          { value: data.companyName ?? '', label: 'Company' },
          { value: operator, label: 'Operator' },
          { value: helper, label: 'Helper' },
          { value: fillingInCharge, label: 'Filling In-charge' },
          { value: technical, label: 'Technical' },
          ...readings.map((r) => ({ value: r.operator ?? '', label: 'Operator' })),
        ],
        { workflow: 'Batch Sheet OCR', source: 'ocr', entityLabel: `Batch ${batchNo}` },
      );
      if (hits.length) {
        const h = hits[0];
        toast.error(t('batch.blacklistHit', {
          defaultValue: '⚠ "{{value}}" ≈ blacklisted {{type}} "{{name}}" ({{pct}}%). Admin notified.',
          value: h.candidate.value, type: h.entry.type, name: h.entry.name, pct: Math.round(h.score * 100),
        }));
      }

      toast.success(
        yieldResult?.ok
          ? t('batch.savedWithYield', {
              defaultValue: 'Batch {{batchNo}} saved · Oil CON {{ratio}} g/kg CP',
              batchNo,
              ratio: yieldResult.oilConRatioGPerKg!.toFixed(1),
            })
          : t('batch.savedOk', { defaultValue: 'Batch {{batchNo}} saved', batchNo }),
      );
      onSaved(batchNo);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setSaveError(msg);
      setSaving(false);
    }
  };

  const inputCls = readOnly
    ? 'w-full p-2 border-2 border-slate-100 rounded-xl text-sm font-medium bg-slate-50 text-slate-500 cursor-not-allowed select-none'
    : 'w-full p-2 border-2 border-slate-200 rounded-xl text-sm font-medium focus:border-violet-400 focus:outline-none bg-white transition-colors';
  const labelCls = 'block text-xs font-bold text-slate-400 uppercase tracking-wide mb-1';

  const field = (
    label: string,
    val: string,
    set: (v: string) => void,
    opts?: { type?: string; ph?: string; span?: string },
  ) => (
    <div className={opts?.span}>
      <label className={labelCls}>{label}</label>
      <input
        type={opts?.type ?? 'text'}
        value={val}
        onChange={e => !readOnly && set(e.target.value)}
        readOnly={readOnly}
        className={inputCls}
        placeholder={opts?.ph}
      />
    </div>
  );

  return (
    <div className="flex flex-col h-full bg-white rounded-2xl shadow-sm overflow-hidden">
      <div
        className="flex items-center justify-between px-5 py-3.5 border-b border-slate-100 shrink-0"
        style={{
          background: readOnly
            ? 'linear-gradient(to right, #fef2f2, #fff7ed)'
            : 'linear-gradient(to right, #f5f3ff, #f8fafc)',
        }}
      >
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: readOnly ? '#fee2e2' : '#ede9fe' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={readOnly ? '#dc2626' : '#7c3aed'} strokeWidth="2.5">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
          </div>
          <div>
            <div className="text-sm font-bold text-slate-800">
              {readOnly ? t('batch.lockedSheet', 'Locked sheet') : t('batch.reviewExtracted', 'Review extracted sheet')}
            </div>
            <div className="text-[11px] text-slate-400">
              {t('batch.readingsDetected', { defaultValue: '{{n}} readings detected · Edit any cell before saving', n: readings.length })}
            </div>
          </div>
        </div>
        <button type="button" onClick={onCancel} className="text-xs font-bold text-slate-400 hover:text-slate-700">
          {t('common.discard', 'Discard')}
        </button>
      </div>

      <div className="flex flex-1 min-h-0">
        <div className="shrink-0 overflow-auto border-r border-slate-100 bg-slate-50 flex flex-col items-center p-3 gap-2" style={{ width: 200 }}>
          <div className="text-xs font-bold text-slate-400 uppercase tracking-wide self-start">{t('batch.originalSheet', 'Original Sheet')}</div>
          <img src={imageUrl} alt="Batch sheet original" className="w-full rounded-xl shadow-sm border border-slate-200 object-contain" style={{ maxHeight: '100%' }} />
        </div>

        <div className="flex-1 overflow-auto p-5 space-y-5">
          <div>
            <div className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">{t('batch.batchHeader', 'Batch Header')}</div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {field(t('batch.batchNoLabel', 'Batch No. *'), batchNo, setBatchNo, { ph: 'P-701' })}
              {field(t('batch.finalGravity', 'Final Gravity'), finalGravity, setFinalGravity, { type: 'number', ph: '1305' })}
              {field(t('batch.typeOfOil', 'Type of Oil'), typeOfOil, setTypeOfOil, { ph: '60% NPQ + …' })}
              {field(t('batch.totalBatchTime', 'Total Batch Time'), totalBatchTime, setTotalBatchTime, { ph: '37h 10m' })}
            </div>
          </div>

          <div>
            <div className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">{t('batch.processInfo', 'Process Info')}</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {field('Oil time', oilTime, setOilTime, { ph: '9:00 pm' })}
              {field('Oil date', oilDate, setOilDate, { ph: '24/07/26' })}
              {field('Oil temp °C', oilTemp, setOilTemp, { type: 'number', ph: '30' })}
              {field('Cl₂ start time', cl2StartTime, setCl2StartTime, { ph: '9:30 pm' })}
              {field('Cl₂ start temp', cl2StartTemp, setCl2StartTemp, { type: 'number', ph: '36' })}
              {field('FRR time', frrTime, setFrrTime, { ph: '11:30 pm' })}
              {field('FRR temp', frrTemp, setFrrTemp, { type: 'number', ph: '68' })}
              {field('FRR / pressure', frrPressure, setFrrPressure, { ph: '0.4' })}
            </div>
          </div>

          <div>
            <div className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">{t('batch.batchSummary', 'Batch Summary')}</div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {field(t('batch.paraffinWt', 'Paraffin Wt. (kg)'), paraffinWeight, setParaffinWeight, { type: 'number', ph: '3000' })}
              {field(t('batch.hclQty', 'HCL Qty (kg)'), hclQty, setHclQty, { type: 'number', ph: '102' })}
              {field(t('batch.totalDrums', 'Total Drums'), totalDrums, setTotalDrums, { type: 'number', ph: '28' })}
              {field(t('batch.openingBalance', 'Opening Balance'), openingBal, setOpeningBal, { type: 'number', ph: '40' })}
              {field('Closing balance', closingBal, setClosingBal, { type: 'number', ph: '60' })}
              {field('HS used (kg)', hsUsed, setHsUsed, { type: 'number', ph: '146' })}
              {field('Brightener', brightener, setBrightener, { ph: '12 g' })}
              {field('Free Cl₂', freeCl2, setFreeCl2, { ph: 'Nil' })}
              {field('Melter No.', melterNo, setMelterNo, { ph: 'M1' })}
              {field('Degasser No.', degasserNo, setDegasserNo, { ph: '3' })}
              {field('Filling in-charge', fillingInCharge, setFillingInCharge, { ph: 'Suresh' })}
              {field(t('batch.colOperator', 'Operator'), operator, setOperator, { ph: 'Ramesh' })}
              {field(t('batch.helper', 'Helper'), helper, setHelper, { ph: 'Amit + Vinod' })}
              {field('Technical', technical, setTechnical, { ph: 'R. Gupta' })}
              {field('Sp. Gravity / temp', spGravityTemp, setSpGravityTemp, { ph: '1305 / 30°C' })}
              {field('Oil CON (sheet g/kg)', oilConFromSheet, setOilConFromSheet, { type: 'number', ph: '450.2' })}
            </div>
            {carryHint != null && (
              <p className="mt-2 text-[11px] text-slate-400">
                Prior batch closing balance: <span className="font-semibold text-slate-600">{carryHint} kg</span>
                {' '}(auto-filled into opening when OCR left it blank).
              </p>
            )}
          </div>

          <div>
            <div className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">Purge / post-reaction</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {field('Rx air purge temp', rxPurgeTemp, setRxPurgeTemp, { type: 'number', ph: '94' })}
              {field('Rx purge start', rxPurgeStart, setRxPurgeStart, { ph: '9:10 am' })}
              {field('Rx purge end', rxPurgeEnd, setRxPurgeEnd, { ph: '10:10 am' })}
              {field('Cooling stop temp', coolingStopTemp, setCoolingStopTemp, { type: 'number', ph: '70' })}
              {field('Degasser purge start', degPurgeStart, setDegPurgeStart, { ph: '10:10 am' })}
              {field('Degasser purge end', degPurgeEnd, setDegPurgeEnd, { ph: '11:05 am' })}
            </div>
          </div>

          {/* Yield banner */}
          <div className={`rounded-xl border px-4 py-3 ${yieldResult?.ok ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'}`}>
            <div className="text-xs font-bold uppercase tracking-wide mb-1" style={{ color: yieldResult?.ok ? '#047857' : '#B45309' }}>
              Oil CON ratio (computed)
            </div>
            <div className="text-sm font-semibold text-slate-800">
              {yieldResult
                ? yieldResult.message
                : 'Enter paraffin weight + drums (+ balances) to compute. Formula: paraffin ÷ [(drums×250) + closing − opening] × 1000 g/kg CP'}
            </div>
            {yieldResult?.ok && oilConFromSheet && Math.abs(yieldResult.oilConRatioGPerKg! - parseFloat(oilConFromSheet)) > 15 && (
              <div className="mt-1 text-[11px] text-amber-700">
                Sheet value ({oilConFromSheet} g/kg) differs from computed — check drums / balances.
              </div>
            )}
          </div>

          <div>
            <label className={labelCls}>Notes</label>
            <textarea
              value={notes}
              onChange={e => !readOnly && setNotes(e.target.value)}
              readOnly={readOnly}
              rows={2}
              className={inputCls + ' resize-none'}
            />
          </div>

          {/* Readings */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="text-xs font-bold text-slate-400 uppercase tracking-widest">
                {t('batch.hourlyReadings', 'Hourly Readings')}
                <span className="ml-2 px-2 py-0.5 bg-violet-100 text-violet-700 rounded-full font-bold text-xs normal-case">
                  {t('batch.rowsCount', { defaultValue: '{{n}} rows', n: readings.length })}
                </span>
              </div>
              {!readOnly && (
                <button type="button" onClick={addRow} className="text-xs font-bold text-violet-600 hover:text-violet-800">
                  + {t('batch.addRow', 'Add Row')}
                </button>
              )}
            </div>
            {readings.length === 0 ? (
              <div className="text-center py-8 text-sm text-slate-400 border-2 border-dashed border-slate-200 rounded-xl">
                {t('batch.noReadingsExtracted', 'No readings extracted. Add rows manually or try re-uploading a clearer photo.')}
              </div>
            ) : (
              <div className="rounded-xl border border-slate-200 overflow-auto">
                <table className="w-full text-xs border-collapse" style={{ minWidth: 720 }}>
                  <thead className="bg-slate-50 sticky top-0">
                    <tr className="text-slate-500 font-bold uppercase tracking-wide border-b border-slate-200">
                      {(['Date', 'Time', 'Temp', 'CP Grav', 'Cl₂', 'Pipe', 'HCL', 'Operator', ''] as const).map(h => (
                        <th key={h} className="px-2 py-2 text-left whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {readings.map((r, idx) => (
                      <tr key={r._key} className="border-b border-slate-100" style={{ background: idx % 2 ? '#fafafa' : undefined }}>
                        {(
                          [
                            ['date', r.date ?? '', 'text'],
                            ['time', r.time ?? '', 'text'],
                            ['temp', r.temp != null ? String(r.temp) : '', 'number'],
                            ['cpGravity', r.cpGravity != null ? String(r.cpGravity) : '', 'number'],
                            ['cl2Pressure', r.cl2Pressure ?? '', 'text'],
                            ['cl2PipeLinePressure', r.cl2PipeLinePressure ?? '', 'text'],
                            ['hclGravity', r.hclGravity != null ? String(r.hclGravity) : '', 'number'],
                            ['operator', r.operator ?? '', 'text'],
                          ] as [keyof BatchReadingExtracted, string, string][]
                        ).map(([fieldKey, val, type]) => (
                          <td key={fieldKey} className="px-1 py-1">
                            <input
                              type={type}
                              value={val}
                              onChange={e => !readOnly && updateReading(r._key, fieldKey, e.target.value)}
                              readOnly={readOnly}
                              className="w-full min-w-[52px] px-2 py-1.5 rounded-lg text-xs font-mono border border-transparent focus:border-violet-300 focus:outline-none"
                            />
                          </td>
                        ))}
                        {!readOnly && (
                          <td className="px-1 py-1 text-center">
                            <button type="button" onClick={() => deleteReading(r._key)} className="text-slate-300 hover:text-red-500">×</button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {saveError && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-xs text-red-600 break-words">
              <span className="font-bold">{t('batch.saveFailed', 'Save failed:')} </span>{saveError}
            </div>
          )}
        </div>
      </div>

      {!readOnly && (
        <div className="shrink-0 border-t border-slate-100 px-5 py-3.5 flex items-center gap-3 bg-white">
          <div className="flex-1 text-xs text-slate-400">
            {t('batch.footerSummary', {
              defaultValue: '{{n}} readings · Batch #{{batchNo}} · Final Gravity {{gravity}}',
              n: readings.length, batchNo: batchNo || '—', gravity: finalGravity || '—',
            })}
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2.5 rounded-xl border border-slate-200 text-xs font-bold text-slate-500"
          >
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            disabled={saving || !batchNo}
            onClick={handleSave}
            className="px-5 py-2.5 rounded-xl text-xs font-bold text-white disabled:opacity-50"
            style={{ background: saving || !batchNo ? '#94a3b8' : '#2563EB' }}
          >
            {saving
              ? t('common.saving', 'Saving…')
              : t('batch.saveReadingsToDb', { defaultValue: 'Save {{n}} Readings to DB', n: readings.filter(r => r.date || r.cpGravity != null).length })}
          </button>
        </div>
      )}
    </div>
  );
}
