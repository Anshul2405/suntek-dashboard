import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Camera, RotateCcw } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { fetchActivePlants } from '../../lib/plants';
import { insertRows, updateRows } from '../../lib/db';
import { useToast } from '../../components/ui/toast';
import { useRoleContext } from '../../contexts/RoleContext';
import { uploadCheckinPhoto } from '../../lib/cloudinary';
import { validateGeofence } from '../../lib/algorithms/geofencing';
import { CameraCapture } from '../../components/CameraCapture';
import { formatDate, formatTime, istToday, istDayKey } from '../../lib/utils/formatting';

/**
 * The technician's own night-duty view + check-in. Shows the duties assigned to
 * the logged-in user; on their duty night they capture a GPS + photo check-in,
 * which links to the duty and notifies the unit head who scheduled them (with a
 * 📷 to view the proof).
 */

type Duty = {
  id: string; duty_date: string; status: string; plant_id: string | null;
  assigned_by: string | null; checked_in_at: string | null; shift_log_id: string | null;
};
type Plant = { id: string; name: string; lat: number; lng: number; geofence_radius_m: number };

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function MyNightDuty({ showEmpty = false }: { showEmpty?: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();

  const weekdayLabels = [
    t('nightBoard.weekdaySun', 'Sun'), t('nightBoard.weekdayMon', 'Mon'), t('nightBoard.weekdayTue', 'Tue'),
    t('nightBoard.weekdayWed', 'Wed'), t('nightBoard.weekdayThu', 'Thu'), t('nightBoard.weekdayFri', 'Fri'),
    t('nightBoard.weekdaySat', 'Sat'),
  ];
  const { activeProfile } = useRoleContext();
  const [myAccountId, setMyAccountId] = useState<string | null>(null);
  const [duties, setDuties] = useState<Duty[]>([]);
  const [plants, setPlants] = useState<Record<string, Plant>>({});
  const [loading, setLoading] = useState(true);
  const [photo, setPhoto] = useState<Record<string, Blob>>({});
  // Object-URL previews of the captured photos, keyed by duty id (revoked on replace).
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [cameraFor, setCameraFor] = useState<string | null>(null); // duty id the camera modal is open for
  const [busy, setBusy] = useState<string | null>(null);
  const [monthCursor, setMonthCursor] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });

  function setDutyPhoto(dutyId: string, blob: Blob) {
    setPhoto(p => ({ ...p, [dutyId]: blob }));
    setPreviews(prev => {
      if (prev[dutyId]) URL.revokeObjectURL(prev[dutyId]);
      return { ...prev, [dutyId]: URL.createObjectURL(blob) };
    });
  }
  function clearDutyPhoto(dutyId: string) {
    setPhoto(p => { const n = { ...p }; delete n[dutyId]; return n; });
    setPreviews(prev => {
      if (prev[dutyId]) URL.revokeObjectURL(prev[dutyId]);
      const n = { ...prev }; delete n[dutyId]; return n;
    });
  }

  const load = useCallback(async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    let acctId: string | null = null;
    if (user?.id) {
      const { data: me } = await supabase.from('user_accounts').select('id').eq('auth_user_id', user.id).limit(1).returns<{ id: string }[]>();
      acctId = me?.[0]?.id ?? null;
    }
    setMyAccountId(acctId);
    // IST yesterday — the browser's own date could be a day off.
    const yesterdayKey = istDayKey(new Date(Date.now() - 86_400_000));
    const [{ data: dutyRows }, { data: plantRows }] = await Promise.all([
      acctId
        ? supabase.from('night_duty').select('id, duty_date, status, plant_id, assigned_by, checked_in_at, shift_log_id').eq('technician_id', acctId).gte('duty_date', yesterdayKey).order('duty_date').returns<Duty[]>()
        : Promise.resolve({ data: [] as Duty[] }),
      fetchActivePlants<Plant>('id, name, lat, lng, geofence_radius_m'),
    ]);
    setDuties(dutyRows ?? []);
    setPlants(Object.fromEntries((plantRows ?? []).map(p => [p.id, p])));
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function checkIn(duty: Duty) {
    if (busy) return;
    const blob = photo[duty.id];
    if (!blob) { toast.error(t('checkin.takePhotoFirst', 'Take a photo first')); return; }
    setBusy(duty.id);
    try {
      const plant = duty.plant_id ? plants[duty.plant_id] : undefined;
      // 1) GPS
      const pos = await new Promise<GeolocationPosition>((res, rej) =>
        navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 15000 }));
      const { latitude, longitude } = pos.coords;
      const geo = plant ? validateGeofence(latitude, longitude, plant.lat, plant.lng, plant.geofence_radius_m) : null;
      // 2) Upload photo
      const up = await uploadCheckinPhoto(blob, {
        plantName: plant?.name ?? 'Plant', lat: latitude, lng: longitude,
        isOnSite: geo?.isOnSite ?? true, creator: activeProfile.name,
      });
      // 3) shift_logs record, linked to the duty
      const { data: logRow, error: logErr } = await insertRows('shift_logs', {
        photo_url: up.secure_url, lat: latitude, lng: longitude,
        is_on_site: geo?.isOnSite ?? true, distance_m: geo?.distanceM ?? null,
        plant_id: duty.plant_id, night_duty_id: duty.id,
      }).select('id').single();
      if (logErr) { toast.error(t('checkin.checkinFailed', { defaultValue: 'Check-in failed: {{message}}', message: logErr.message })); return; }
      // 4) mark the duty checked in
      const now = new Date().toISOString();
      await updateRows('night_duty', { status: 'checked_in', checked_in_at: now, shift_log_id: logRow?.id ?? null }).eq('id', duty.id);
      // 5) notify the unit head who scheduled + admin, with the photo as proof
      const time = formatTime(now);
      const targets = ['admin'];
      if (duty.assigned_by) targets.push(`db_${duty.assigned_by}`);
      insertRows('notifications', {
        target_roles: targets,
        title: `Night duty: ${activeProfile.name} checked in`,
        body: `${geo?.isOnSite === false ? '⚠️ Out of zone · ' : ''}Reported ${time}`,
        type: geo?.isOnSite === false ? 'urgent' : 'info',
        route: '/dashboard/night-manager',
        actor_name: activeProfile.name,
        actor_role: 'technician_shd',
        plant_id: duty.plant_id,
        photo_url: up.secure_url,
      }).then(() => {}, () => {});
      toast.success(t('checkin.checkedInNotified', 'Checked in — your unit head has been notified.'));
      clearDutyPhoto(duty.id);
      await load();
    } catch (err) {
      toast.error(t('checkin.checkinFailed', { defaultValue: 'Check-in failed: {{message}}', message: err instanceof Error ? err.message : t('checkin.gpsPhotoError', 'GPS/photo error') }));
    } finally { setBusy(null); }
  }

  const today = istToday(); // IST day, not the browser's
  const visible = useMemo(() => duties.filter(d => d.duty_date >= today || d.status === 'checked_in'), [duties, today]);
  const bookedByDate = useMemo(() => Object.fromEntries(duties.map(d => [d.duty_date, d])), [duties]);
  const monthGrid = useMemo(() => {
    const y = monthCursor.getFullYear(), m = monthCursor.getMonth();
    const startPad = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const cells: (string | null)[] = [];
    for (let i = 0; i < startPad; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(iso(new Date(y, m, d)));
    return cells;
  }, [monthCursor]);

  // In the allocator board this renders compactly only if they have duties; on
  // the technician's own tab (showEmpty) it always renders (with their calendar).
  if (loading) return null;
  if (!showEmpty && visible.length === 0) return null;

  return (
    <div className="card2 p-5 mb-5">
      <div className="text-base font-bold font-heading mb-1">{t('checkin.myNightDuty', '🌙 My night duty')}</div>
      <div className="text-xs text-slate-500 mb-3">{t('checkin.myDutyIntro1', 'Your booked night shifts. You can only check in')} <strong>{t('checkin.myDutyIntroStrong', 'on the night itself')}</strong> {t('checkin.myDutyIntro2', '— take a photo to check in.')}</div>

      {/* Calendar of my booked nights */}
      <div style={{ maxWidth: 460, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <button onClick={() => setMonthCursor(c => new Date(c.getFullYear(), c.getMonth() - 1, 1))} style={{ width: 26, height: 26, borderRadius: 8, border: '1px solid #E2E8F0', background: '#fff', cursor: 'pointer' }}>‹</button>
          <div style={{ fontSize: 13, fontWeight: 700 }}>{monthCursor.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</div>
          <button onClick={() => setMonthCursor(c => new Date(c.getFullYear(), c.getMonth() + 1, 1))} style={{ width: 26, height: 26, borderRadius: 8, border: '1px solid #E2E8F0', background: '#fff', cursor: 'pointer' }}>›</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 3 }}>
          {weekdayLabels.map((w, i) => <div key={WEEKDAYS[i]} style={{ textAlign: 'center', fontSize: 9.5, color: '#94A3B8', fontWeight: 700 }}>{w}</div>)}
          {monthGrid.map((d, i) => {
            if (!d) return <div key={i} />;
            const duty = bookedByDate[d];
            const isToday = d === today;
            const done = duty && (duty.status === 'checked_in' || duty.status === 'completed');
            return (
              <div key={i} style={{
                height: 34, borderRadius: 7, fontSize: 11.5, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center',
                border: isToday ? '2px solid #2563EB' : '1px solid ' + (duty ? '#818CF8' : '#F1F5F9'),
                background: done ? '#DCFCE7' : (duty ? '#EEF2FF' : '#fff'),
                color: done ? '#16A34A' : (duty ? '#4338CA' : '#CBD5E1'),
              }} title={duty ? t('checkin.nightDutyStatusTitle', { defaultValue: 'Night duty · {{status}}', status: duty.status }) : ''}>
                {Number(d.slice(-2))}
              </div>
            );
          })}
        </div>
        <div style={{ fontSize: 10.5, color: '#94A3B8', marginTop: 6, display: 'flex', gap: 12 }}>
          <span><span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 3, background: '#EEF2FF', border: '1px solid #818CF8', marginRight: 4, verticalAlign: 'middle' }} />{t('checkin.booked', 'Booked')}</span>
          <span><span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 3, background: '#DCFCE7', marginRight: 4, verticalAlign: 'middle' }} />{t('checkin.checkedIn', 'Checked in')}</span>
        </div>
      </div>

      {visible.length === 0 && <div style={{ fontSize: 12.5, color: '#94A3B8' }}>{t('checkin.noUpcomingAssigned', 'No upcoming night duty assigned.')}</div>}
      <div className="flex flex-col gap-2">
        {visible.map(d => {
          const plant = d.plant_id ? plants[d.plant_id] : undefined;
          const isToday = d.duty_date === today;
          const done = d.status === 'checked_in' || d.status === 'completed';
          const dateLabel = `${new Date(d.duty_date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short' })}, ${formatDate(d.duty_date)}`;
          return (
            <div key={d.id} style={{ border: '1px solid #E2E8F0', borderRadius: 10, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 160 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>{dateLabel}{isToday && <span style={{ marginLeft: 6, fontSize: 10.5, color: '#2563EB', fontWeight: 700 }}>{t('checkin.tonightBadge', '· TONIGHT')}</span>}</div>
                <div style={{ fontSize: 11, color: '#94A3B8' }}>{plant?.name || t('common.plant', 'Plant')}</div>
              </div>
              {done ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="badge" style={{ background: '#DCFCE7', color: '#16A34A', fontSize: 11 }}>✓ {t('checkin.checkedIn', 'Checked in')} {d.checked_in_at ? formatTime(d.checked_in_at) : ''}</span>
                </div>
              ) : isToday ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {photo[d.id] && previews[d.id] ? (
                    <>
                      {/* Preview of the photo they're about to check in with */}
                      <button
                        type="button"
                        onClick={() => setCameraFor(d.id)}
                        title={t('checkin.tapToRetake', 'Tap to retake')}
                        style={{ padding: 0, border: '2px solid #86EFAC', borderRadius: 10, overflow: 'hidden', cursor: 'pointer', background: 'none', lineHeight: 0 }}
                      >
                        <img src={previews[d.id]} alt="Check-in photo preview" style={{ width: 52, height: 52, objectFit: 'cover', display: 'block' }} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setCameraFor(d.id)}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, color: '#475569', cursor: 'pointer', padding: '6px 10px', border: '1px solid #E2E8F0', borderRadius: 8, background: '#fff', fontFamily: 'inherit' }}
                      >
                        <RotateCcw size={12} /> {t('checkin.retake', 'Retake')}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setCameraFor(d.id)}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: '#2563EB', cursor: 'pointer', padding: '6px 10px', border: '1px solid #BFDBFE', borderRadius: 8, background: '#fff', fontFamily: 'inherit' }}
                    >
                      <Camera size={13} /> {t('checkin.takePhoto', 'Take photo')}
                    </button>
                  )}
                  <button onClick={() => checkIn(d)} disabled={busy === d.id || !photo[d.id]} className="btn-accent rounded-[10px]"
                    style={{ padding: '6px 14px', fontSize: 12.5, fontWeight: 700, cursor: busy === d.id || !photo[d.id] ? 'not-allowed' : 'pointer', opacity: busy === d.id || !photo[d.id] ? 0.5 : 1 }}>
                    {busy === d.id ? t('checkin.checkingIn', 'Checking in…') : t('checkin.checkIn', 'Check in')}
                  </button>
                </div>
              ) : (
                <span className="badge" style={{ background: '#EFF6FF', color: '#2563EB', fontSize: 11 }}>{t('nightBoard.statusScheduled', 'Scheduled')}</span>
              )}
            </div>
          );
        })}
      </div>

      {/* In-app camera — live viewfinder w/ front/back flip; falls back to the
          native capture input where getUserMedia is blocked. */}
      <CameraCapture
        open={!!cameraFor}
        onClose={() => setCameraFor(null)}
        onCapture={(blob) => { if (cameraFor) setDutyPhoto(cameraFor, blob); }}
        title={t('checkin.checkinPhotoTitle', 'Check-in photo')}
      />
    </div>
  );
}
