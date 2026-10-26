import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ListChecks, Package, Recycle, Plus } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { fetchActivePlants } from '../../../lib/plants';
import { displayLocationName } from '../../../lib/plantLabels';
import { insertRows, updateRows } from '../../../lib/db';
import { useMentionNotifier } from '../../../lib/mentions';
import { useBlacklistGuard } from '../../../lib/blacklist/guard';
import { SlidePanel, PanelField, PanelInput, PanelSelect, PanelTextarea, PanelRow, PanelDivider, OcrUpload, PanelFooter } from '../../../components/SlidePanel';
import { KpiInfoButton } from '../../../components/KpiInfoButton';
import { useToast } from '../../../components/ui/toast';
import { SkeletonRows, ErrorState, EmptyState } from '../../../components/ui/states';
import { ImageLightbox, type LightboxImage } from '../../../components/ui/ImageLightbox';
import { usePagination } from '../../../components/ui/usePagination';
import { useSortable } from '../../../components/ui/useSortable';
import { SegmentTabs, SectionCard, ButtonV2, TablePaginationV2, ThV2 as Th } from '../../../components/v2';
import { TableSearch, useTextFilter } from '../../../components/ui/TableSearch';
import { usePlantScope } from '../../../contexts/PlantScopeContext';
import { useRoleContext } from '../../../contexts/RoleContext';
import { isAdminProfile } from '../../../lib/profiles';
import { canDeleteModule, recordAudit, useOpsSettings } from '../../../lib/opsControls';
import { BUYER_TYPES, loadBuyers, saveBuyers, type BuyerPerson } from '../../../lib/procurementPeople';
import { withEmbedFallback } from '../../../lib/scopedList';
import { StockRegister } from './StockRegister';
import { RepairScrapPanel } from './RepairScrapPanel';
import { PhotoUploader } from './maintenance/shared';
import { issueLineValue, storeIssueNeedsPhoto } from '../../../lib/store/issuePhoto';
import type { Database } from '../../../lib/database.types';

// ticket_id is added by migration NN_requisition_ticket_link.sql; typed here until
// database.types.ts is regenerated so requisitions raised from a maintenance ticket
// can deep-link back to it.
type ReqRow = Database['public']['Tables']['store_requisitions']['Row']
  & { plants?: { name: string | null } | null; ticket_id?: string | null };

function PicBadge({ url, onOpen }: { url: string | null; onOpen: () => void }) {
  const { t } = useTranslation();
  const Icon = (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
      <circle cx="12" cy="13" r="4"/>
    </svg>
  );
  if (!url) return <span className="pic-badge missing" title={t('storereq.no_pic_yet')}>{Icon}</span>;
  return (
    <button type="button" className="pic-badge" title={t('storereq.pic_on_file')} onClick={onOpen}
      style={{ cursor: 'pointer', border: 'none', background: 'none', padding: 0, color: 'inherit' }}>
      {Icon}
    </button>
  );
}

const UNITS  = ['nos', 'feet', 'kg', 'L', 'sets', 'MT', 'boxes'];

const URGENCY_MAP: Record<string, 'low' | 'medium' | 'high' | 'plant_stopper'> = {
  Normal: 'medium',
  Urgent: 'high',
};

const STATUS_STAGE: Record<string, { bg: string; color: string; label: string }> = {
  pending:           { bg: '#FEF3C7', color: '#D97706', label: 'UNIT HEAD' },
  pending_store:     { bg: '#FEF3C7', color: '#A16207', label: 'STORE CHECK' },
  issued:            { bg: '#DCFCE7', color: '#15803D', label: 'ISSUED' },
  pending_approval:  { bg: '#FEF9C3', color: '#A16207', label: 'APPROVAL' },
  pending_vijay:     { bg: '#FEF9C3', color: '#A16207', label: 'VIJAY JI' },
  pending_buyer:     { bg: '#FFEDD5', color: '#C2410C', label: 'BUYER' },
  in_transit:        { bg: '#FFF3E6', color: '#D84315', label: 'IN TRANSIT' },
  approved:          { bg: '#DCFCE7', color: '#16A34A', label: 'APPROVED' },
  dispatched:        { bg: '#F3EFE8', color: '#161616', label: 'DISPATCHED' },
  received:          { bg: '#DCFCE7', color: '#16A34A', label: 'RECEIVED' },
  rejected:          { bg: '#FEE2E2', color: '#DC2626', label: 'REJECTED' },
};

const WAITING = ['pending', 'pending_store', 'pending_approval', 'pending_vijay', 'pending_buyer'];

type StoreTab = 'requirements' | 'stock' | 'scrap';

export function StoreRequisitions() {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  // ?tab= keeps the active tab deep-linkable (single route → no RBAC change).
  const [searchParams, setSearchParams] = useSearchParams();
  const { activeProfile, activePersonId } = useRoleContext();
  const isTechnical =
    activeProfile.id === 'factory_operator' || activeProfile.baseRoleId === 'factory_operator';
  const rawTab = searchParams.get('tab');
  // Meet Aug 2026: Technical only sees Stock Register under Store Req.
  const tab: StoreTab = isTechnical
    ? 'stock'
    : (rawTab === 'stock' || rawTab === 'scrap' ? rawTab : 'requirements');
  const setTab = (k: StoreTab) => {
    if (isTechnical && k !== 'stock') return;
    setSearchParams(prev => { const p = new URLSearchParams(prev); p.set('tab', k); return p; }, { replace: true });
  };
  const notifyMentions = useMentionNotifier();
  const screenBlacklist = useBlacklistGuard();
  const { scopeQuery, allowedPlants } = usePlantScope();
  const ops = useOpsSettings();
  const canDeleteReq = canDeleteModule(ops, activeProfile, 'store_req', activePersonId);
  const roleKey = activeProfile.baseRoleId || activeProfile.id;
  const isAdmin = isAdminProfile(activeProfile);
  const isStore = isAdmin || roleKey.startsWith('store_manager') || roleKey === 'warehouse_manager';
  const isUnitHead = isAdmin || roleKey === 'unit_head';
  const nameHas = (needle: string) => activeProfile.name.toLowerCase().includes(needle.toLowerCase().split(' ')[0]);
  const canDecideReq =
    isAdmin ||
    isUnitHead ||
    roleKey === 'management' ||
    (activeProfile.capabilities || []).includes('manage_users');
  const [buyers, setBuyers] = useState<BuyerPerson[]>([]);
  const [buyerDraft, setBuyerDraft] = useState<BuyerPerson[]>([]);
  const [editingBuyers, setEditingBuyers] = useState(false);
  const [routeForm, setRouteForm] = useState({ approver: 'unit_head', buyer: '' });
  const [transit, setTransit] = useState({ supplier: '', vehicle: '' });
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [items, setItems] = useState<ReqRow[]>([]);
  const [dbPlants, setDbPlants] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState('');
  const [plantFilter, setPlantFilter] = useState('all');
  const [queue, setQueue] = useState<'all' | 'pending' | 'ready' | 'urgent'>('all');
  const [lightbox, setLightbox] = useState<LightboxImage[] | null>(null);

  // Apply ?q= / ?queue= links once per new value, so opening a request or
  // switching tabs does not undo what the user picked since.
  const seenLink = useRef<{ q?: string; queue?: string | null }>({});
  useEffect(() => {
    const q = (searchParams.get('q') || '').trim();
    if (q && tab !== 'stock' && q !== seenLink.current.q) { seenLink.current.q = q; setSearch(q); }
    const queued = searchParams.get('queue');
    if (queued !== seenLink.current.queue) {
      seenLink.current.queue = queued;
      if (queued === 'pending' || queued === 'ready' || queued === 'urgent' || queued === 'all') setQueue(queued);
    }
  }, [searchParams, tab]);
  // Row click → requisition detail panel (rows with a linked ticket jump straight to it).
  const [detailReq, setDetailReq] = useState<ReqRow | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [form, setForm] = useState({ item: '', plant: '', qty: '', unit: 'nos', priority: 'Normal', notes: '' });
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [issuePhotoBlob, setIssuePhotoBlob] = useState<Blob | null>(null);

  function openRow(r: ReqRow) {
    if (r.ticket_id) navigate(`/dashboard/purchase/maint?ticket=${r.ticket_id}`);
    else setDetailReq(r);
  }

  const plantScoped = useMemo(
    () => items.filter(r => plantFilter === 'all' || r.plant_id === plantFilter),
    [items, plantFilter],
  );
  const queued = useMemo(() => plantScoped.filter(r => {
    if (queue === 'pending') return WAITING.includes(r.status);
    if (queue === 'ready') return r.status === 'approved' || r.status === 'dispatched' || r.status === 'in_transit' || r.status === 'issued';
    if (queue === 'urgent') return r.urgency === 'high' || r.urgency === 'plant_stopper';
    return true;
  }), [plantScoped, queue]);
  const filtered = useTextFilter(queued, search, r => [r.item, displayLocationName(r.plants?.name), r.plants?.name, r.id.slice(0, 8), r.status, r.ticket_id ? r.ticket_id.slice(0, 8) : '']);
  const reqSort = useSortable(filtered, {
    reqno: r => r.id,
    ticket: r => r.ticket_id ?? null,
    item: r => r.item,
    plant: r => displayLocationName(r.plants?.name),
    qty: r => r.qty,
    stage: r => r.status,
  });
  const { pageRows, controls } = usePagination(reqSort.sorted, { resetKey: `${search}|${plantFilter}|${queue}|${reqSort.sort.key}|${reqSort.sort.dir}` });
  // Summary tiles — plant filter only (not search). plantScopeLabel set after plantOptions below.
  const pendingCount = plantScoped.filter(r => WAITING.includes(r.status)).length;
  const readyCount = plantScoped.filter(r => ['approved', 'dispatched', 'in_transit', 'issued'].includes(r.status)).length;
  const urgentCount = plantScoped.filter(r => ['high', 'plant_stopper'].includes(r.urgency ?? '')).length;

  async function load() {
    try {
      const { data: plantsData } = await fetchActivePlants<{ id: string; name: string }>('id, name');
      if (plantsData && plantsData.length > 0) setDbPlants(plantsData);

      const { data, error } = await withEmbedFallback(
        scopeQuery(supabase.from('store_requisitions').select('*, plants(name)'), { unitCol: 'unit_id' }).order('created_at', { ascending: false }).returns<ReqRow[]>(),
        () => scopeQuery(supabase.from('store_requisitions').select('*'), { unitCol: 'unit_id' }).order('created_at', { ascending: false }).returns<ReqRow[]>(),
        'StoreRequisitions.list',
      );
      if (error) throw error;
      setItems(data || []);
      setLoadError(false);
    } catch (err) {
      console.error('[StoreRequisitions] load failed', err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [scopeQuery]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const id = searchParams.get('req');
    if (!id || items.length === 0) return;
    const row = items.find(r => r.id === id);
    if (row) setDetailReq(row);
  }, [searchParams, items]);
  useEffect(() => {
    void loadBuyers().then(list => {
      setBuyers(list);
      setBuyerDraft(list);
      setRouteForm(f => ({ ...f, buyer: f.buyer || list[0]?.name || '' }));
    });
  }, []);

  // Restrict the plant picker to the user's allowed plants (all if global).
  // Factory options from the DB, restricted to the user's own. No hard-coded
  // fallback: after a rename it would offer names that no longer exist. The
  // form stores the plant ID, so a rename cannot orphan an in-flight request.
  const plantOptions = useMemo(
    () => [...(allowedPlants.length > 0 ? allowedPlants : dbPlants)].sort((a, b) => a.name.localeCompare(b.name)),
    [allowedPlants, dbPlants],
  );
  const plantScopeLabel = plantFilter === 'all'
    ? t('common.allPlants')
    : (displayLocationName(plantOptions.find(p => p.id === plantFilter)?.name) || t('common.allPlants'));

  function set(k: string, v: string) { setForm(f => ({ ...f, [k]: v })); }

  async function handleSave() {
    if (!form.item.trim() || !form.qty) return;
    const plant = dbPlants.find(p => p.id === form.plant);
    let photoUrl: string | null = null;
    if (proofFile) {
      try {
        const { shrinkPhoto, uploadWorkflowImage } = await import('../../../lib/cloudinary');
        const blob = proofFile.type.startsWith('image/') ? await shrinkPhoto(proofFile) : proofFile;
        const up = await uploadWorkflowImage(blob, { workflow: 'store-req', kind: 'proof', creator: activeProfile.name, plant: plant?.name });
        photoUrl = up.secure_url;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('storereq.photoFailed', 'The photo could not be uploaded.'));
        return;
      }
    }
    const { data, error } = await insertRows('store_requisitions', {
      item: form.item,
      plant_id: plant?.id || null,
      qty: parseFloat(form.qty) || 0,
      urgency: URGENCY_MAP[form.priority] || 'medium',
      status: 'pending_store',
      photo_url: photoUrl,
      remarks: [form.unit ? `Unit: ${form.unit}` : '', form.notes].filter(Boolean).join(' · ') || null,
    }).select('*, plants(name)').single();

    if (error) {
      toast.error(t('storereq.save_failed', { message: error.message }));
      return;
    }
    if (data) {
      setItems(prev => [data as ReqRow, ...prev]);
      // Notify admin and unit head
      insertRows('notifications', {
        target_roles: ['admin', 'store_manager_maint', 'warehouse_manager'],
        title: t('storereq.notif_title', { item: form.item }),
        body: `${plant?.name ?? ''} · ${t('storereq.qty_label')}: ${form.qty} ${form.unit} · ${form.priority}`,
        type: form.priority === 'Urgent' ? 'urgent' : 'info',
        route: '/dashboard/purchase/storereq',
        actor_name: plant?.name ?? '',
        actor_role: 'warehouse_manager',
        read_by: [],
        plant_id: plant?.id || null, // deliver only to this plant's unit head + admin
      }).then(() => {}, () => {});
      await notifyMentions(form.notes, {
        entityType: 'store_requisition', entityId: (data as ReqRow).id,
        entityLabel: t('storereq.entity_label', { item: form.item }), route: '/dashboard/purchase/storereq',
      });
    }
    const hits = await screenBlacklist(
      [{ value: form.item, label: 'Item' }, { value: form.notes, label: 'Notes' }],
      { workflow: 'Store Requisition', source: 'entry', entityLabel: `Store req · ${form.item}` },
    );
    if (hits.length) {
      const h = hits[0];
      toast.error(t('storereq.blacklist_alert', { value: h.candidate.value, type: h.entry.type, name: h.entry.name, pct: Math.round(h.score * 100) }));
    }
    setSaved(true);
    setTimeout(() => { setOpen(false); setSaved(false); setProofFile(null); setForm({ item: '', plant: '', qty: '', unit: 'nos', priority: 'Normal', notes: '' }); }, 1600);
  }

  function handleClose() { setOpen(false); setSaved(false); }

  function patchRow(id: string, patch: Partial<ReqRow>) {
    setItems(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r));
    setDetailReq(prev => prev && prev.id === id ? { ...prev, ...patch } : prev);
  }

  async function notifyRoles(roles: string[], title: string, row: ReqRow) {
    await insertRows('notifications', {
      target_roles: roles,
      title,
      body: `${row.item} · qty ${row.qty}`,
      type: 'info',
      route: '/dashboard/purchase/storereq',
      actor_name: activeProfile.name,
      actor_role: roleKey,
      read_by: [],
      plant_id: row.plant_id,
    });
  }

  async function notifyPerson(name: string, title: string, row: ReqRow) {
    const token = name.trim().split(/\s+/)[0];
    if (!token) return;
    const { data } = await supabase.from('user_accounts')
      .select('id, name')
      .ilike('name', `${token}%`)
      .eq('is_active', true)
      .eq('is_deleted', false)
      .limit(8)
      .returns<{ id: string; name: string }[]>();
    const ids = (data || [])
      .filter(p => p.name.toLowerCase().startsWith(token.toLowerCase()))
      .map(p => p.id);
    if (!ids.length) return;
    await insertRows('notifications', {
      target_roles: ids,
      title,
      body: `${row.item} · qty ${row.qty}`,
      type: 'info',
      route: '/dashboard/purchase/storereq',
      actor_name: activeProfile.name,
      actor_role: roleKey,
      scope: 'personal',
      plant_id: row.plant_id,
    });
  }

  async function issueFromStock(row: ReqRow) {
    setDeciding(true);
    try {
      let issueValue: number | null = null;
      const { data: lastBuy } = await supabase.from('stock_purchase_lines')
        .select('amount, unit_price, qty')
        .ilike('item_name', row.item)
        .order('created_at', { ascending: false })
        .limit(1)
        .returns<{ amount: number | null; unit_price: number | null; qty: number | null }[]>();
      const buy = lastBuy?.[0];
      if (buy) issueValue = issueLineValue(buy.amount, buy.unit_price, row.qty);
      if (storeIssueNeedsPhoto(issueValue) && !issuePhotoBlob) {
        toast.error(t('storereq.issuePhotoRequired', 'Photo is required when issuing material worth more than ₹1,000.'));
        return;
      }
      let issuePhotoUrl: string | null = null;
      if (issuePhotoBlob) {
        try {
          const { shrinkPhoto, uploadWorkflowImage } = await import('../../../lib/cloudinary');
          const blob = issuePhotoBlob.type?.startsWith('image/') ? await shrinkPhoto(issuePhotoBlob) : issuePhotoBlob;
          const up = await uploadWorkflowImage(blob, { workflow: 'store-req', kind: 'issue', creator: activeProfile.name });
          issuePhotoUrl = up.secure_url;
        } catch (err) {
          toast.error(err instanceof Error ? err.message : t('storereq.photoFailed', 'The photo could not be uploaded.'));
          return;
        }
      }
      if (row.plant_id) {
        const { data: found } = await supabase.from('store_items')
          .select('id, on_hand, issued_qty')
          .eq('plant_id', row.plant_id)
          .ilike('item_name', row.item)
          .limit(1)
          .returns<{ id: string; on_hand: number; issued_qty: number }[]>();
        const hit = found?.[0];
        if (!hit || Number(hit.on_hand) < Number(row.qty)) {
          toast.error(t('storereq.notEnough', 'This item is not in stock in that quantity. Send it for purchase instead.'));
          return;
        }
        await updateRows('store_items', {
          on_hand: Number(hit.on_hand) - Number(row.qty),
          issued_qty: Number(hit.issued_qty) + Number(row.qty),
        }).eq('id', hit.id);
      } else {
        toast.error(t('storereq.notEnough', 'This item is not in stock in that quantity. Send it for purchase instead.'));
        return;
      }
      const patch: Partial<ReqRow> = {
        status: 'issued',
        ...(issuePhotoUrl && !row.photo_url ? { photo_url: issuePhotoUrl } : {}),
        ...(issuePhotoUrl && row.photo_url ? { remarks: [row.remarks, `Issue photo: ${issuePhotoUrl}`].filter(Boolean).join(' · ') } : {}),
      };
      const { error } = await updateRows('store_requisitions', patch).eq('id', row.id);
      if (error) { toast.error(error.message); return; }
      patchRow(row.id, patch);
      setIssuePhotoBlob(null);
      toast.success(t('storereq.issuedOk', 'Issued from stock'));
    } finally { setDeciding(false); }
  }

  async function sendForPurchase(row: ReqRow) {
    if (!routeForm.buyer) { toast.error(t('storereq.pickBuyer', 'Choose who will buy this')); return; }
    setDeciding(true);
    try {
      const patch = { status: 'pending_approval' as const, approver_key: routeForm.approver, buyer_name: routeForm.buyer };
      const { error } = await updateRows('store_requisitions', patch).eq('id', row.id);
      if (error) { toast.error(error.message); return; }
      patchRow(row.id, patch);
      const who = routeForm.approver === 'naresh' ? 'Naresh ji' : 'Unit head';
      await notifyRoles(routeForm.approver === 'naresh' ? ['admin', 'management'] : ['unit_head', 'admin'], `${who}: approve ${row.item}`, row);
      if (routeForm.approver === 'naresh') await notifyPerson('Naresh', `${who}: approve ${row.item}`, row);
      toast.success(t('storereq.sentApproval', 'Sent for approval'));
    } finally { setDeciding(false); }
  }

  async function approverOk(row: ReqRow) {
    setDeciding(true);
    try {
      const { error } = await updateRows('store_requisitions', { status: 'pending_vijay' }).eq('id', row.id);
      if (error) { toast.error(error.message); return; }
      patchRow(row.id, { status: 'pending_vijay' });
      await notifyRoles(['admin', 'management', 'unit_head'], `Vijay ji: ${row.item} is approved`, row);
      await notifyPerson('Vijay', `Vijay ji: ${row.item} is approved`, row);
      toast.success(t('storereq.toVijay', 'Approved. It now goes to Vijay ji.'));
    } finally { setDeciding(false); }
  }

  async function vijayOk(row: ReqRow) {
    setDeciding(true);
    try {
      const { error } = await updateRows('store_requisitions', { status: 'pending_buyer' }).eq('id', row.id);
      if (error) { toast.error(error.message); return; }
      patchRow(row.id, { status: 'pending_buyer' });
      await notifyRoles(['admin', 'purchase_manager'], `${row.buyer_name || 'Buyer'}: procure ${row.item}`, row);
      if (row.buyer_name) await notifyPerson(row.buyer_name, `${row.buyer_name}: procure ${row.item}`, row);
      toast.success(t('storereq.toBuyer', 'Sent to the buyer'));
    } finally { setDeciding(false); }
  }

  async function markTransit(row: ReqRow) {
    if (!transit.supplier.trim() || !transit.vehicle.trim()) {
      toast.error(t('storereq.transitNeed', 'Supplier and vehicle number are required'));
      return;
    }
    setDeciding(true);
    try {
      const { data, error } = await insertRows('dispatch_logs', {
        destination: row.plants?.name || null,
        date: new Date().toISOString().slice(0, 10),
        item: row.item,
        vehicle_no: transit.vehicle.trim(),
        supplier: transit.supplier.trim(),
        sender: activeProfile.name,
        remarks: `Requirement #${row.id.slice(0, 8)}`,
        document_ref: null,
        receiver: null,
        from_location: null,
        receive_date: null,
      }).select('id').single();
      if (error) { toast.error(error.message); return; }
      const patch = {
        status: 'in_transit' as const,
        supplier: transit.supplier.trim(),
        vehicle_no: transit.vehicle.trim(),
        dispatch_id: (data as { id: string } | null)?.id ?? null,
      };
      const saved = await updateRows('store_requisitions', patch).eq('id', row.id);
      if (saved.error) { toast.error(saved.error.message); return; }
      patchRow(row.id, patch);
      await notifyRoles(['admin', 'store_manager_maint', 'warehouse_manager'], `In transit: ${row.item}`, row);
      toast.success(t('storereq.transitOk', 'Marked in transit and added to the dispatch sheet'));
    } finally { setDeciding(false); }
  }

  async function markReceived(row: ReqRow) {
    setDeciding(true);
    try {
      if (row.plant_id) {
        const { data: found } = await supabase.from('store_items')
          .select('id, on_hand, procured_qty')
          .eq('plant_id', row.plant_id)
          .ilike('item_name', row.item)
          .limit(1)
          .returns<{ id: string; on_hand: number; procured_qty: number }[]>();
        const hit = found?.[0];
        if (hit) {
          await updateRows('store_items', {
            on_hand: Number(hit.on_hand) + Number(row.qty),
            procured_qty: Number(hit.procured_qty) + Number(row.qty),
          }).eq('id', hit.id);
        } else {
          const created = await insertRows('store_items', {
            plant_id: row.plant_id,
            item_name: row.item,
            on_hand: Number(row.qty),
            procured_qty: Number(row.qty),
            baseline_qty: 0,
            issued_qty: 0,
            manual_delta: 0,
            unit: 'nos',
            ticket_procured_qty: 0,
            repaired_qty: 0,
            reserved_qty: 0,
          });
          if (created.error) { toast.error(created.error.message); return; }
        }
      }
      const { error } = await updateRows('store_requisitions', { status: 'received' }).eq('id', row.id);
      if (error) { toast.error(error.message); return; }
      patchRow(row.id, { status: 'received' });
      toast.success(t('storereq.receivedOk', 'Received and added to the stock register'));
    } finally { setDeciding(false); }
  }

  function waitingOn(r: ReqRow) {
    if (r.status === 'pending_store') return t('storereq.waitStore', 'Store');
    if (r.status === 'pending_approval') return r.approver_key === 'naresh' ? 'Naresh ji' : t('storereq.awaiting_unit_head');
    if (r.status === 'pending_vijay') return 'Vijay ji';
    if (r.status === 'pending_buyer') return r.buyer_name || t('storereq.waitBuyer', 'Buyer');
    if (r.status === 'in_transit') return t('storereq.waitReceive', 'Store to receive');
    if (r.status === 'pending') return t('storereq.awaiting_unit_head');
    return '—';
  }

  async function saveBuyerList() {
    const err = await saveBuyers(buyerDraft, activeProfile.name);
    if (err) { toast.error(err); return; }
    setBuyers(buyerDraft.filter(p => p.name.trim()));
    setEditingBuyers(false);
    toast.success(t('storereq.buyersSaved', 'Buyer list saved'));
  }

  async function deleteReq(row: ReqRow) {
    if (!canDeleteReq || deletingId) return;
    const ok = window.confirm(t('storereq.deleteConfirm', {
      defaultValue: 'Delete the request for {{item}}? A linked maintenance ticket is left as it is.',
      item: row.item,
    }));
    if (!ok) return;
    setDeletingId(row.id);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase.from('store_requisitions') as any).delete().eq('id', row.id);
      if (error) {
        toast.error(t('storereq.deleteFailed', { defaultValue: 'Could not delete this request. {{message}}', message: error.message }));
        return;
      }
      setItems(prev => prev.filter(r => r.id !== row.id));
      setDetailReq(prev => (prev && prev.id === row.id ? null : prev));
      void recordAudit({
        module: 'store_req',
        action: 'deleted',
        summary: `Deleted store requisition "${row.item}" (#${row.id.slice(0, 8)})`,
        actorName: activeProfile.name,
        actorRole: activeProfile.roleLabel,
      });
      toast.success(t('storereq.deleted', 'Request deleted'));
    } finally {
      setDeletingId(null);
    }
  }

  async function decideReq(row: ReqRow, status: 'approved' | 'rejected' | 'dispatched') {
    if (!canDecideReq) {
      toast.error(t('storereq.decide_forbidden', 'Only Unit Head / Admin can decide this request.'));
      return;
    }
    setDeciding(true);
    try {
      const { error } = await updateRows('store_requisitions', { status }).eq('id', row.id);
      if (error) {
        toast.error(t('storereq.decide_failed', { message: error.message, defaultValue: 'Update failed: {{message}}' }));
        return;
      }
      setItems(prev => prev.map(r => r.id === row.id ? { ...r, status } : r));
      setDetailReq(prev => prev && prev.id === row.id ? { ...prev, status } : prev);
      toast.success(
        status === 'approved' ? t('storereq.approved_ok', 'Request approved') :
        status === 'rejected' ? t('storereq.rejected_ok', 'Request rejected') :
        t('storereq.dispatched_ok', 'Marked dispatched'),
      );
      insertRows('notifications', {
        target_roles: ['admin', 'unit_head', 'store_manager_maint', 'store_manager_chl'],
        title: t('storereq.decide_notif_title', {
          defaultValue: 'Store req {{status}}: {{item}}',
          status,
          item: row.item,
        }),
        body: `#${row.id.slice(0, 8)} · ${displayLocationName(row.plants?.name)}`,
        type: status === 'rejected' ? 'urgent' : 'info',
        route: '/dashboard/purchase/storereq',
        actor_name: activeProfile.name || '',
        actor_role: activeProfile.id,
        read_by: [],
        plant_id: row.plant_id || null,
      }).then(() => {}, () => {});
    } finally {
      setDeciding(false);
    }
  }

  return (
    <>
      {/* Tab bar — Requirements · Stock Register · Scrap */}
      <SegmentTabs
        className="mb-5"
        items={isTechnical
          ? [{ key: 'stock', label: t('storereq.tab_stock', 'Stock Register'), icon: <Package /> }]
          : [
              { key: 'requirements', label: t('storereq.tab_requirements', 'Requirements'), icon: <ListChecks /> },
              { key: 'stock',        label: t('storereq.tab_stock', 'Stock Register'),      icon: <Package /> },
              { key: 'scrap',        label: t('storereq.tab_scrap', 'Repair/Scrap'),        icon: <Recycle /> },
            ]}
        value={tab}
        onChange={setTab}
      />

      {/* ── Consolidated stock register (uploaded file + live usage) ────────── */}
      {tab === 'stock' && <StockRegister />}

      {/* ── Repair & scrap tracking (post-maintenance asset movement) ───────── */}
      {tab === 'scrap' && <RepairScrapPanel />}

      {tab === 'requirements' && (
      <>
      {/* Summary tiles */}
      <div className="erp-query" role="tablist" aria-label={t('storereq.tab_requirements', 'Requirements')}>
        <button type="button" role="tab" aria-pressed={queue === 'all'}
          onClick={() => { setQueue('all'); setSearch(''); }}>
          <span className="erp-q-label">{t('storereq.queueAll', 'All requests')}</span>
          <span className="erp-q-n">{plantScoped.length}</span>
        </button>
        <button type="button" role="tab" aria-pressed={queue === 'pending'}
          onClick={() => { setQueue('pending'); setSearch(''); }}>
          <span className="erp-q-label">{t('storereq.stat_pending', 'Pending Approval')}</span>
          <span className="erp-q-n">{pendingCount}</span>
        </button>
        <button type="button" role="tab" aria-pressed={queue === 'ready'}
          onClick={() => { setQueue('ready'); setSearch(''); }}>
          <span className="erp-q-label">{t('storereq.stat_ready', 'Ready to Fulfil')}</span>
          <span className="erp-q-n">{readyCount}</span>
        </button>
        <button type="button" role="tab" aria-pressed={queue === 'urgent'} data-hot={urgentCount > 0 ? 'true' : undefined}
          onClick={() => { setQueue('urgent'); setSearch(''); }}>
          <span className="erp-q-label">{t('storereq.stat_urgent', 'Urgent')}</span>
          <span className="erp-q-n">{urgentCount}</span>
        </button>
      </div>

      {(isAdmin || isStore) && (
        <div className="card2 p-4 mb-4">
          <div className="flex items-center justify-between gap-3 mb-2">
            <div>
              <div className="text-sm font-bold">{t('storereq.buyersTitle', 'Who can buy')}</div>
              <p className="text-xs text-slate-500">{t('storereq.buyersHint', 'The store picks one of these people when the item is not in stock. The list can be edited.')}</p>
            </div>
            {!editingBuyers ? (
              <button type="button" className="text-xs font-bold text-[#D84315]" onClick={() => { setBuyerDraft(buyers); setEditingBuyers(true); }}>{t('storereq.editBuyers', 'Edit list')}</button>
            ) : (
              <div className="flex gap-2">
                <button type="button" className="text-xs font-bold text-slate-500" onClick={() => setEditingBuyers(false)}>{t('common.cancel', 'Cancel')}</button>
                <button type="button" className="text-xs font-bold text-emerald-700" onClick={() => void saveBuyerList()}>{t('storereq.saveBuyers', 'Save list')}</button>
              </div>
            )}
          </div>
          {!editingBuyers ? (
            <div className="flex flex-wrap gap-2">
              {buyers.map(p => <span key={p.name} className="badge" style={{ background: '#F1F5F9', color: '#334155' }}>{p.name} · {p.type}</span>)}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {buyerDraft.map((p, i) => (
                <div key={i} className="flex gap-2">
                  <input className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm flex-1" value={p.name} onChange={e => setBuyerDraft(list => list.map((row, j) => j === i ? { ...row, name: e.target.value } : row))} />
                  <select className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm" value={p.type} onChange={e => setBuyerDraft(list => list.map((row, j) => j === i ? { ...row, type: e.target.value as BuyerPerson['type'] } : row))}>
                    {BUYER_TYPES.map(type => <option key={type}>{type}</option>)}
                  </select>
                  <button type="button" className="text-xs text-red-600" onClick={() => setBuyerDraft(list => list.filter((_, j) => j !== i))}>{t('storereq.delete', 'Delete')}</button>
                </div>
              ))}
              <button type="button" className="text-xs font-bold text-sky-700 text-left" onClick={() => setBuyerDraft(list => [...list, { name: '', type: 'Purchase' }])}>{t('storereq.addBuyer', 'Add a person')}</button>
            </div>
          )}
        </div>
      )}

      {/* Requirements table */}
      <div className="relative" id="open-reqs">
        <KpiInfoButton info={{ title: 'Open Store Requirements', what: 'The store checks stock first. If it is not in stock they choose the approver and the buyer. After approval it goes to Vijay ji, then the buyer, then the store receives it into the stock register.', source: 'Supabase', formLabel: 'Raise request form', formPath: '/dashboard/purchase/storereq', note: 'Live table store_requisitions. Maintenance part indents still flow via maintenance_store_requests on the Maintenance screen.' }} />
      <SectionCard
        flush
        title={t('storereq.open_req_title')}
        subtitle={t('storereq.open_req_subtitle')}
        actions={
          <ButtonV2 variant="primary" icon={<Plus />} onClick={() => setOpen(true)}>
            {t('storereq.raise_request_btn')}
          </ButtonV2>
        }
      >
        {loadError ? (
          <div className="px-5 pb-5">
            <ErrorState title={t('storereq.load_error_title')} message={t('storereq.load_error_msg')}
              onRetry={() => { setLoading(true); setLoadError(false); load(); }} />
          </div>
        ) : loading ? (
          <div className="px-5 pb-5"><SkeletonRows rows={6} /></div>
        ) : (
        <>
          <div className="px-5 pb-4 flex flex-wrap gap-2 items-center">
            {plantOptions.length > 1 && (
              <select
                value={plantFilter}
                onChange={e => setPlantFilter(e.target.value)}
                aria-label={t('common.plant', 'Plant')}
                className="border border-slate-200 rounded-lg px-3 py-2 text-[13px] bg-white min-h-[40px]"
              >
                <option value="all">{t('common.allPlants')}</option>
                {plantOptions.map(p => <option key={p.id} value={p.id}>{displayLocationName(p.name)}</option>)}
              </select>
            )}
            <select
              value={queue}
              onChange={e => setQueue(e.target.value as 'all' | 'pending' | 'ready' | 'urgent')}
              aria-label={t('storereq.queueFilter', 'Which requests')}
              className="border border-slate-200 rounded-lg px-3 py-2 text-[13px] bg-white min-h-[40px]"
            >
              <option value="all">{t('storereq.queueAll', 'All requests')}</option>
              <option value="pending">{t('storereq.stat_pending', 'Pending Approval')}</option>
              <option value="ready">{t('storereq.stat_ready', 'Ready to Fulfil')}</option>
              <option value="urgent">{t('storereq.stat_urgent', 'Urgent')}</option>
            </select>
            <div className="flex-1 min-w-[180px]"><TableSearch value={search} onChange={setSearch} placeholder={t('storereq.search_ph', 'Search item, plant, ticket…')} /></div>
          </div>
          {filtered.length === 0 ? (
            <div className="px-5 pb-5"><EmptyState title={t('storereq.open_req_empty')} message={search ? t('common.noMatches', 'No rows match your search.') : undefined} /></div>
          ) : (
            <div>
              {/* Desktop table */}
              <div className="overflow-x-auto scroll-x desktop-only-table hidden md:block">
                <table className="dt2">
                  <thead>
                    <tr>
                      <Th sortKey="reqno" s={reqSort}>{t('storereq.col_req_no')}</Th><Th sortKey="ticket" s={reqSort}>{t('storereq.col_ticket', 'Ticket #')}</Th><Th sortKey="item" s={reqSort}>{t('storereq.col_item')}</Th><Th sortKey="plant" s={reqSort}>{t('storereq.col_plant')}</Th><Th sortKey="qty" s={reqSort} firstDir="desc" className="num">{t('storereq.col_qty')}</Th>
                      <Th sortKey="stage" s={reqSort}>{t('storereq.col_stage')}</Th><th>{t('storereq.col_awaiting')}</th><th>{t('storereq.col_decision')}</th><th>{t('storereq.col_pic')}</th>{canDeleteReq && <th></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map(r => {
                      const s = STATUS_STAGE[r.status] || STATUS_STAGE.pending;
                      const stageKey = STATUS_STAGE[r.status] ? r.status : 'pending';
                      return (
                        <tr
                          key={r.id}
                          onClick={() => openRow(r)}
                          style={{ cursor: 'pointer' }}
                          title={r.ticket_id ? t('storereq.open_ticket', 'Open maintenance ticket') : t('storereq.open_detail', 'View request details')}
                        >
                          <td className="font-bold text-xs text-slate-400">{r.id.slice(0, 8)}</td>
                          <td>
                            {r.ticket_id
                              ? <span className="num text-xs text-blue-600 font-semibold">#{r.ticket_id.slice(0, 8)}</span>
                              : <span className="text-slate-300">—</span>}
                          </td>
                          <td>{r.item}</td>
                          <td>{displayLocationName(r.plants?.name) || '—'}</td>
                          <td className="num">{r.qty}</td>
                          <td>
                            <span className="badge" style={{ background: s.bg, color: s.color }}>{t('storereq.stage_' + stageKey, s.label)}</span>
                          </td>
                          <td className="text-slate-500">{waitingOn(r)}</td>
                          <td className="font-semibold">{t('storereq.decision_' + stageKey, r.status)}</td>
                          <td onClick={e => e.stopPropagation()}><PicBadge url={r.photo_url} onOpen={() => r.photo_url && setLightbox([{ url: r.photo_url, label: r.item }])} /></td>
                          {canDeleteReq && (
                            <td onClick={e => e.stopPropagation()}>
                              <button
                                type="button"
                                disabled={deletingId === r.id}
                                onClick={() => { void deleteReq(r); }}
                                className="text-[12px] font-semibold text-red-600 disabled:opacity-50"
                                style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}
                              >{deletingId === r.id ? '…' : t('storereq.delete', 'Delete')}</button>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Phone cards */}
              <div className="mobile-stack flex flex-col gap-2.5 px-4 pb-2 md:hidden">
                {pageRows.map(r => {
                  const s = STATUS_STAGE[r.status] || STATUS_STAGE.pending;
                  const stageKey = STATUS_STAGE[r.status] ? r.status : 'pending';
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => openRow(r)}
                      className="text-left rounded-[12px] border border-slate-200 bg-white p-3.5 active:bg-slate-50"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="text-[15px] font-semibold text-slate-800 leading-snug break-words">{r.item}</div>
                          <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[12px] text-slate-500">
                            <span className="font-mono text-slate-400">{r.id.slice(0, 8)}</span>
                            {r.plants?.name && <span>· {displayLocationName(r.plants.name)}</span>}
                            <span>· qty <strong className="text-slate-700">{r.qty}</strong></span>
                          </div>
                        </div>
                        <span className="badge shrink-0" style={{ background: s.bg, color: s.color }}>{t('storereq.stage_' + stageKey, s.label)}</span>
                      </div>
                      <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[12.5px]">
                        {r.ticket_id && (
                          <span className="font-semibold text-blue-600">#{r.ticket_id.slice(0, 8)}</span>
                        )}
                        <span className="text-slate-500">
                          {waitingOn(r)}
                        </span>
                        {r.photo_url && (
                          <span
                            role="presentation"
                            onClick={e => { e.stopPropagation(); setLightbox([{ url: r.photo_url!, label: r.item }]); }}
                            className="ml-auto text-blue-600 font-semibold"
                          >{t('storereq.col_pic')}</span>
                        )}
                        {canDeleteReq && (
                          <span
                            role="presentation"
                            onClick={e => { e.stopPropagation(); void deleteReq(r); }}
                            className="ml-auto text-red-600 font-semibold"
                          >{deletingId === r.id ? '…' : t('storereq.delete', 'Delete')}</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>

              <div className="px-1 md:px-0">
                <TablePaginationV2 controls={controls} label={t('storereq.pagination_noun', 'requirements')} />
              </div>
            </div>
          )}
        </>
        )}
      </SectionCard>
      </div>
      </>
      )}

      {/* Slide panel */}
      <SlidePanel open={open} onClose={handleClose} title={t('storereq.panel_title')} subtitle={t('storereq.panel_subtitle')}>
        <PanelField label={t('storereq.field_item')}>
          <PanelInput placeholder={t('storereq.ph_item')} value={form.item} onChange={e => set('item', e.target.value)} />
        </PanelField>

        <PanelRow>
          <PanelField label={t('storereq.field_plant')}>
            <PanelSelect value={form.plant} onChange={e => set('plant', e.target.value)}>
              {!form.plant && <option value="">{t('storereq.selectPlant', 'Select factory…')}</option>}
              {plantOptions.map(p => <option key={p.id} value={p.id}>{displayLocationName(p.name)}</option>)}
            </PanelSelect>
          </PanelField>
          <PanelField label={t('storereq.field_priority')}>
            <PanelSelect value={form.priority} onChange={e => set('priority', e.target.value)}>
              <option value="Normal">{t('storereq.opt_normal')}</option>
              <option value="Urgent">{t('storereq.opt_urgent')}</option>
            </PanelSelect>
          </PanelField>
        </PanelRow>

        <PanelRow>
          <PanelField label={t('storereq.field_quantity')}>
            <PanelInput type="number" placeholder={t('storereq.ph_qty')} value={form.qty} onChange={e => set('qty', e.target.value)} />
          </PanelField>
          <PanelField label={t('storereq.field_unit')}>
            <PanelSelect value={form.unit} onChange={e => set('unit', e.target.value)}>
              {UNITS.map(u => <option key={u}>{u}</option>)}
            </PanelSelect>
          </PanelField>
        </PanelRow>

        <PanelField label={t('storereq.field_reason')}>
          <PanelTextarea placeholder={t('storereq.ph_reason')} value={form.notes} onChange={e => set('notes', e.target.value)} />
        </PanelField>

        <PanelDivider />

        <OcrUpload
          label={t('storereq.ocr_label')}
          hint={t('storereq.ocr_hint')}
          fields={[
            { key: 'item',  label: t('storereq.ocr_field_item'), value: 'Mechanical seal — pump P-104' },
            { key: 'qty',   label: t('storereq.ocr_field_qty'),  value: '2' },
            { key: 'notes', label: t('storereq.ocr_field_notes'), value: 'Worn seal causing leakage at flange joint' },
          ]}
          onFile={setProofFile}
        />

        <div style={{ fontSize: 11, color: '#94A3B8', marginBottom: 16 }}>
          {t('storereq.panel_helper')}
        </div>

        <PanelFooter
          saved={saved}
          onCancel={handleClose}
          onSave={handleSave}
          saveLabel={t('storereq.save_label')}
          successLabel={t('storereq.success_label')}
          successSub={t('storereq.success_sub')}
          disabled={!form.item.trim() || !form.qty}
          requiredHint={t('storereq.required_hint')}
        />
      </SlidePanel>

      {/* ── PANEL: Requisition detail (rows without a linked ticket) ─────── */}
      <SlidePanel
        open={!!detailReq}
        onClose={() => {
          setDetailReq(null);
          if (searchParams.get('req')) {
            const next = new URLSearchParams(searchParams);
            next.delete('req');
            setSearchParams(next, { replace: true });
          }
        }}
        title={detailReq?.item || t('storereq.detail_title', 'Requisition')}
        subtitle={detailReq ? `#${detailReq.id.slice(0, 8)} · ${displayLocationName(detailReq.plants?.name) || '—'}` : ''}
      >
        {detailReq && (() => {
          const s = STATUS_STAGE[detailReq.status] || STATUS_STAGE.pending;
          const stageKey = STATUS_STAGE[detailReq.status] ? detailReq.status : 'pending';
          const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '9px 0', borderBottom: '1px solid #F1F5F9' }}>
              <span style={{ fontSize: 12, color: '#94A3B8' }}>{k}</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#0F172A', textAlign: 'right' }}>{v}</span>
            </div>
          );
          return (
            <div>
              <Row k={t('storereq.col_req_no')} v={`#${detailReq.id.slice(0, 8)}`} />
              <Row k={t('storereq.col_item')} v={detailReq.item} />
              <Row k={t('storereq.col_plant')} v={displayLocationName(detailReq.plants?.name) || '—'} />
              <Row k={t('storereq.col_qty')} v={String(detailReq.qty)} />
              <Row k={t('storereq.field_priority')} v={detailReq.urgency === 'high' || detailReq.urgency === 'plant_stopper' ? t('storereq.opt_urgent') : t('storereq.opt_normal')} />
              <Row k={t('storereq.col_stage')} v={<span className="badge" style={{ background: s.bg, color: s.color }}>{t('storereq.stage_' + stageKey, s.label)}</span>} />
              <Row k={t('storereq.col_decision')} v={t('storereq.decision_' + stageKey, detailReq.status)} />
              {detailReq.buyer_name && <Row k={t('storereq.buyer', 'Buyer')} v={detailReq.buyer_name} />}
              {detailReq.supplier && <Row k={t('storereq.supplier', 'Supplier')} v={detailReq.supplier} />}
              {detailReq.vehicle_no && <Row k={t('storereq.vehicle', 'Vehicle')} v={detailReq.vehicle_no} />}
              {detailReq.remarks && <Row k={t('storereq.field_reason')} v={detailReq.remarks} />}
              <Row k={t('storereq.detail_requested', 'Requested on')} v={detailReq.created_at ? new Date(detailReq.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'} />
              {detailReq.photo_url && (
                <button
                  type="button"
                  onClick={() => setLightbox([{ url: detailReq.photo_url as string, label: detailReq.item }])}
                  style={{ marginTop: 14, padding: 0, border: '1px solid #E2E8F0', borderRadius: 12, overflow: 'hidden', cursor: 'pointer', background: 'none', lineHeight: 0, width: '100%' }}
                  title={t('storereq.pic_on_file')}
                >
                  <img src={detailReq.photo_url} alt={detailReq.item} style={{ width: '100%', maxHeight: 220, objectFit: 'cover', display: 'block' }} />
                </button>
              )}
              {isStore && detailReq.status === 'pending_store' && (
                <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <PhotoUploader
                    key={detailReq.id}
                    onBlobReady={setIssuePhotoBlob}
                    label={t('storereq.issuePhoto', 'Issue photo')}
                    hint={t('storereq.issuePhotoHint', 'Required if this material is worth more than ₹1,000.')}
                  />
                  <ButtonV2 variant="primary" disabled={deciding} onClick={() => void issueFromStock(detailReq)}>
                    {t('storereq.inStock', 'In stock — issue it')}
                  </ButtonV2>
                  <div className="text-xs font-bold text-slate-500">{t('storereq.notInStock', 'Not in stock')}</div>
                  <label className="text-xs text-slate-600">
                    {t('storereq.sendApprovalTo', 'Send approval to')}
                    <select className="block mt-1 w-full border border-slate-200 rounded-lg px-2 py-2 text-sm" value={routeForm.approver} onChange={e => setRouteForm(f => ({ ...f, approver: e.target.value }))}>
                      <option value="unit_head">{t('storereq.awaiting_unit_head')}</option>
                      <option value="naresh">Naresh ji</option>
                    </select>
                  </label>
                  <label className="text-xs text-slate-600">
                    {t('storereq.buyer', 'Buyer')}
                    <select className="block mt-1 w-full border border-slate-200 rounded-lg px-2 py-2 text-sm" value={routeForm.buyer} onChange={e => setRouteForm(f => ({ ...f, buyer: e.target.value }))}>
                      {buyers.map(p => <option key={p.name} value={p.name}>{p.name} · {p.type}</option>)}
                    </select>
                  </label>
                  <ButtonV2 variant="ghost" disabled={deciding} onClick={() => void sendForPurchase(detailReq)}>
                    {t('storereq.sendOn', 'Send for approval')}
                  </ButtonV2>
                </div>
              )}
              {detailReq.status === 'pending_approval' && ((detailReq.approver_key === 'naresh' ? (isAdmin || nameHas('naresh')) : isUnitHead)) && (
                <div style={{ marginTop: 16 }}>
                  <ButtonV2 variant="primary" disabled={deciding} onClick={() => void approverOk(detailReq)}>
                    {t('storereq.approve_btn', 'Approve')}
                  </ButtonV2>
                </div>
              )}
              {detailReq.status === 'pending_vijay' && (isAdmin || nameHas('vijay')) && (
                <div style={{ marginTop: 16 }}>
                  <ButtonV2 variant="primary" disabled={deciding} onClick={() => void vijayOk(detailReq)}>
                    {t('storereq.sendBuyerBtn', 'Send to the buyer')}
                  </ButtonV2>
                </div>
              )}
              {detailReq.status === 'pending_buyer' && (isAdmin || nameHas(detailReq.buyer_name || '___')) && (
                <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <input className="border border-slate-200 rounded-lg px-2 py-2 text-sm" placeholder={t('storereq.supplier', 'Supplier')} value={transit.supplier} onChange={e => setTransit(f => ({ ...f, supplier: e.target.value }))} />
                  <input className="border border-slate-200 rounded-lg px-2 py-2 text-sm" placeholder={t('storereq.vehicle', 'Vehicle')} value={transit.vehicle} onChange={e => setTransit(f => ({ ...f, vehicle: e.target.value }))} />
                  <ButtonV2 variant="primary" disabled={deciding} onClick={() => void markTransit(detailReq)}>
                    {t('storereq.markTransit', 'Mark in transit')}
                  </ButtonV2>
                </div>
              )}
              {isStore && detailReq.status === 'in_transit' && (
                <div style={{ marginTop: 16 }}>
                  <ButtonV2 variant="primary" disabled={deciding} onClick={() => void markReceived(detailReq)}>
                    {t('storereq.markReceived', 'Mark received')}
                  </ButtonV2>
                </div>
              )}
              {canDecideReq && detailReq.status === 'pending' && (
                <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                  <ButtonV2 variant="primary" disabled={deciding} onClick={() => decideReq(detailReq, 'approved')}>
                    {t('storereq.approve_btn', 'Approve')}
                  </ButtonV2>
                  <ButtonV2 variant="ghost" disabled={deciding} onClick={() => decideReq(detailReq, 'rejected')}>
                    {t('storereq.reject_btn', 'Reject')}
                  </ButtonV2>
                </div>
              )}
              {canDecideReq && detailReq.status === 'approved' && (
                <div style={{ marginTop: 16 }}>
                  <ButtonV2 variant="primary" disabled={deciding} onClick={() => decideReq(detailReq, 'dispatched')}>
                    {t('storereq.dispatch_btn', 'Mark dispatched')}
                  </ButtonV2>
                </div>
              )}
              {canDeleteReq && (
                <div style={{ marginTop: 16 }}>
                  <ButtonV2 variant="danger" disabled={deletingId === detailReq.id} onClick={() => { void deleteReq(detailReq); }}>
                    {deletingId === detailReq.id ? '…' : t('storereq.deleteRequest', 'Delete request')}
                  </ButtonV2>
                </div>
              )}
            </div>
          );
        })()}
      </SlidePanel>

      <ImageLightbox images={lightbox || []} open={!!lightbox} onClose={() => setLightbox(null)} />
    </>
  );
}
