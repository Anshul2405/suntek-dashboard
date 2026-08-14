/**
 * ProductionBatchSheetForm
 *
 * Linear create flow (POC-confirmed rules):
 *   - All 3 photo slots compulsory; max 2 images each
 *   - Colour: photo primary + optional dropdown label
 *   - Heat sample = colour of finished product after heat
 *   - Stage advance (Created → Stock → Dispatched) is done by Factory Accountant elsewhere
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Camera, Check, ChevronLeft, ChevronRight, ImageUp, X } from 'lucide-react';
import { CameraCapture } from './CameraCapture';
import { uploadWorkflowImage } from '../lib/cloudinary';
import { callRpc, insertRows } from '../lib/db';
import { supabase } from '../lib/supabase';
import { usePlantScope } from '../contexts/PlantScopeContext';
import { useRoleContext } from '../contexts/RoleContext';
import { useToast } from './ui/toast';
import {
  isBatchSheetPlant,
  preferCatalogIfDbStale,
  formatReactorBatchNo,
  parseReactorBatchSeq,
  type CatalogReactor,
} from '../lib/batch/reactorCatalog';
import { BATCH_FLOW_WIZARD_EVENT, readWizardStep } from './tour/batchFlowTourSession';

type StageStep = 0 | 1 | 2 | 3;

type ReactorRow = CatalogReactor;
type PhotoKind = 'sheet' | 'bucket' | 'heat';

interface PhotoItem {
  blob: Blob;
  previewUrl: string;
}

/** Proposed colour labels for searchable reports — photo remains the source of truth. */
export const BATCH_COLOUR_OPTIONS = [
  'Water white / Colourless',
  'Pale yellow',
  'Light yellow',
  'Yellow',
  'Amber / Dark yellow',
  'Brownish',
  'Off-spec / Other',
] as const;

const MAX_PHOTOS = 2;
const STEPS = ['Reactor', 'Density', 'Photos', 'Review'] as const;

export function ProductionBatchSheetForm({
  onCreated,
}: {
  onCreated?: (batchNo: string) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { plants, plantIds, isGlobal, ready } = usePlantScope();
  const { activeProfile } = useRoleContext();

  const scopedPlants = useMemo(
    () => (isGlobal ? plants : plants.filter(p => plantIds.includes(p.id)))
      .filter(isBatchSheetPlant),
    [plants, plantIds, isGlobal],
  );

  const slotMeta: Record<PhotoKind, { label: string; hint: string }> = {
    sheet: {
      label: t('batchProd.sheetPhoto', 'Batch sheet photo'),
      hint: t('batchProd.sheetPhotoHint', 'Photograph of the physical batch sheet (1–2 photos)'),
    },
    bucket: {
      label: t('batchProd.bucketPhoto', 'Bucket / Balti photo'),
      hint: t('batchProd.bucketPhotoHint', 'Colour of product in bucket/balti (1–2 photos)'),
    },
    heat: {
      label: t('batchProd.heatPhoto', 'Heat sample photo'),
      hint: t('batchProd.heatPhotoHint', 'Colour of finished product after it has undergone heat (1–2 photos)'),
    },
  };

  const [step, setStep] = useState<StageStep>(0);
  const [plantId, setPlantId] = useState('');
  const [reactorId, setReactorId] = useState('');
  const [reactors, setReactors] = useState<ReactorRow[]>([]);
  const [usingFallbackReactors, setUsingFallbackReactors] = useState(false);
  const [density, setDensity] = useState('');
  const [colourNote, setColourNote] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [cameraKind, setCameraKind] = useState<PhotoKind | null>(null);
  const [photos, setPhotos] = useState<Record<PhotoKind, PhotoItem[]>>({
    sheet: [],
    bucket: [],
    heat: [],
  });

  useEffect(() => {
    if (!ready || plantId) return;
    if (scopedPlants.length > 0) setPlantId(scopedPlants[0].id);
  }, [ready, scopedPlants, plantId]);

  useEffect(() => {
    if (!plantId) {
      setReactors([]);
      setReactorId('');
      return;
    }
    const plant = scopedPlants.find(p => p.id === plantId) ?? plants.find(p => p.id === plantId);
    if (!plant || !isBatchSheetPlant(plant)) {
      setReactors([]);
      setReactorId('');
      setPlantId('');
      return;
    }
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('reactors')
        .select('id, plant_id, code, name, sort_order')
        .eq('plant_id', plantId)
        .eq('is_active', true)
        .order('sort_order')
        .returns<ReactorRow[]>();
      if (cancelled) return;
      const { rows, usingCatalog } = preferCatalogIfDbStale(
        plant,
        (!error && data?.length) ? data : [],
      );
      if (usingCatalog) {
        console.warn('[ProductionBatchSheet] using official P-series reactor catalogue for', plant.factory_code || plant.name);
      }
      setUsingFallbackReactors(usingCatalog);
      setReactors(rows);
      setReactorId(rows[0]?.id ?? '');
    })();
    return () => { cancelled = true; };
  }, [plantId, scopedPlants, plants]);

  // The guided tour walks all four stages, so it can park the wizard on one.
  useEffect(() => {
    const sync = () => {
      const requested = readWizardStep();
      if (requested != null) setStep(requested as StageStep);
    };
    sync();
    window.addEventListener(BATCH_FLOW_WIZARD_EVENT, sync);
    return () => window.removeEventListener(BATCH_FLOW_WIZARD_EVENT, sync);
  }, []);

  const addPhoto = useCallback((kind: PhotoKind, blob: Blob) => {
    setPhotos(prev => {
      if (prev[kind].length >= MAX_PHOTOS) return prev;
      return {
        ...prev,
        [kind]: [...prev[kind], { blob, previewUrl: URL.createObjectURL(blob) }],
      };
    });
  }, []);

  const removePhoto = useCallback((kind: PhotoKind, index: number) => {
    setPhotos(prev => {
      const next = [...prev[kind]];
      const [removed] = next.splice(index, 1);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return { ...prev, [kind]: next };
    });
  }, []);

  const clearAllPhotos = useCallback(() => {
    setPhotos(prev => {
      (Object.keys(prev) as PhotoKind[]).forEach(k => {
        prev[k].forEach(p => URL.revokeObjectURL(p.previewUrl));
      });
      return { sheet: [], bucket: [], heat: [] };
    });
  }, []);

  const selectedReactor = reactors.find(r => r.id === reactorId);
  const selectedPlant = scopedPlants.find(p => p.id === plantId);
  const densityNum = Number(density);
  const densityOk = Number.isFinite(densityNum) && densityNum > 0;
  const photosOk = photos.sheet.length >= 1 && photos.bucket.length >= 1 && photos.heat.length >= 1;

  const canNext =
    step === 0 ? !!(plantId && reactorId) :
    step === 1 ? densityOk :
    step === 2 ? photosOk :
    true;

  async function handleSubmit() {
    if (!canNext || !reactorId || !plantId || !photosOk || !densityOk) return;
    setSaving(true);
    try {
      const creator = activeProfile.name || 'Technical';
      const reactorCode = selectedReactor?.code || 'P1';

      let batchNo = '';
      let reactorSeq = 0;
      let useLegacyActiveBatches = usingFallbackReactors || reactorId.startsWith('fallback:');

      if (!useLegacyActiveBatches) {
        const { data: nums, error: allocErr } = await callRpc<{ batch_no: string; reactor_seq: number }[]>(
          'allocate_production_batch_numbers',
          { p_reactor_id: reactorId },
        );
        if (allocErr) {
          console.warn('[ProductionBatchSheet] allocate RPC missing — fallback path', allocErr.message);
          useLegacyActiveBatches = true;
        } else {
          const allocated = Array.isArray(nums) ? nums[0] : (nums as { batch_no: string; reactor_seq: number } | null);
          if (!allocated?.batch_no || allocated.reactor_seq == null) {
            useLegacyActiveBatches = true;
          } else {
            // Always encode as reactor-seq (P12-13), even if RPC still returns PBS-*.
            reactorSeq = allocated.reactor_seq;
            batchNo = formatReactorBatchNo(reactorCode, reactorSeq);
          }
        }
      }

      if (useLegacyActiveBatches) {
        // Next sequence for this reactor: scan existing sheet rows (PBS-* or P12-n).
        let maxSeq = 0;
        const { data: legacyRows } = await supabase
          .from('active_batches')
          .select('batch_no, sheet_details')
          .eq('plant_id', plantId)
          .limit(1000)
          .returns<{ batch_no: string; sheet_details: { reactorCode?: string; reactor_seq?: number } | null }[]>();
        for (const row of legacyRows ?? []) {
          const d = row.sheet_details;
          if (d?.reactorCode === reactorCode && typeof d.reactor_seq === 'number') {
            maxSeq = Math.max(maxSeq, d.reactor_seq);
          }
          const parsed = parseReactorBatchSeq(row.batch_no, reactorCode);
          if (parsed != null) maxSeq = Math.max(maxSeq, parsed);
        }
        const { data: nativeRows } = await supabase
          .from('production_batch_sheets')
          .select('batch_no, reactor_seq')
          .eq('plant_id', plantId)
          .like('batch_no', `${reactorCode}-%`)
          .limit(500)
          .returns<{ batch_no: string; reactor_seq: number }[]>();
        for (const row of nativeRows ?? []) {
          maxSeq = Math.max(maxSeq, row.reactor_seq || parseReactorBatchSeq(row.batch_no, reactorCode) || 0);
        }
        reactorSeq = maxSeq + 1;
        batchNo = formatReactorBatchNo(reactorCode, reactorSeq);
      }

      const uploadKind = async (kind: PhotoKind, items: PhotoItem[]) => {
        const urls: string[] = [];
        for (let i = 0; i < items.length; i++) {
          const r = await uploadWorkflowImage(items[i].blob, {
            workflow: 'batch',
            subfolder: batchNo,
            entityId: batchNo,
            kind: `${kind === 'sheet' ? 'batch-sheet' : kind === 'bucket' ? 'bucket-balti' : 'heat-sample'}-${i + 1}`,
            creator,
            plant: selectedPlant?.name,
          });
          urls.push(r.secure_url);
        }
        return urls;
      };

      const [sheetUrls, bucketUrls, heatUrls] = await Promise.all([
        uploadKind('sheet', photos.sheet),
        uploadKind('bucket', photos.bucket),
        uploadKind('heat', photos.heat),
      ]);

      if (useLegacyActiveBatches) {
        const { error: insertErr } = await insertRows('active_batches', {
          plant_id: plantId,
          batch_no: batchNo,
          status: 'closed',
          recipe: `${reactorCode} · density ${densityNum}`,
          target_qty: densityNum,
          final_gravity: densityNum,
          operator_name: creator,
          sheet_image_url: sheetUrls[0] || null,
          sheet_details: {
            stage: 'created',
            reactorCode,
            reactor_seq: reactorSeq,
            density: densityNum,
            colourNote: colourNote || null,
            notes: notes.trim() || null,
            sheet_photo_urls: sheetUrls,
            bucket_photo_urls: bucketUrls,
            heat_sample_photo_urls: heatUrls,
            created_by_name: creator,
          },
        });
        if (insertErr) throw insertErr;
      } else {
        const { error: insertErr } = await insertRows('production_batch_sheets', {
          batch_no: batchNo,
          reactor_id: reactorId,
          reactor_seq: reactorSeq,
          plant_id: plantId,
          density: densityNum,
          sheet_photo_urls: sheetUrls,
          bucket_photo_urls: bucketUrls,
          heat_sample_photo_urls: heatUrls,
          colour_note: colourNote || null,
          stage: 'created',
          notes: notes.trim() || null,
          created_by_name: creator,
        });
        if (insertErr) throw insertErr;
      }

      toast.success(
        t('batchProd.createdSuccess', {
          defaultValue: 'Batch {{batchNo}} created',
          batchNo,
          seq: reactorSeq,
        }),
      );

      clearAllPhotos();
      setDensity('');
      setColourNote('');
      setNotes('');
      setStep(0);
      onCreated?.(batchNo);
    } catch (e) {
      console.error(e);
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl flex flex-col gap-5">
      <div className="flex items-center gap-1" data-tour="tour-wizard-steps">
        {STEPS.map((label, i) => {
          const done = i < step;
          const active = i === step;
          return (
            <React.Fragment key={label}>
              {i > 0 && <div className={`h-0.5 flex-1 ${done || active ? 'bg-amber-500' : 'bg-slate-200'}`} />}
              <div
                className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold tracking-wide ${
                  active ? 'bg-amber-500 text-white' :
                  done ? 'bg-amber-100 text-amber-800' :
                  'bg-slate-100 text-slate-400'
                }`}
              >
                {done ? <Check size={12} strokeWidth={3} /> : <span>{i + 1}</span>}
                <span className="hidden sm:inline">{label}</span>
              </div>
            </React.Fragment>
          );
        })}
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        {step === 0 && (
          <div className="flex flex-col gap-4" data-tour="tour-wizard-reactor">
            <div>
              <div className="text-sm font-bold text-slate-800">{t('batchProd.stepReactor', 'Select plant & reactor')}</div>
              <p className="mt-1 text-xs text-slate-500">
                {t('batchProd.stepReactorHint', 'Each reactor keeps its own sequence. Batch number = reactor + sequence (e.g. P12-13).')}
              </p>
            </div>
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Plant</span>
              <select
                value={plantId}
                onChange={e => setPlantId(e.target.value)}
                className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-medium text-slate-800 outline-none focus:border-amber-400"
              >
                {scopedPlants.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Reactor</span>
              {reactors.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-200 px-3 py-4 text-xs text-slate-400">
                  {t('batchProd.noReactors', 'No reactors for this plant. Run migration 0009 / query 81 first.')}
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {reactors.map(r => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setReactorId(r.id)}
                      className={`rounded-xl border px-3 py-3 text-left transition ${
                        reactorId === r.id
                          ? 'border-amber-500 bg-amber-50 shadow-sm'
                          : 'border-slate-200 bg-slate-50 hover:border-slate-300'
                      }`}
                    >
                      <div className="text-xs font-bold text-slate-800">{r.code}</div>
                      <div className="text-[11px] text-slate-500">{r.name}</div>
                    </button>
                  ))}
                </div>
              )}
              {usingFallbackReactors && (
                <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-2 py-1.5">
                  {t(
                    'batchProd.reactorCatalogNote',
                    'Using official reactor IDs (P1–P49 by plant). Sheets save to active batches until the reactors table is seeded.',
                  )}
                </p>
              )}
            </label>
          </div>
        )}

        {step === 1 && (
          <div className="flex flex-col gap-4" data-tour="tour-wizard-density">
            <div>
              <div className="text-sm font-bold text-slate-800">{t('batchProd.stepDensity', 'Record density & colour')}</div>
              <p className="mt-1 text-xs text-slate-500">
                {t('batchProd.stepDensityHint', 'Density is required. Colour label is optional — photos remain the main evidence.')}
              </p>
            </div>
            <div className="rounded-xl bg-slate-50 border border-slate-100 px-3 py-2 text-xs text-slate-600">
              {selectedPlant?.name ?? '—'} · {selectedReactor ? `${selectedReactor.code} (${selectedReactor.name})` : '—'}
            </div>
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Density *</span>
              <input
                type="number"
                inputMode="decimal"
                value={density}
                onChange={e => setDensity(e.target.value)}
                placeholder="e.g. 1400"
                className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-800 outline-none focus:border-amber-400"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Colour label (optional)</span>
              <select
                value={colourNote}
                onChange={e => setColourNote(e.target.value)}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-amber-400"
              >
                <option value="">— Select if useful for reports —</option>
                {BATCH_COLOUR_OPTIONS.map(opt => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
              <span className="text-[10px] text-slate-400">
                Proposed options for search/reports. Confirm with plant if these labels need changing.
              </span>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Notes (optional)</span>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                rows={3}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-amber-400 resize-none"
              />
            </label>
          </div>
        )}

        {step === 2 && (
          <div className="flex flex-col gap-4" data-tour="tour-wizard-photos">
            <div>
              <div className="text-sm font-bold text-slate-800">{t('batchProd.stepPhotos', 'Evidence photos')}</div>
              <p className="mt-1 text-xs text-slate-500">
                {t('batchProd.stepPhotosHint', 'All three slots required. Maximum 2 photos per slot.')}
              </p>
            </div>
            {(Object.keys(slotMeta) as PhotoKind[]).map(kind => {
              const items = photos[kind];
              const meta = slotMeta[kind];
              return (
                <div key={kind} className="rounded-xl border border-slate-200 p-3">
                  <div className="text-xs font-bold text-slate-800">{meta.label} *</div>
                  <div className="text-[11px] text-slate-500 mb-2">{meta.hint}</div>
                  {items.length > 0 && (
                    <div className="mb-2 grid grid-cols-2 gap-2">
                      {items.map((item, idx) => (
                        <div key={item.previewUrl} className="relative">
                          <img src={item.previewUrl} alt={`${meta.label} ${idx + 1}`} className="h-28 w-full rounded-lg object-cover border border-slate-100" />
                          <button
                            type="button"
                            onClick={() => removePhoto(kind, idx)}
                            className="absolute top-1 right-1 rounded-full bg-white/90 p-1 text-slate-500 hover:text-red-500 shadow"
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {items.length < MAX_PHOTOS && (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setCameraKind(kind)}
                        className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-slate-900 px-3 py-2.5 text-xs font-bold text-white"
                      >
                        <Camera size={14} /> Camera
                      </button>
                      <label className="flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl border border-slate-200 px-3 py-2.5 text-xs font-bold text-slate-600 hover:bg-slate-50">
                        <ImageUp size={14} /> Upload
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
                          className="hidden"
                          onChange={e => {
                            const f = e.target.files?.[0];
                            if (f) addPhoto(kind, f);
                            e.target.value = '';
                          }}
                        />
                      </label>
                    </div>
                  )}
                  <div className="mt-1.5 text-[10px] text-slate-400">{items.length}/{MAX_PHOTOS} photos</div>
                </div>
              );
            })}
          </div>
        )}

        {step === 3 && (
          <div className="flex flex-col gap-4" data-tour="tour-wizard-review">
            <div>
              <div className="text-sm font-bold text-slate-800">{t('batchProd.stepReview', 'Review & submit')}</div>
              <p className="mt-1 text-xs text-slate-500">
                {t('batchProd.stepReviewHint', 'Submitting assigns the next number for this reactor (e.g. P12-13). Factory accountant moves stage later.')}
              </p>
            </div>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-xl bg-slate-50 px-3 py-2">
                <dt className="text-[10px] font-bold uppercase text-slate-400">Plant</dt>
                <dd className="font-semibold text-slate-800">{selectedPlant?.name ?? '—'}</dd>
              </div>
              <div className="rounded-xl bg-slate-50 px-3 py-2">
                <dt className="text-[10px] font-bold uppercase text-slate-400">Reactor</dt>
                <dd className="font-semibold text-slate-800">{selectedReactor ? `${selectedReactor.code}` : '—'}</dd>
              </div>
              <div className="rounded-xl bg-slate-50 px-3 py-2">
                <dt className="text-[10px] font-bold uppercase text-slate-400">Density</dt>
                <dd className="font-semibold text-slate-800">{density}</dd>
              </div>
              <div className="rounded-xl bg-slate-50 px-3 py-2">
                <dt className="text-[10px] font-bold uppercase text-slate-400">Colour</dt>
                <dd className="font-semibold text-slate-800 text-xs">{colourNote || 'Photo only'}</dd>
              </div>
            </dl>
            <div className="text-xs text-slate-500">
              Photos: sheet {photos.sheet.length} · bucket {photos.bucket.length} · heat {photos.heat.length}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {(Object.keys(photos) as PhotoKind[]).flatMap(kind =>
                photos[kind].map(p => (
                  <img key={p.previewUrl} src={p.previewUrl} alt={kind} className="h-20 w-full rounded-lg object-cover border border-slate-100" />
                )),
              )}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={step === 0 || saving}
          onClick={() => setStep(s => (s > 0 ? ((s - 1) as StageStep) : s))}
          className="inline-flex items-center gap-1 rounded-xl border border-slate-200 px-4 py-2.5 text-xs font-bold text-slate-600 disabled:opacity-40"
        >
          <ChevronLeft size={14} /> Back
        </button>
        <div className="flex-1" />
        {step < 3 ? (
          <button
            type="button"
            disabled={!canNext}
            onClick={() => setStep(s => ((s + 1) as StageStep))}
            className="inline-flex items-center gap-1 rounded-xl bg-amber-500 px-5 py-2.5 text-xs font-bold text-white disabled:opacity-40"
          >
            Next <ChevronRight size={14} />
          </button>
        ) : (
          <button
            type="button"
            disabled={saving || !photosOk || !densityOk}
            onClick={handleSubmit}
            className="inline-flex items-center gap-1 rounded-xl bg-emerald-600 px-5 py-2.5 text-xs font-bold text-white disabled:opacity-40"
          >
            {saving ? t('batchProd.saving', 'Creating…') : t('batchProd.submit', 'Create batch sheet')}
          </button>
        )}
      </div>

      <CameraCapture
        open={cameraKind !== null}
        onClose={() => setCameraKind(null)}
        title={cameraKind ? slotMeta[cameraKind].label : undefined}
        onCapture={blob => {
          if (cameraKind) addPhoto(cameraKind, blob);
          setCameraKind(null);
        }}
      />
    </div>
  );
}
