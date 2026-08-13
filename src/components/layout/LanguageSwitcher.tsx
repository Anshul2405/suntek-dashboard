import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '../../lib/supabase';
import { updateRows } from '../../lib/db';
import { applyLanguage, AVAILABLE_LANGUAGES } from '../../i18n';
import { dropdownStyle } from '../../lib/uiPosition';
import { IconGlobe, TB_ICON_BTN, TB_ICON_BTN_ACTIVE } from './TopIcons';

/**
 * Globe dropdown in the top bar — change the UI language on the fly. The choice
 * applies instantly and is persisted to the user's account (profiles +
 * user_accounts), so it follows them on the next login and across devices.
 */
export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (
        btnRef.current && !btnRef.current.contains(e.target as Node) &&
        menuRef.current && !menuRef.current.contains(e.target as Node)
      ) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Close when the page scrolls behind the (fixed) menu.
  useEffect(() => {
    if (!open) return;
    const onScroll = () => setOpen(false);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [open]);

  async function choose(code: string) {
    setOpen(false);
    applyLanguage(code); // instant UI + remembered for next boot
    // Persist to the account (best-effort) so it sticks across logins/devices.
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      await updateRows('profiles', { preferred_language: code }).eq('id', user.id).then(() => {}, () => {});
      await updateRows('user_accounts', { preferred_language: code }).eq('auth_user_id', user.id).then(() => {}, () => {});
    } catch {
      /* not signed in / offline — local change still applies */
    }
  }

  const current = i18n.language?.split('-')[0] || 'en';

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        title={t('topbar.language')}
        aria-label={t('topbar.language')}
        className={`${TB_ICON_BTN}${open ? ` ${TB_ICON_BTN_ACTIVE}` : ''}`}
      >
        <IconGlobe />
      </button>

      {open && (
        <div
          ref={menuRef}
          style={{
            ...dropdownStyle(btnRef.current, 200, 400),
            background: '#fff', border: '1px solid #E2E8F0', borderRadius: 14,
            boxShadow: '0 12px 40px rgba(0,0,0,0.12)', zIndex: 200, overflow: 'hidden', padding: 6,
          }}
        >
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#94A3B8', padding: '6px 10px 4px' }}>
            {t('topbar.language')}
          </div>
          {AVAILABLE_LANGUAGES.map((l) => {
            const active = current === l.value;
            return (
              <button
                key={l.value}
                onClick={() => choose(l.value)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                  width: '100%', padding: '8px 10px', borderRadius: 10, border: 'none', cursor: 'pointer',
                  background: active ? '#F1F5F9' : 'transparent', fontFamily: 'inherit',
                  fontSize: 13, fontWeight: active ? 700 : 500, color: '#0F172A', textAlign: 'left',
                }}
              >
                <span>{l.label}</span>
                {active && <span style={{ color: '#16A34A', fontWeight: 800 }}>✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
