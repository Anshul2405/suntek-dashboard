import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { callRpc } from '../../../lib/db';
import { deleteLoginIdentity } from '../../../lib/adminUsers';
import { useRoleContext } from '../../../contexts/RoleContext';
import { useToast } from '../../../components/ui/toast';
import { SlidePanel } from '../../../components/SlidePanel';
import { formatDateTime } from '../../../lib/utils/formatting';
import { codeLabel } from '../../../lib/labels';
import type { DisplayUser } from './usersData';

interface UserEvent { id: string; action: string; details: string | null; actor_name: string | null; actor_role: string | null; created_at: string }

const EVENT_CFG: Record<string, { label: string; labelKey: string; bg: string; color: string }> = {
  created:        { label: 'Created',        labelKey: 'userMgmt.evCreated',       bg: '#EFF6FF', color: '#2563EB' },
  self_update:    { label: 'Self update',    labelKey: 'userMgmt.evSelfUpdate',    bg: '#F5F3FF', color: '#7C3AED' },
  admin_update:   { label: 'Admin update',   labelKey: 'userMgmt.evAdminUpdate',   bg: '#FFF7ED', color: '#EA580C' },
  password_reset: { label: 'Password reset', labelKey: 'userMgmt.evPasswordReset', bg: '#FEF2F2', color: '#DC2626' },
  login_enabled:  { label: 'Login enabled',  labelKey: 'userMgmt.evLoginEnabled',  bg: '#F0FDF4', color: '#16A34A' },
  login_disabled: { label: 'Login disabled', labelKey: 'userMgmt.evLoginDisabled', bg: '#F1F5F9', color: '#64748B' },
};

/** Who changed what on this profile (user_account_events). */
export function HistoryPanel({ user, onClose }: { user: DisplayUser | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [events, setEvents] = useState<UserEvent[]>([]);
  const [readFor, setReadFor] = useState<string | null>(null);
  const loading = !!user && readFor !== user.id;
  useEffect(() => {
    if (!user) return;
    let alive = true;
    void supabase
      .from('user_account_events')
      .select('id, action, details, actor_name, actor_role, created_at')
      .eq('user_account_id', user.id)
      .order('created_at', { ascending: false })
      .returns<UserEvent[]>()
      .then(({ data }) => { if (alive) { setEvents(data || []); setReadFor(user.id); } });
    return () => { alive = false; };
  }, [user]);
  return (
    <SlidePanel open={!!user} onClose={onClose} title={t('userMgmt.profileHistory')} subtitle={user ? `${user.name} · ${t('userMgmt.panelSubtitleHistory')}` : ''}>
      {loading ? (
        <div className="text-sm text-slate-400 py-6 text-center">{t('userMgmt.loading')}</div>
      ) : events.length === 0 ? (
        <div className="text-sm text-slate-400 py-6 text-center">{t('userMgmt.noHistory')}</div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {events.map((ev) => {
            const cfg = EVENT_CFG[ev.action] || { label: ev.action, labelKey: '', bg: '#F1F5F9', color: '#475569' };
            return (
              <div key={ev.id} style={{ border: '1px solid #E2E8F0', borderRadius: 12, padding: '12px 14px' }}>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="badge" style={{ background: cfg.bg, color: cfg.color, fontSize: 10.5, fontWeight: 700 }}>{cfg.labelKey ? t(cfg.labelKey, cfg.label) : cfg.label}</span>
                  <span className="text-[11px] text-slate-400">{formatDateTime(ev.created_at)}</span>
                </div>
                {ev.details && <div className="text-[13px] text-slate-700 leading-snug">{ev.details}</div>}
                <div className="text-[11px] text-slate-400 mt-1">
                  {t('userMgmt.by')} {ev.actor_name || t('userMgmt.unknown')}{ev.actor_role && codeLabel(ev.actor_role) !== '—' ? ` · ${codeLabel(ev.actor_role)}` : ''}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SlidePanel>
  );
}

function describeDeleteUserError(message: string): string {
  if (message.includes('missing capability delete_user')) return 'You do not have permission to delete users. This is restricted to administrators.';
  if (message.includes('self_delete')) return 'You cannot delete your own profile.';
  if (message.includes('last_admin')) return 'This is the only administrator left — deleting them would lock everyone out of User Management.';
  if (message.includes('already_deleted')) return 'This user has already been deleted. Refresh the list.';
  if (message.includes('unknown_user')) return 'That user no longer exists. Refresh the list.';
  if (message.includes('not_authenticated')) return 'Your session has expired — sign in again.';
  return message;
}

/**
 * Soft delete (no password step-up, as the client asked): the capability gate,
 * the RPC's self-delete / last-admin guards and the audit row are the controls.
 */
export function DeleteUserDialog({ user, onClose, onDeleted }: { user: DisplayUser | null; onClose: () => void; onDeleted: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { activeProfile } = useRoleContext();
  const [deleting, setDeleting] = useState(false);
  if (!user) return null;

  async function confirm() {
    if (!user || deleting) return;
    setDeleting(true);
    try {
      const { data, error } = await callRpc<{ ok: boolean }>('soft_delete_user', { p_user_id: user.id, p_actor_name: activeProfile.name });
      if (error) throw new Error(describeDeleteUserError(error.message));
      if (!data?.ok) throw new Error(t('userMgmt.deleteFailed', 'User could not be deleted.'));
      // Then revoke the sign-in, so they are not left logged in until the JWT expires.
      if (user.auth_user_id) {
        const authRes = await deleteLoginIdentity(user.auth_user_id, user.id);
        if (authRes.error) {
          toast.error(t('userMgmt.deleteAuthFailed', {
            defaultValue: 'Profile deleted, but their sign-in could not be revoked ({{msg}}). They may stay logged in until it expires, and their email cannot be reused yet — retry the delete.',
            msg: authRes.error,
          }));
          onDeleted();
          return;
        }
      }
      toast.success(t('userMgmt.deleteOk', 'User deleted successfully.'));
      onDeleted();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }} onClick={() => !deleting && onClose()}>
      <div role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()} className="bz bz-box w-full max-w-[440px]">
        <div className="bz-title">{t('userMgmt.deleteTitle', 'Delete this user?')}</div>
        <div className="bz-body">
          <div className="font-semibold">{user.name}{user.email ? ` · ${user.email}` : ''}</div>
          <div className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-red-900">
            {t('userMgmt.deleteBody', 'You are about to delete this user profile. The user will no longer appear in the User Management interface. Do you want to continue?')}
          </div>
          <div className="text-[11.5px] text-slate-500 mt-2">
            {t('userMgmt.deleteNote', 'The record is retained in the database for audit and can be restored by a developer if this was a mistake. The user is signed out and cannot log in again.')}
          </div>
        </div>
        <div className="flex justify-end gap-2 px-2 py-2 border-t border-slate-300 bg-slate-50">
          <button type="button" className="bz-btn bz-btn-danger inline-flex items-center gap-1" disabled={deleting} onClick={() => void confirm()}>
            <Trash2 size={13} />{deleting ? t('userMgmt.deleting', 'Deleting…') : t('userMgmt.deleteConfirm', 'Confirm Delete')}
          </button>
          <button type="button" className="bz-btn" disabled={deleting} onClick={onClose}>{t('common.cancel', 'Cancel')}</button>
        </div>
      </div>
    </div>
  );
}
