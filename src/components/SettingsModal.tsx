import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Camera, ImageUp } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { updateRows } from '../lib/db';
import { uploadWorkflowImage } from '../lib/cloudinary';
import { useToast } from './ui/toast';
import { useRoleContext } from '../contexts/RoleContext';
import { useNotifications } from '../contexts/NotificationsContext';
import { LANGUAGE_OPTIONS, logUserAccountEvent } from '../lib/userEvents';
import { applyLanguage } from '../i18n';
import {
  getPushPermission,
  isPushEnabledLocally,
  isPushSupported,
  requestPushPermission,
  setPushEnabledLocally,
} from '../lib/pushNotifications';

/**
 * Centered self-service settings modal, opened from the avatar dropdown.
 * A user can change their display name, preferred language, profile photo,
 * browser push preference, and own password.
 */
export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { authProfile } = useRoleContext();
  const { addNotification } = useNotifications();
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  const [authUserId, setAuthUserId] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [userAccountId, setUserAccountId] = useState<string | null>(null);

  const [displayName, setDisplayName] = useState('');
  const [language, setLanguage] = useState('en');
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [origName, setOrigName] = useState('');
  const [origLang, setOrigLang] = useState('en');
  const [origPhoto, setOrigPhoto] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [pushOn, setPushOn] = useState(false);
  const [pushPerm, setPushPerm] = useState<ReturnType<typeof getPushPermission>>('default');

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPushOn(isPushEnabledLocally());
    setPushPerm(getPushPermission());
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (cancelled || !user) return;
      setAuthUserId(user.id);
      setEmail(user.email ?? null);

      const { data: prof } = await supabase
        .from('profiles').select('name, preferred_language, photo_url').eq('id', user.id)
        .maybeSingle().returns<{ name: string | null; preferred_language: string | null; photo_url: string | null }>();
      const { data: acct } = await supabase
        .from('user_accounts').select('id, name, preferred_language, photo_url').eq('auth_user_id', user.id)
        .maybeSingle().returns<{ id: string; name: string | null; preferred_language: string | null; photo_url: string | null }>();
      if (cancelled) return;

      const name = prof?.name || acct?.name || authProfile?.name || '';
      const lang = prof?.preferred_language || acct?.preferred_language || 'en';
      const photo = prof?.photo_url || acct?.photo_url || authProfile?.photoUrl || null;
      setDisplayName(name); setOrigName(name);
      setLanguage(lang); setOrigLang(lang);
      setPhotoUrl(photo); setOrigPhoto(photo);
      setUserAccountId(acct?.id ?? null);
      setPassword(''); setConfirm('');
    })();
    return () => { cancelled = true; };
  }, [open, authProfile?.name, authProfile?.photoUrl]);

  if (!open) return null;

  async function handlePhotoFile(file: File | null) {
    if (!file || !authUserId) return;
    if (!file.type.startsWith('image/')) {
      toast.error(t('topbar.settingsPhotoType', 'Please choose an image file'));
      return;
    }
    // Cap ~8MB — mobile camera HEIC/JPEG can be large
    if (file.size > 8 * 1024 * 1024) {
      toast.error(t('topbar.settingsPhotoTooBig', 'Photo must be under 8 MB'));
      return;
    }
    setUploadingPhoto(true);
    try {
      const up = await uploadWorkflowImage(file, {
        workflow: 'general',
        subfolder: 'avatars',
        kind: 'avatar',
        entityId: userAccountId || authUserId,
        creator: displayName || authProfile?.name || 'user',
      });
      setPhotoUrl(up.secure_url);
      toast.success(t('topbar.settingsPhotoReady', 'Photo ready — tap Save changes'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setUploadingPhoto(false);
    }
  }

  async function togglePush() {
    if (!isPushSupported()) {
      toast.error(t('topbar.pushUnsupported', 'Browser notifications are not supported on this device'));
      return;
    }
    if (!pushOn) {
      const perm = await requestPushPermission();
      setPushPerm(perm);
      if (perm === 'granted') {
        setPushOn(true);
        toast.success(t('topbar.pushEnabled', 'Browser notifications enabled'));
      } else if (perm === 'denied') {
        toast.error(t('topbar.pushDenied', 'Permission denied — enable notifications in browser settings'));
      }
    } else {
      setPushEnabledLocally(false);
      setPushOn(false);
      toast.info(t('topbar.pushDisabled', 'Browser notifications paused'));
    }
  }

  async function handleSave() {
    if (!authUserId) { toast.error(t('topbar.settingsNoSession', 'No active session — sign in again')); return; }
    if (!displayName.trim()) { toast.error(t('topbar.settingsNameEmpty', 'Display name cannot be empty')); return; }
    if (password) {
      if (password.length < 8) { toast.error(t('topbar.settingsPwdTooShort', 'Password must be at least 8 characters')); return; }
      if (password !== confirm) { toast.error(t('topbar.settingsPwdMismatch', 'Passwords do not match')); return; }
    }
    setSaving(true);

    const changes: string[] = [];
    if (displayName.trim() !== origName) changes.push(t('topbar.settingsChgName', { defaultValue: 'name → "{{name}}"', name: displayName.trim() }));
    if (language !== origLang) changes.push(t('topbar.settingsChgLanguage', { defaultValue: 'language → {{lang}}', lang: LANGUAGE_OPTIONS.find(l => l.value === language)?.label ?? language }));
    if ((photoUrl || null) !== (origPhoto || null)) changes.push(t('topbar.settingsChgPhoto', 'profile photo'));
    if (password) changes.push(t('topbar.settingsChgPassword', 'password reset'));

    const profilePatch: { name: string; preferred_language: string; photo_url?: string | null } = {
      name: displayName.trim(), preferred_language: language,
    };
    if ((photoUrl || null) !== (origPhoto || null)) profilePatch.photo_url = photoUrl;

    const { error: pErr } = await updateRows('profiles', profilePatch).eq('id', authUserId);
    if (pErr) { toast.error(t('topbar.settingsSaveFailed', { defaultValue: 'Save failed: {{message}}', message: pErr.message })); setSaving(false); return; }

    if (userAccountId) {
      await updateRows('user_accounts', {
        name: displayName.trim(), preferred_language: language,
        ...((photoUrl || null) !== (origPhoto || null) ? { photo_url: photoUrl } : {}),
      }).eq('id', userAccountId);
    }

    if (password) {
      const { error: pwErr } = await supabase.auth.updateUser({ password });
      if (pwErr) { toast.error(t('topbar.settingsPwdFailed', { defaultValue: 'Password change failed: {{message}}', message: pwErr.message })); setSaving(false); return; }
    }

    applyLanguage(language);

    if (changes.length === 0) { toast.info(t('topbar.settingsNoChanges', 'No changes to save')); setSaving(false); onClose(); return; }

    const summary = changes.join(', ');
    await addNotification({
      target_roles: ['admin'],
      title: t('topbar.settingsProfileUpdatedNotif', { defaultValue: '{{name}} updated their profile', name: displayName.trim() }),
      body: summary,
      type: 'info',
      route: '/dashboard/users',
      actor_name: displayName.trim(),
      actor_role: authProfile?.roleLabel ?? null,
    });
    await logUserAccountEvent({
      userAccountId, targetName: displayName.trim(), targetEmail: email,
      action: 'self_update', details: summary,
      actorName: displayName.trim(), actorRole: authProfile?.id ?? null,
    });

    toast.success(t('topbar.settingsSaved', 'Settings saved — refresh if the avatar does not update'));
    setSaving(false);
    onClose();
    // Soft reload so RoleContext picks up photo_url without a full re-auth dance.
    window.setTimeout(() => window.location.reload(), 400);
  }

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 460, maxHeight: '92vh', overflow: 'auto', background: '#fff', borderRadius: 20, boxShadow: '0 24px 60px rgba(0,0,0,0.22)' }}
      >
        <div style={{ padding: '18px 22px', borderBottom: '1px solid #F1F5F9', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 800, color: '#0F172A' }}>{t('topbar.settingsTitle', 'Settings')}</div>
            <div style={{ fontSize: 12, color: '#94A3B8' }}>{email || t('topbar.settingsYourAccount', 'Your account')} · {authProfile?.roleLabel}</div>
          </div>
          <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: '50%', border: 'none', background: '#F1F5F9', cursor: 'pointer', color: '#64748B', fontSize: 16 }}>✕</button>
        </div>

        <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Profile photo — camera + gallery for mobile (Anand Mehta) */}
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 8 }}>
              {t('topbar.settingsPhoto', 'Profile photo')}
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <div style={{ width: 64, height: 64, borderRadius: 999, overflow: 'hidden', background: '#E2E8F0', flexShrink: 0 }}>
                {photoUrl
                  ? <img src={photoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, color: '#64748B' }}>{(displayName || '?').slice(0, 2).toUpperCase()}</div>}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    disabled={uploadingPhoto}
                    onClick={() => cameraRef.current?.click()}
                    style={{ ...btnOutline, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                  >
                    <Camera size={14} /> {t('topbar.settingsTakePhoto', 'Camera')}
                  </button>
                  <button
                    type="button"
                    disabled={uploadingPhoto}
                    onClick={() => fileRef.current?.click()}
                    style={{ ...btnOutline, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                  >
                    <ImageUp size={14} /> {t('topbar.settingsChoosePhoto', 'Gallery')}
                  </button>
                </div>
                <div style={{ fontSize: 11, color: '#94A3B8' }}>
                  {uploadingPhoto
                    ? t('topbar.settingsUploadingPhoto', 'Uploading…')
                    : t('topbar.settingsPhotoHint', 'Works on phone — use Camera or Gallery, then Save.')}
                </div>
              </div>
            </div>
            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="user"
              style={{ display: 'none' }}
              onChange={(e) => { void handlePhotoFile(e.target.files?.[0] ?? null); e.target.value = ''; }}
            />
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.heic"
              style={{ display: 'none' }}
              onChange={(e) => { void handlePhotoFile(e.target.files?.[0] ?? null); e.target.value = ''; }}
            />
          </div>

          <Field label={t('topbar.settingsDisplayName', 'Display name')}>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} style={inputStyle} placeholder={t('topbar.settingsNamePlaceholder', 'Your name')} />
          </Field>

          <Field label={t('topbar.settingsPreferredLanguage', 'Preferred language')}>
            <select value={language} onChange={(e) => setLanguage(e.target.value)} style={{ ...inputStyle, background: '#fff' }}>
              {LANGUAGE_OPTIONS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
            </select>
            <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 4 }}>{t('topbar.settingsLanguageHint', 'Applies to the interface as more screens are translated (Hindi available now).')}</div>
          </Field>

          {isPushSupported() && (
            <div style={{ border: '1px solid #E2E8F0', borderRadius: 12, padding: '12px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>{t('topbar.pushTitle', 'Browser notifications')}</div>
                <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 2 }}>
                  {pushPerm === 'denied'
                    ? t('topbar.pushBlocked', 'Blocked in browser settings')
                    : t('topbar.pushHint', 'Alert when the app is in the background')}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void togglePush()}
                style={{
                  padding: '8px 14px', borderRadius: 999, border: 'none', fontWeight: 700, fontSize: 12, cursor: 'pointer',
                  background: pushOn ? '#EF6C00' : '#E2E8F0', color: pushOn ? '#fff' : '#475569',
                }}
              >
                {pushOn ? t('topbar.pushOn', 'On') : t('topbar.pushOff', 'Off')}
              </button>
            </div>
          )}

          <div style={{ borderTop: '1px solid #F1F5F9', paddingTop: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A', marginBottom: 10 }}>{t('topbar.settingsChangePassword', 'Change password')}</div>
            <Field label={t('topbar.settingsNewPassword', 'New password')}>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={inputStyle} placeholder={t('topbar.settingsNewPasswordPh', 'Leave blank to keep current')} />
            </Field>
            {password && (
              <div style={{ marginTop: 10 }}>
                <Field label={t('topbar.settingsConfirmPassword', 'Confirm new password')}>
                  <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} style={inputStyle} placeholder={t('topbar.settingsConfirmPasswordPh', 'Re-enter new password')} />
                </Field>
              </div>
            )}
          </div>

          <div style={{ fontSize: 11, color: '#94A3B8', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 10, padding: '8px 12px' }}>
            {t('topbar.settingsNotifyNote', 'Changes here notify the admin and are recorded in the profile history.')}
          </div>
        </div>

        <div style={{ padding: '14px 22px', borderTop: '1px solid #F1F5F9', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose} style={{ padding: '9px 18px', borderRadius: 12, border: '1px solid #E2E8F0', background: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer', color: '#475569' }}>{t('common.cancel', 'Cancel')}</button>
          <button onClick={handleSave} disabled={saving || uploadingPhoto} style={{ padding: '9px 20px', borderRadius: 12, border: 'none', background: saving ? '#94A3B8' : '#0F172A', color: '#fff', fontWeight: 700, fontSize: 13, cursor: saving ? 'default' : 'pointer' }}>
            {saving ? t('common.saving', 'Saving…') : t('topbar.settingsSaveChanges', 'Save changes')}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px', borderRadius: 12, border: '1.5px solid #E2E8F0',
  fontSize: 13, outline: 'none', fontFamily: 'inherit',
};

const btnOutline: React.CSSProperties = {
  padding: '8px 12px', borderRadius: 10, border: '1px solid #E2E8F0', background: '#fff',
  fontWeight: 600, fontSize: 12, cursor: 'pointer', color: '#334155',
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 6 }}>{label}</label>
      {children}
    </div>
  );
}
