import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '../../../lib/supabase';
// Shared humanizer — a user should never be shown a raw error object.
import { humanizeError as errMsg } from '../../../lib/errors';
import { fetchActivePlants } from '../../../lib/plants';
import { insertRows } from '../../../lib/db';
import { uploadWorkflowFile } from '../../../lib/cloudinary';
import { usePlantScope } from '../../../contexts/PlantScopeContext';
import { plantsForPicker } from '../../../lib/access/pickerPlants';
import { useRoleContext } from '../../../contexts/RoleContext';
import { useNotifications } from '../../../contexts/NotificationsContext';
import { parseMaintenanceFile, type PMTemplate } from '../../../lib/pm/parseMaintenanceFile';
import { matchAsset, type AssetLite } from '../../../lib/far/assets';
import { createImportBatch, setImportBatchRowCount } from '../../../lib/imports/batches';
import { FREQ_LABEL, calculateNextDue } from './maintenance/shared';
import { fetchAllRows } from '../../../lib/fetchAll';

type Plant = { id: string; name: string };

const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 };
const modal: React.CSSProperties = { background: '#fff', borderRadius: 16, padding: 22, width: 'min(720px, 100%)', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.25)' };
const label: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: '#64748B', textTransform: 'uppercase', marginBottom: 4 };
const input: React.CSSProperties = { boxSizing: 'border-box', border: '1px solid #E2E8F0', borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', outline: 'none' };
const btnPrimary: React.CSSProperties = { padding: '10px 16px', borderRadius: 10, border: 'none', background: '#F47651', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' };
const btnGhost: React.CSSProperties = { padding: '10px 16px', borderRadius: 10, border: '1px solid #E2E8F0', background: '#fff', color: '#475569', fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' };

/** Upload a Preventive Maintenance workbook → parse → validate each equipment against
 *  the FAR → create recurring schedules. Soft validation: unmatched equipment is
 *  allowed with a justification and an admin notification (never blocked). */
export function PMScheduleImport({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: () => void }) {
  const { t } = useTranslation();
  const { activeProfile } = useRoleContext();
  const { allowedPlants, ready: scopeReady } = usePlantScope();
  const { addNotification } = useNotifications();

  const [plants, setPlants] = useState<Plant[]>([]);
  const [technicians, setTechnicians] = useState<{ name: string; plant_id: string | null }[]>([]);
  const [assigneeTech, setAssigneeTech] = useState('');
  const [assets, setAssets] = useState<(AssetLite & { plant_id: string | null })[]>([]);
  const [existing, setExisting] = useState<Set<string>>(new Set());  // `${mark}|${freq}` already scheduled
  const [stage, setStage] = useState<'form' | 'parsing' | 'review' | 'saving' | 'done' | 'error'>('form');
  const [err, setErr] = useState<string | null>(null);
  const [plantIds, setPlantIds] = useState<string[]>([]);   // factories this workbook applies to
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [untilDate, setUntilDate] = useState('');
  const [templates, setTemplates] = useState<PMTemplate[]>([]);
  const [justification, setJustification] = useState('');
  const [fileName, setFileName] = useState('');
  const [cloudUrl, setCloudUrl] = useState<string | null>(null);
  const [createdCount, setCreatedCount] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    (async () => {
      const { data: pl } = await fetchActivePlants<Plant>('id, name');
      const base = plantsForPicker(allowedPlants as Plant[], scopeReady);
      // PAGED: >1,000 assets — unpaged, marks past the first 1000 never matched.
      const { data: fa } = await fetchAllRows<AssetLite & { plant_id: string | null }>((from, to) =>
        supabase.from('fixed_assets').select('id, name, identification_mark, plant_id').order('id').range(from, to).returns<(AssetLite & { plant_id: string | null })[]>());
      const { data: sc } = await supabase.from('maintenance_schedules').select('equipment_mark, frequency, plant_id').returns<{ equipment_mark: string | null; frequency: string; plant_id: string | null }[]>();
      // Technicians (for the default assignee) with their plant.
      const { data: tech } = await supabase.from('user_accounts')
        .select('name, role_id, plant_id').eq('is_active', true)
        .returns<{ name: string; role_id: string | null; plant_id: string | null }[]>();
      if (!alive) return;
      setPlants(base);
      setPlantIds(prev => prev.length ? prev : (base.length === 1 ? [base[0].id] : []));
      setAssets(fa || []);
      setExisting(new Set((sc || []).filter(s => s.equipment_mark).map(s => `${(s.equipment_mark || '').toLowerCase()}|${s.frequency}|${s.plant_id || ''}`)));
      setTechnicians((tech || [])
        .filter(u => (u.role_id || '').toLowerCase().includes('technician'))
        .map(u => ({ name: u.name, plant_id: u.plant_id })));
    })();
    return () => { alive = false; };
  }, [open]); // eslint-disable-line

  // Match each template to a FAR asset (per-plant duplicate-skip happens at save).
  const rows = useMemo(() => templates
    .map(tpl => ({ tpl, match: matchAsset(tpl.equipmentLabel, assets) })), [templates, assets]);
  const matched = rows.filter(r => r.match);
  const unmatched = rows.filter(r => !r.match);
  const byFreq = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.tpl.frequency, (m.get(r.tpl.frequency) || 0) + 1);
    return [...m.entries()];
  }, [rows]);

  function reset() { setStage('form'); setTemplates([]); setErr(null); setCloudUrl(null); setJustification(''); setCreatedCount(0); }
  const totalToCreate = rows.length * Math.max(plantIds.length, 0);
  const canCreate = rows.length > 0 && plantIds.length > 0 && (unmatched.length === 0 || justification.trim().length > 0);
  function close() { reset(); onClose(); }
  if (!open) return null;

  async function handleFile(file: File) {
    if (!plantIds.length) {
      setErr(t('far.pmErrSelectFactory', 'Select at least one factory this workbook belongs to.'));
      return;
    }
    setFileName(file.name); setErr(null); setStage('parsing');
    try {
      try { const up = await uploadWorkflowFile(file, { workflow: 'maintenance', subfolder: 'pm-schedules', kind: 'pm', creator: activeProfile.name }); setCloudUrl(up.secure_url); } catch { /* archive best-effort */ }
      if (!/\.(xlsx|xls)$/i.test(file.name)) throw new Error(t('far.pmErrUploadXlsx', 'Please upload the Preventive Maintenance .xlsx workbook.'));
      const res = await parseMaintenanceFile(file);
      if (!res.templates.length) throw new Error(t('far.pmErrNoSchedules', 'No maintenance schedules found in this workbook.'));
      setTemplates(res.templates);
      setStage('review');
    } catch (e) { setErr(errMsg(e)); setStage('error'); }
  }

  function FactoryPicker({ compact }: { compact?: boolean }) {
    if (plants.length === 0) {
      return (
        <div style={{ fontSize: 12, color: '#DC2626', marginBottom: compact ? 8 : 12 }}>
          {t('far.pmNoFactories', 'No factories in your scope — ask an admin to assign a plant before importing PM.')}
        </div>
      );
    }
    if (plants.length === 1) {
      return (
        <div style={{ marginBottom: compact ? 8 : 12 }}>
          <div style={label}>{t('far.pmFactoryLabel', 'Factory this workbook applies to')}</div>
          <span className="chip active" style={{ cursor: 'default', marginTop: 2, display: 'inline-block' }}>{plants[0].name}</span>
        </div>
      );
    }
    return (
      <div style={{ marginBottom: compact ? 8 : 12 }}>
        <div style={label}>{t('far.pmFactoriesLabel', 'Factory / factories this workbook applies to *')}</div>
        <div className="flex gap-2 flex-wrap" style={{ marginTop: 2 }}>
          {plants.map(p => {
            const on = plantIds.includes(p.id);
            return <button key={p.id} type="button" onClick={() => setPlantIds(ids => on ? ids.filter(x => x !== p.id) : [...ids, p.id])} className={`chip${on ? ' active' : ''}`}>{on ? '✓ ' : ''}{p.name}</button>;
          })}
        </div>
        {!plantIds.length && (
          <div style={{ fontSize: 11, color: '#DC2626', marginTop: 5, fontWeight: 600 }}>
            {t('far.pmPickFactoryRequired', 'Select at least one factory to continue.')}
          </div>
        )}
        {plantIds.length > 0 && (
          <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 5 }}>
            {plantIds.length > 1
              ? t('far.pmMultiFactoryHint', { defaultValue: 'These schedules will be created for each of the {{count}} factories; each unit head is notified.', count: plantIds.length })
              : t('far.pmPickFactoryHint', 'Pick one, or multiple if this workbook is shared across factories.')}
          </div>
        )}
      </div>
    );
  }

  async function confirm() {
    if (!plantIds.length) {
      setErr(t('far.pmErrSelectFactory', 'Select at least one factory this workbook belongs to.'));
      return;
    }
    if (unmatched.length && !justification.trim()) {
      setErr(t('far.pmErrNeedJustification', 'Some equipment is not in the FAR — add a justification to proceed.'));
      return;
    }
    setErr(null);
    setStage('saving');
    try {
      const nowStart = new Date(startDate).toISOString();
      const singlePlant = plantIds.length === 1;
      const payload: Record<string, unknown>[] = [];

      // ONE BATCH PER FACTORY, not one per file. A workbook can be imported
      // against several factories at once (each keeps its own PM register), and
      // an admin must be able to undo the import for one factory without
      // touching another's schedules — so the deletable unit is (file, factory),
      // which is also how pm_schedule_uploads has always recorded it.
      //
      // Registered before the insert so every schedule row can be stamped.
      const batchByPlant = new Map<string, string>();
      for (const pid of plantIds) {
        batchByPlant.set(pid, await createImportBatch({
          module: 'pm_schedule',
          plantId: pid,
          fileName,
          fileUrl: cloudUrl,
          rowCount: 0, // corrected below, once we know what landed for this plant
          uploadedByName: activeProfile.name,
        }));
      }

      // Create the schedule set for EACH selected factory (each has its own FAR copy).
      for (const pid of plantIds) {
        const plantAssets = assets.filter(a => a.plant_id === pid);
        for (const { tpl } of rows) {
          if (existing.has(`${(tpl.mark || '').toLowerCase()}|${tpl.frequency}|${pid}`)) continue; // skip duplicate
          const match = matchAsset(tpl.equipmentLabel, plantAssets);
          const realMark = tpl.mark && !/^(x{2,}|n\/?a|nil|none|tbd|todo|-)$/i.test(tpl.mark.trim()) ? tpl.mark.trim() : '';
          payload.push({
            title: `${tpl.equipmentType}${realMark ? ` (${realMark})` : ''} — ${FREQ_LABEL[tpl.frequency] || tpl.frequency}`,
            equipment: tpl.equipmentLabel, plant_id: pid, frequency: tpl.frequency,
            description: null,
            // Only the unit head's own (single) plant gets a default technician; the
            // unit head can reassign later. Multi-plant admin import stays unassigned.
            assigned_to: (singlePlant && assigneeTech) ? assigneeTech : null,
            is_active: true, next_due_at: nowStart,
            far_asset_id: match?.asset.id ?? null, equipment_mark: realMark || null,
            start_date: startDate, until_date: untilDate || null,
            checklist: tpl.checklist, requires_approval: tpl.frequency !== 'daily',
            unmatched_justification: match ? null : justification.trim(), source: 'pm_import',
            import_batch_id: batchByPlant.get(pid) ?? null,
          });
        }
      }
      for (let i = 0; i < payload.length; i += 200) {
        const { error } = await insertRows('maintenance_schedules', payload.slice(i, i + 200) as never);
        if (error) throw error;
      }
      for (const pid of plantIds) {
        const plantCount = payload.filter(p => p.plant_id === pid).length;
        // The manifest now carries the batch id too, so Upload History and the
        // older per-plant manifest agree on which file produced what.
        await insertRows('pm_schedule_uploads', { plant_id: pid, file_name: fileName, file_url: cloudUrl, uploaded_by_name: activeProfile.name, sheet_count: 0, schedule_count: plantCount, import_batch_id: batchByPlant.get(pid) ?? null });
        const bid = batchByPlant.get(pid);
        if (bid) await setImportBatchRowCount(bid, plantCount);
        // Notify that plant's unit head so they can assign/verify technicians.
        addNotification({
          target_roles: ['unit_head', 'admin'],
          title: t('far.pmNotifTitle', { defaultValue: 'PM schedules imported for {{plant}}', plant: plants.find(p => p.id === pid)?.name || t('common.plant', 'Plant') }),
          body: t('far.pmNotifBody', {
            defaultValue: '{{name}} imported {{count}} recurring schedules{{extra}}. Assign technicians as needed.',
            name: activeProfile.name,
            count: payload.filter(p => p.plant_id === pid).length,
            extra: unmatched.length ? t('far.pmNotifBodyUnmatched', { defaultValue: ' · {{count}} not in FAR ({{justification}})', count: unmatched.length, justification: justification.trim() }) : '',
          }),
          type: unmatched.length ? 'warning' : 'info', route: '/dashboard/purchase/maint',
          actor_name: activeProfile.name, actor_role: activeProfile.role, plant_id: pid,
        });
      }
      setCreatedCount(payload.length);
      setStage('done');
      onImported();
    } catch (e) { setErr(errMsg(e)); setStage('error'); }
  }

  return (
    <div style={overlay} onClick={() => { if (stage !== 'parsing' && stage !== 'saving') close(); }}>
      <div style={modal} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{t('far.pmImportTitle', 'Import Preventive Maintenance workbook')}</div>
          <button onClick={close} style={{ border: 'none', background: 'none', fontSize: 18, cursor: 'pointer', color: '#94A3B8' }}>×</button>
        </div>
        <div style={{ fontSize: 12, color: '#94A3B8', marginBottom: 14 }}>{t('far.pmImportSubtitle', 'Every schedule is validated against the FAR. Recurring tickets generate automatically until the end date.')}</div>

        {stage === 'form' && (
          <div>
            <FactoryPicker />
            {/* Default technician — only for a single factory (the unit head can reassign later). */}
            {plantIds.length === 1 && technicians.some(tc => tc.plant_id === plantIds[0] || tc.plant_id === null) && (
              <div style={{ marginBottom: 12 }}>
                <div style={label}>{t('far.pmAssignTechLabel', 'Assign to technician (optional — unit head can change later)')}</div>
                <select value={assigneeTech} onChange={e => setAssigneeTech(e.target.value)} style={{ ...input, width: '100%' }}>
                  <option value="">{t('far.pmLeaveForUnitHead', '— Leave for unit head to assign —')}</option>
                  {[...new Set(technicians.filter(tc => tc.plant_id === plantIds[0] || tc.plant_id === null).map(tc => tc.name))].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
              <div style={{ flex: 1, minWidth: 130 }}><div style={label}>{t('far.pmStartDate', 'Start date')}</div><input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={{ ...input, width: '100%' }} /></div>
              <div style={{ flex: 1, minWidth: 130 }}><div style={label}>{t('far.pmContinueUntil', 'Continue until (optional)')}</div><input type="date" value={untilDate} onChange={e => setUntilDate(e.target.value)} style={{ ...input, width: '100%' }} /></div>
            </div>
            {err && stage === 'form' && (
              <div style={{ fontSize: 12, color: '#DC2626', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: 8, marginBottom: 10 }}>{err}</div>
            )}
            <button
              onClick={() => {
                if (!plantIds.length) {
                  setErr(t('far.pmErrSelectFactory', 'Select at least one factory this workbook belongs to.'));
                  return;
                }
                setErr(null);
                fileRef.current?.click();
              }}
              style={{ ...btnGhost, width: '100%', padding: '20px', borderStyle: 'dashed', opacity: plantIds.length ? 1 : 0.55 }}
            >
              <div style={{ fontWeight: 700, fontSize: 13, color: '#334155' }}>{t('far.pmUploadWorkbook', '⬆ Upload PM workbook (.xlsx)')}</div>
              <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 3 }}>
                {plantIds.length
                  ? t('far.pmSheetKinds', 'Daily · 7/15 Days · 1/2/3/6 Months · Yearly sheets')
                  : t('far.pmPickFactoryFirst', 'Select a factory above first, then upload the workbook.')}
              </div>
            </button>
            <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }} />
          </div>
        )}

        {stage === 'parsing' && <div style={{ fontSize: 13, color: '#475569', padding: '20px 0' }}>{t('far.pmParsing', 'Reading the workbook & matching against the FAR…')}</div>}

        {stage === 'review' && (
          <div>
            <FactoryPicker compact />
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
              <div style={{ flex: 1, minWidth: 90, background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 10, padding: '8px 12px' }}><div style={{ fontSize: 10.5, color: '#16A34A', fontWeight: 700 }}>{t('far.pmInFar', 'IN FAR')}</div><div style={{ fontSize: 18, fontWeight: 800, color: '#16A34A' }}>{matched.length}</div></div>
              <div style={{ flex: 1, minWidth: 90, background: '#FFFBEB', border: '1px solid #FED7AA', borderRadius: 10, padding: '8px 12px' }}><div style={{ fontSize: 10.5, color: '#B45309', fontWeight: 700 }}>{t('far.pmNotInFar', 'NOT IN FAR')}</div><div style={{ fontSize: 18, fontWeight: 800, color: '#B45309' }}>{unmatched.length}</div></div>
              <div style={{ flex: 1, minWidth: 90, background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 10, padding: '8px 12px' }}><div style={{ fontSize: 10.5, color: '#64748B', fontWeight: 700 }}>{t('far.pmSchedulesTile', 'SCHEDULES')}</div><div style={{ fontSize: 18, fontWeight: 800, color: '#334155' }}>{totalToCreate || rows.length}</div>{plantIds.length > 1 && <div style={{ fontSize: 10, color: '#94A3B8' }}>{t('far.pmRowsTimesPlants', { defaultValue: '{{rows}} × {{plants}} plants', rows: rows.length, plants: plantIds.length })}</div>}</div>
            </div>
            <div style={{ fontSize: 12, color: '#475569', marginBottom: 10 }}>{byFreq.map(([f, n]) => `${FREQ_LABEL[f] || f}: ${n}`).join(' · ')}{templates.length !== rows.length ? ` · ${t('far.pmAlreadyScheduled', { defaultValue: '{{count}} already scheduled (skipped)', count: templates.length - rows.length })}` : ''}</div>

            <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid #E2E8F0', borderRadius: 10 }}>
              {rows.map((r, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '7px 12px', borderBottom: i < rows.length - 1 ? '1px solid #F1F5F9' : 'none' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: '#334155', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.tpl.equipmentLabel}</div>
                    <div style={{ fontSize: 11, color: '#94A3B8' }}>{FREQ_LABEL[r.tpl.frequency] || r.tpl.frequency} · {r.tpl.checklist.length === 1 ? t('far.pmCheckpointOne', { defaultValue: '{{count}} checkpoint', count: r.tpl.checklist.length }) : t('far.pmCheckpointMany', { defaultValue: '{{count}} checkpoints', count: r.tpl.checklist.length })}</div>
                  </div>
                  {r.match
                    ? <span style={{ fontSize: 11, fontWeight: 700, color: '#16A34A', whiteSpace: 'nowrap' }}>✓ {r.match.asset.identification_mark || r.match.asset.name}{r.match.via === 'name' ? ` ${t('far.pmViaName', '(name)')}` : ''}</span>
                    : <span style={{ fontSize: 11, fontWeight: 700, color: '#B45309', whiteSpace: 'nowrap' }}>{t('far.pmNotInFarBadge', '⚠ not in FAR')}</span>}
                </div>
              ))}
              {rows.length === 0 && <div style={{ padding: 16, textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>{t('far.pmNothingNew', 'Nothing new to schedule.')}</div>}
            </div>

            {unmatched.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div style={{ ...label, color: '#B45309' }}>{t('far.pmJustificationLabel', { defaultValue: 'Justification for {{count}} equipment not in FAR *', count: unmatched.length })}</div>
                <textarea value={justification} onChange={e => setJustification(e.target.value)} rows={2} placeholder={t('far.pmJustificationPlaceholder', 'e.g. Newly installed; FAR upload pending; parser missed these — admin will reconcile.')} style={{ ...input, width: '100%', resize: 'vertical' }} />
              </div>
            )}

            {!canCreate && (
              <div style={{ fontSize: 12, color: '#B45309', marginTop: 10, fontWeight: 600 }}>
                {!plantIds.length
                  ? t('far.pmCreateBlockedNoPlant', 'Select a factory above, then tap Create.')
                  : unmatched.length && !justification.trim()
                    ? t('far.pmCreateBlockedJustification', 'Add a justification for equipment not in FAR, then tap Create.')
                    : !rows.length
                      ? t('far.pmNothingNew', 'Nothing new to schedule.')
                      : null}
              </div>
            )}
            {err && (
              <div style={{ fontSize: 12, color: '#DC2626', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: 8, marginTop: 10 }}>{err}</div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button onClick={reset} style={btnGhost}>{t('far.pmBack', 'Back')}</button>
              <button
                onClick={confirm}
                disabled={!canCreate}
                style={{ ...btnPrimary, flex: 1, opacity: canCreate ? 1 : 0.5 }}
              >
                {(totalToCreate || rows.length) === 1
                  ? t('far.pmCreateScheduleOne', { defaultValue: 'Create {{count}} schedule', count: totalToCreate || rows.length })
                  : t('far.pmCreateScheduleMany', { defaultValue: 'Create {{count}} schedules', count: totalToCreate || rows.length })}
              </button>
            </div>
          </div>
        )}

        {stage === 'saving' && <div style={{ fontSize: 13, color: '#475569', padding: '20px 0' }}>{t('far.pmCreating', 'Creating schedules…')}</div>}
        {stage === 'done' && (<div><div style={{ fontSize: 13, color: '#16A34A', marginBottom: 14 }}>{t('far.pmCreatedDone', { defaultValue: '✓ Created {{count}} recurring maintenance schedule(s).', count: createdCount })}</div><button onClick={close} style={{ ...btnPrimary, width: '100%' }}>{t('far.done', 'Done')}</button></div>)}
        {stage === 'error' && (<div><div style={{ fontSize: 13, color: '#DC2626', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: 10, marginBottom: 12 }}>{err}</div><div style={{ display: 'flex', gap: 8 }}><button onClick={() => setStage(templates.length ? 'review' : 'form')} style={{ ...btnGhost, flex: 1 }}>{t('far.pmBack', 'Back')}</button><button onClick={close} style={{ ...btnPrimary, flex: 1 }}>{t('far.pmClose', 'Close')}</button></div></div>)}
      </div>
    </div>
  );
}
