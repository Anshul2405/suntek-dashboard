import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useRoleContext } from '../../contexts/RoleContext';
import { useAuth } from '../../hooks/useAuth';
import { SettingsModal } from '../SettingsModal';
import type { MockProfile } from '../../lib/profiles';

// ── Avatar ────────────────────────────────────────────────────────────────────

type AvatarSize = 'sm' | 'md' | 'lg';

const AVATAR_SIZE_CLASSES: Record<AvatarSize, string> = {
  sm: 'w-8 h-8 text-[11px]',
  md: 'w-10 h-10 text-xs',
  lg: 'w-11 h-11 text-sm',
};

export function ProfileAvatar({
  profile,
  size = 'md',
}: {
  profile: MockProfile;
  size?: AvatarSize;
}) {
  const sizeCls = AVATAR_SIZE_CLASSES[size];
  if (profile.photoUrl) {
    return (
      <img
        src={profile.photoUrl}
        alt={profile.name}
        className={[sizeCls, 'rounded-full flex-shrink-0 object-cover bg-slate-200'].join(' ')}
        referrerPolicy="no-referrer"
      />
    );
  }
  return (
    <div
      className={[
        sizeCls,
        'rounded-full flex-shrink-0',
        'bg-gradient-to-br',
        profile.avatarFrom,
        profile.avatarTo,
        'flex items-center justify-center',
        'text-white font-bold',
      ].join(' ')}
    >
      {profile.initials}
    </div>
  );
}

// ── Personal account menu (avatar → Settings / Sign out) ────────────────────────
//
// Shown for EVERY profile. Admin role-switching ("Preview as role") lives in the
// separate RoleSwitchButton (the ⇅ icon) — this menu is only about the account.

export function ProfileSwitcher() {
  const { activeProfile } = useRoleContext();
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  async function handleSignOut() {
    setOpen(false);
    await signOut();
    navigate('/login');
  }

  return (
    <div ref={ref} className="relative">
      {/* Trigger chip */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 pl-1.5 pr-2 py-1 md:gap-2.5 md:pl-2 md:pr-3 md:py-1.5 shrink-0 bg-white border border-slate-200 rounded-full hover:bg-slate-50 transition-colors"
      >
        <ProfileAvatar profile={activeProfile} size="sm" />
        <div className="text-left hidden md:block">
          <div className="text-[12px] font-semibold leading-tight">
            {activeProfile.name.split(' ')[0]}
          </div>
          <div className="text-[10px] text-slate-500">{activeProfile.roleLabel}</div>
        </div>
        <svg
          className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          width="12" height="12" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2.4"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute right-0 top-full mt-2 w-[250px] bg-white rounded-2xl shadow-xl border border-slate-200 z-50 overflow-hidden">
          {/* Identity header */}
          <div className="px-4 pt-4 pb-3 border-b border-slate-100 bg-slate-50/60 flex items-center gap-3">
            <ProfileAvatar profile={activeProfile} size="md" />
            <div className="min-w-0">
              <div className="text-[13px] font-bold leading-tight truncate">{activeProfile.name}</div>
              <div className="text-[11px] text-slate-500">{activeProfile.roleLabel}</div>
              {activeProfile.plant && <div className="text-[11px] text-slate-400 truncate">📍 {activeProfile.plant}</div>}
            </div>
          </div>

          {/* Items */}
          <div className="p-2">
            <button
              onClick={() => { setOpen(false); setSettingsOpen(true); }}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-left text-[13px] font-semibold text-slate-700 hover:bg-slate-50 transition-colors"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              Settings &amp; preferences
            </button>
            <button
              onClick={handleSignOut}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-left text-[13px] font-semibold text-red-600 hover:bg-red-50 transition-colors"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
              Sign out
            </button>
          </div>
        </div>
      )}

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
