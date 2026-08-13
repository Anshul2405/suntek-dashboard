import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useRoleContext } from '../../contexts/RoleContext';
import { ProfileAvatar } from './ProfileSwitcher';
import type { MockProfile } from '../../lib/profiles';
import { IconSwap, TB_ICON_BTN, TB_ICON_BTN_ACTIVE } from './TopIcons';

// Access badge for the role list
function AccessBadge({ profile }: { profile: MockProfile }) {
  const { t } = useTranslation();
  if (profile.standaloneOnly) {
    return <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 whitespace-nowrap">{t('topbar.accessAppOnly', 'App only')}</span>;
  }
  if (profile.allowedDashboardRoutes.includes('*')) {
    return <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-green-100 text-green-700 whitespace-nowrap">{t('topbar.accessFull', 'Full')}</span>;
  }
  return <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 whitespace-nowrap">{t('topbar.accessNViews', { defaultValue: '{{count}} views', count: profile.allowedDashboardRoutes.length })}</span>;
}

/**
 * Admin-only role preview switcher, surfaced as a ⇅ icon button (separate from the
 * personal avatar menu). Lets an admin view the dashboard as any role.
 * Renders nothing for users who can't switch (non-admins are locked to their role).
 */
export function RoleSwitchButton() {
  const { activeProfile, allProfiles, switchProfile, canSwitch } = useRoleContext();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (!canSwitch) return null;

  function handleSelect(profile: MockProfile) {
    switchProfile(profile.id);
    navigate(profile.homeRoute);
    setOpen(false);
  }

  return (
    <div ref={ref} className="relative">
      {/* ⇅ trigger — matches the bell button styling */}
      <button
        title={t('topbar.switchPreviewRole', 'Switch / preview role')}
        onClick={() => setOpen((o) => !o)}
        className={`${TB_ICON_BTN}${open ? ` ${TB_ICON_BTN_ACTIVE}` : ''}`}
      >
        <IconSwap />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-[290px] bg-white rounded-2xl shadow-xl border border-slate-200 z-50 overflow-hidden">
          <div className="px-4 pt-4 pb-3 border-b border-slate-100 bg-slate-50/60">
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">{t('topbar.previewAsRole', 'Preview as role')}</div>
            <div className="text-[12px] text-slate-500 mt-0.5">{t('topbar.previewAsRoleHint', 'Switch to see role-specific views & access')}</div>
          </div>

          <div className="p-2 max-h-[420px] overflow-y-auto">
            {allProfiles.map((profile) => {
              const isActive = profile.id === activeProfile.id;
              return (
                <button
                  key={profile.id}
                  onClick={() => handleSelect(profile)}
                  className={[
                    'w-full flex items-start gap-3 p-3 rounded-xl text-left transition-colors',
                    isActive ? 'bg-orange-50 border border-orange-200' : 'hover:bg-slate-50 border border-transparent',
                  ].join(' ')}
                >
                  <ProfileAvatar profile={profile} size="md" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[13px] font-bold leading-tight truncate">{profile.name}</span>
                      {isActive && (
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-orange-100 text-orange-600 whitespace-nowrap">{t('topbar.activeBadge', 'active')}</span>
                      )}
                    </div>
                    <div className="text-[11px] font-semibold text-slate-600 mt-0.5">{profile.roleLabel}</div>
                    <div className="text-[11px] text-slate-400">{profile.roleDescription}</div>
                    {profile.plant && <div className="text-[11px] text-slate-500 mt-0.5">📍 {profile.plant}</div>}
                    {profile.accessNote && <div className="text-[11px] text-amber-600 font-medium mt-0.5">⚠ {profile.accessNote}</div>}
                  </div>
                  <div className="shrink-0 mt-0.5"><AccessBadge profile={profile} /></div>
                </button>
              );
            })}
          </div>

          <div className="px-4 py-3 border-t border-slate-100 bg-slate-50/60">
            <div className="text-[11px] text-slate-400 text-center">{t('topbar.rolePreviewFooter', 'Role preview mode · Navigation adapts per role')}</div>
          </div>
        </div>
      )}
    </div>
  );
}
