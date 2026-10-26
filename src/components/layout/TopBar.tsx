import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ProfileSwitcher } from './ProfileSwitcher';
import { RoleSwitchButton } from './RoleSwitchButton';
import { LanguageSwitcher } from './LanguageSwitcher';
import { CautionButton } from '../anomaly/CautionButton';
import { useRoleContext } from '../../contexts/RoleContext';
import { useNotifications } from '../../contexts/NotificationsContext';
import { useTodo } from '../../contexts/TodoContext';
import { useSearchPalette } from '../../contexts/SearchPaletteContext';
import { profileCanAccess } from '../../lib/profiles';
import { displayLocationName } from '../../lib/plantLabels';
import { dropdownStyle } from '../../lib/uiPosition';
import type { AppNotification } from '../../contexts/NotificationsContext';
import { IconBell, IconChecklist, IconMenu, IconSearch, TB_ICON_BTN, TB_ICON_BTN_ACTIVE } from './TopIcons';
import { BUSY_COMPANIES, useBusyCompany } from '../../contexts/BusyCompanyContext';
import { useBusyHeartbeat } from '../../hooks/useBusyData';
import { BUSY_COMPANIES, useBusyCompany } from '../../contexts/BusyCompanyContext';
import { useBusyHeartbeat } from '../../hooks/useBusyData';

type NType = 'critical' | 'urgent' | 'warning' | 'info';

// ── Colour helpers (also used as the blacklist-severity scale) ─────────────────
// critical = deep red, urgent/high = red, warning/medium = amber, info/low = blue

const DOT: Record<NType, string>   = { critical: '#7F1D1D', urgent: '#DC2626', warning: '#D97706', info: '#2563EB' };
const ICON_BG: Record<NType, string> = { critical: '#FECACA', urgent: '#FEE2E2', warning: '#FEF3C7', info: '#DBEAFE' };
const ICON_COLOR: Record<NType, string> = { critical: '#7F1D1D', urgent: '#DC2626', warning: '#D97706', info: '#2563EB' };

function TypeIcon({ type }: { type: NType }) {
  if (type === 'urgent' || type === 'critical') return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  );
  if (type === 'warning') return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
  );
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
    </svg>
  );
}

/** Shown in place of the type icon for a notification whose workflow is done. */
function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

interface TopBarProps {
  title: string;
  breadcrumb: string;
  /** v2: gray one-liner under the title ("Plan, track and complete machine maintenance."). */
  subtitle?: string;
  /** Open the mobile sidebar drawer (shown only below md). */
  onMenu?: () => void;
}

function ShiftClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  const label = now.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  return <div className="shift-clock" title="Asia/Kolkata">{label} IST</div>;
}

function BusySyncStamp({ formatAge }: { formatAge: (ts: string) => string }) {
  const { t } = useTranslation();
  const { data: beat, isLoading } = useBusyHeartbeat();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  if (isLoading) return null;
  const ageMin = beat?.at ? (now - Date.parse(beat.at)) / 60000 : Infinity;
  const waiting = beat?.status === 'waiting';
  const dot = !beat || ageMin > 120 ? 'bg-rose-500'
    : waiting || ageMin > 15 ? 'bg-amber-500'
    : 'bg-teal-600';
  const label = !beat
    ? t('topbar.busyNoFeed', { defaultValue: 'Busy not connected' })
    : waiting
      ? t('topbar.busyWaiting', { defaultValue: 'Busy PC waiting · {{age}}', age: formatAge(beat.at) })
      : t('topbar.busySync', { defaultValue: 'Busy · {{age}}', age: formatAge(beat.at) });
  const title = beat
    ? t('topbar.busySyncTitle', {
        defaultValue: 'Last push from the Busy PC {{computer}} at {{time}}. Read only.',
        computer: beat.computer ?? '',
        time: new Date(beat.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }),
      })
    : label;
  return (
    <div title={title} className="flex items-center gap-1.5 px-1.5 lg:px-2.5 py-1.5 text-[11px] text-slate-500 tabular-nums whitespace-nowrap">
      <span className={`w-2 h-2 lg:w-1.5 lg:h-1.5 rounded-full ${dot}`} aria-hidden />
      <span className="sr-only lg:not-sr-only">{label}</span>
    </div>
  );
}

export function TopBar({ title, breadcrumb, subtitle, onMenu }: TopBarProps) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { openPalette } = useSearchPalette();
  const { activeProfile } = useRoleContext();
  const { notifications, unreadCount, markRead, markAllRead, clearAll, tableReady, isNotificationCompleted } = useNotifications();
  const { totalCount: todoCount } = useTodo();
  const { code: busyCompany, setCode: setBusyCompany } = useBusyCompany();
  const canSeeTodo = profileCanAccess(activeProfile, '/dashboard/todo');
  const [open, setOpen] = useState(false);
  const [photoView, setPhotoView] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const btnRef   = useRef<HTMLButtonElement>(null);

  // Close panel when clicking outside
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        btnRef.current   && !btnRef.current.contains(e.target as Node)
      ) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Close on profile change
  useEffect(() => { setOpen(false); }, [activeProfile.id]);

  // Close when the page scrolls behind the (fixed) panel. A no-capture window
  // listener fires only for page scroll, not the panel's own inner scroll.
  useEffect(() => {
    if (!open) return;
    const onScroll = () => setOpen(false);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [open]);

  function handleNotifClick(n: AppNotification) {
    markRead(n.id);
    if (n.route) { navigate(n.route); setOpen(false); }
  }

  function formatAge(ts: string) {
    const diff = Date.now() - new Date(ts).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return t('time.justNow');
    if (m < 60) return t('time.minutesAgo', { count: m });
    const h = Math.floor(m / 60);
    if (h < 24) return t('time.hoursAgo', { count: h });
    return t('time.daysAgo', { count: Math.floor(h / 24) });
  }

  const roleId = activeProfile?.id ?? 'admin';
  const unread = unreadCount;

  return (
    <div className="shift-console">
      {/* Left: title block — full width on a phone so the action icons cannot squeeze the title */}
      <div className="flex items-center gap-2.5 min-w-0 w-full md:w-auto md:flex-1">
        {/* Mobile hamburger — opens the sidebar drawer */}
        <button
          onClick={onMenu}
          aria-label="Menu"
          className={`md:hidden ${TB_ICON_BTN}`}
        >
          <IconMenu />
        </button>
        <div className="min-w-0">
          {/* Breadcrumb — "Factory › FAR › Fixed Assets" (parts come '·'-separated) */}
          <div className="shift-kicker text-[12px] flex items-center gap-1.5 flex-wrap">
            {breadcrumb.split(' · ').map((part, i, arr) => (
              <React.Fragment key={i}>
                {i > 0 && <span className="opacity-40">›</span>}
                <span className={i === arr.length - 1 ? 'shift-here' : undefined}>{part}</span>
              </React.Fragment>
            ))}
          </div>
          <h1 className="font-heading font-semibold text-[22px] md:text-[30px] leading-[1.12] mt-0.5 truncate tracking-tight">{title}</h1>
          {subtitle && <div className="shift-sub text-[12.5px] mt-0.5 max-w-[52ch] leading-snug">{subtitle}</div>}
        </div>
      </div>

      {/* Right: sync + actions + profile */}
      <div className="flex items-center gap-1.5 max-[390px]:gap-1 md:gap-2 flex-nowrap justify-end w-full md:w-auto">
        <ShiftClock />
        {/* Quiet sync stamp — not a SaaS “live” pill */}
        <label className="min-w-0">
          <span className="sr-only">{t('topbar.busyCompany', { defaultValue: 'Busy company' })}</span>
          <select
            value={busyCompany}
            onChange={(e) => setBusyCompany(e.target.value as typeof busyCompany)}
            aria-label={t('topbar.busyCompany', { defaultValue: 'Busy company' })}
            className="h-8 max-w-[9.5rem] sm:max-w-[11rem] truncate rounded-lg border border-slate-200 bg-white px-2 text-[12px] font-medium text-slate-700"
          >
            <option value="all">{t('topbar.busyAll', { defaultValue: 'All companies' })}</option>
            {BUSY_COMPANIES.map((company) => (
              <option key={company.code} value={company.code}>{company.short}</option>
            ))}
          </select>
        </label>
        <BusySyncStamp formatAge={formatAge} />

        {/* Global quick-search (Cmd/Ctrl+K) */}
        <button
          onClick={() => openPalette()}
          title={`${t('nav.quickSearch')} (⌘K)`}
          aria-label={t('nav.quickSearch')}
          className={TB_ICON_BTN}
        >
          <IconSearch />
        </button>

        {/* Language switcher */}
        <LanguageSwitcher />

        {/* Anomaly caution button (renders only for roles with anomaly access) */}
        <CautionButton />

        {/* To-Do / personal work queue — count of items awaiting this user */}
        {canSeeTodo && (
          <button
            title={t('nav.todo')}
            aria-label={t('nav.todo')}
            onClick={() => navigate('/dashboard/todo')}
            className={TB_ICON_BTN}
          >
            <IconChecklist />
            {todoCount > 0 && (
              <span className="tb-icon-badge">{todoCount > 9 ? '9+' : todoCount}</span>
            )}
          </button>
        )}

        {/* Bell button */}
        <button
          ref={btnRef}
          className={`${TB_ICON_BTN}${open ? ` ${TB_ICON_BTN_ACTIVE}` : ''}`}
          onClick={() => setOpen(v => !v)}
        >
          <IconBell />
          {unread > 0 && (
            <span className="tb-icon-badge">{unread > 9 ? '9+' : unread}</span>
          )}
        </button>

        {/* Notification dropdown */}
        {open && (
          <div
            ref={panelRef}
            style={{
              ...dropdownStyle(btnRef.current, 360, 520),
              background: '#fff', border: '1px solid #CDD5DE',
              borderRadius: 8, boxShadow: '0 12px 32px rgba(7,20,34,0.14)',
              zIndex: 200, display: 'flex', flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            {/* Header */}
            <div style={{ padding: '16px 18px 12px', borderBottom: '1px solid #F1F5F9', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: '#0F172A' }}>{t('topbar.notifications')}</div>
                  <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 1 }}>
                    {activeProfile.roleLabel} · {activeProfile.name}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  {unread > 0 && (
                    <button
                      onClick={markAllRead}
                      style={{
                        fontSize: 11, fontWeight: 600, color: '#F47651',
                        background: 'none', border: 'none', cursor: 'pointer',
                        padding: '4px 8px', borderRadius: 8, fontFamily: 'inherit',
                      }}
                    >
                      {t('topbar.markAllRead')}
                    </button>
                  )}
                  {notifications.length > 0 && (
                    <button
                      onClick={clearAll}
                      title={t('topbar.clearAllHint')}
                      style={{
                        fontSize: 11, fontWeight: 600, color: '#94A3B8',
                        background: 'none', border: 'none', cursor: 'pointer',
                        padding: '4px 8px', borderRadius: 8, fontFamily: 'inherit',
                      }}
                    >
                      {t('topbar.clearAll')}
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Notification list */}
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {!tableReady ? (
                <div style={{ padding: '32px 18px', textAlign: 'center', color: '#94A3B8', fontSize: 12 }}>
                  <div style={{ marginBottom: 6 }}>{t('topbar.tableMissing')}</div>
                  <div style={{ fontSize: 11, color: '#CBD5E1' }}>{t('topbar.tableMissingHint')}</div>
                </div>
              ) : notifications.length === 0 ? (
                <div style={{ padding: '40px 18px', textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>
                  {t('topbar.empty')}
                </div>
              ) : (
                notifications.map(n => {
                  const isRead = n.read_by?.includes(roleId);
                  const nType = (n.type as NType) || 'info';
                  // Belongs to a finished workflow (ticket closed) → render muted +
                  // struck-through with a ✓, so it's clearly part of the audit trail
                  // and not something still needing action. Still clickable/searchable.
                  const done = isNotificationCompleted(n);
                  const restBg = done ? '#F8FAFC' : (isRead ? '#fff' : '#FAFBFF');
                  return (
                    <div
                      key={n.id}
                      onClick={() => handleNotifClick(n)}
                      style={{
                        display: 'flex', alignItems: 'flex-start', gap: 12,
                        padding: '13px 18px', cursor: n.route ? 'pointer' : 'default',
                        background: restBg,
                        opacity: done ? 0.72 : 1,
                        borderBottom: '1px solid #F8FAFC',
                        transition: 'background 0.1s',
                      }}
                      onMouseEnter={e => { if (n.route) (e.currentTarget as HTMLDivElement).style.background = '#F1F5F9'; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = restBg; }}
                    >
                      <div style={{
                        width: 32, height: 32, borderRadius: 10, flexShrink: 0,
                        background: done ? '#DCFCE7' : ICON_BG[nType], color: done ? '#16A34A' : ICON_COLOR[nType],
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        marginTop: 1,
                      }}>
                        {done ? <CheckIcon /> : <TypeIcon type={nType} />}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: done ? 500 : (isRead ? 500 : 700), color: done ? '#94A3B8' : (isRead ? '#475569' : '#0F172A'), lineHeight: 1.35, textDecoration: done ? 'line-through' : 'none' }}>
                          {n.title}
                        </div>
                        {n.body && (
                          <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 3, lineHeight: 1.4, textDecoration: done ? 'line-through' : 'none' }}>{n.body}</div>
                        )}
                        {n.actor_name && (
                          <div style={{ fontSize: 10, color: '#CBD5E1', marginTop: 2 }}>{t('topbar.by', { name: n.actor_name })}</div>
                        )}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                          <span style={{ fontSize: 10, color: '#CBD5E1' }}>{formatAge(n.created_at)}</span>
                          {done && (
                            <span style={{ fontSize: 9, fontWeight: 700, color: '#16A34A', background: '#DCFCE7', borderRadius: 999, padding: '1px 6px', letterSpacing: '0.02em' }}>✓ {t('topbar.completed')}</span>
                          )}
                        </div>
                      </div>
                      {n.photo_url && (
                        <button
                          title={t('topbar.viewPhoto', 'View photo')}
                          onClick={(e) => { e.stopPropagation(); setPhotoView(n.photo_url!); }}
                          style={{ flexShrink: 0, width: 30, height: 30, borderRadius: 8, border: '1px solid #E2E8F0', background: '#fff', cursor: 'pointer', fontSize: 15, marginTop: 2 }}
                        >
                          📷
                        </button>
                      )}
                      {!isRead && !done && (
                        <div style={{ width: 7, height: 7, borderRadius: '50%', background: DOT[nType], flexShrink: 0, marginTop: 6 }} />
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* Footer */}
            <div style={{ padding: '10px 18px', borderTop: '1px solid #F1F5F9', flexShrink: 0 }}>
              <div style={{ fontSize: 11, color: '#94A3B8', textAlign: 'center' }}>
                {t('topbar.live')} · <strong>{activeProfile.roleLabel}</strong>
                {activeProfile.plant ? ` · ${displayLocationName(activeProfile.plant)}` : ''}
              </div>
            </div>
          </div>
        )}

        {/* Account controls — separated from the info icons */}
        <div className="flex items-center gap-1.5 ml-0.5 pl-1.5 md:gap-2 md:ml-1 md:pl-2 border-l border-slate-200 shrink-0">
          {/* Role preview switcher (admin only) — ⇅ icon */}
          <RoleSwitchButton />
          {/* Personal account menu (Settings · Sign out) */}
          <ProfileSwitcher />
        </div>
      </div>

      {/* Photo lightbox — check-in proof from a notification's 📷 */}
      {photoView && (
        <div
          onClick={() => setPhotoView(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000, padding: 24 }}
        >
          <img src={photoView} alt="Check-in proof" style={{ maxWidth: '90vw', maxHeight: '85vh', borderRadius: 12, boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }} />
        </div>
      )}
    </div>
  );
}
