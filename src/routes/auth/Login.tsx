import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { SuntekLogo } from '../../components/brand/SuntekLogo';

/**
 * Where to send the user after login. Honors a `?redirect=` set by the auth gate
 * (e.g. after scanning a QR while logged out), but ONLY same-origin relative
 * paths — must start with a single "/" (not "//" or a scheme) to prevent an
 * open-redirect. Falls back to the dashboard.
 */
function safeRedirect(raw: string | null): string {
  if (!raw) return '/dashboard';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/dashboard';
  return raw;
}

export function Login() {
  const { t } = useTranslation();
  // The login page must ALWAYS render in English, even when the user picked Hindi
  // inside the authenticated app (the choice persists in localStorage). Resolve
  // every login label against the English resources without mutating the stored
  // preference, so the app still opens in the user's language after sign-in.
  const tf = (key: string, opts?: Record<string, unknown>) => t(key, { lng: 'en', ...opts });
  const { signIn, loading, error, session } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const dest = safeRedirect(params.get('redirect'));

  useEffect(() => {
    if (session) navigate(dest, { replace: true });
  }, [session, navigate, dest]);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    const ok = await signIn(identifier, password);
    setSubmitting(false);
    if (ok) {
      navigate(dest);
    }
  }

  return (
    <div className="login-shell min-h-screen flex items-stretch">
      {/* Brand plane — plant / CPW atmosphere */}
      <aside className="login-brand hidden lg:flex flex-col justify-between p-10 xl:p-14 text-white relative overflow-hidden">
        <div className="login-brand-grid" aria-hidden />
        <div className="relative z-10">
          <SuntekLogo size={56} withWordmark inverse />
        </div>
        <div className="relative z-10 max-w-md">
          <p className="login-kicker">India’s largest CPW producer</p>
          <h1 className="font-heading text-[2.35rem] xl:text-[2.75rem] font-semibold leading-[1.12] tracking-tight mt-3">
            Plant operations<br />for Suntek Group
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed text-white/70">
            Batch sheets, maintenance, and store — built for units across Jharkhand, Odisha, Madan, and HQ.
          </p>
          <ul className="mt-8 space-y-2.5 text-[13px] text-white/65">
            <li className="flex gap-2"><span className="text-[#FF8A00]">▸</span> L0 Admin provisions L1–L4 roles</li>
            <li className="flex gap-2"><span className="text-[#FF8A00]">▸</span> Batch OCR + evidence photos</li>
            <li className="flex gap-2"><span className="text-[#FF8A00]">▸</span> Maintenance → store indent chain</li>
          </ul>
        </div>
        <p className="relative z-10 text-[11px] text-white/40 tracking-wide uppercase">
          thesuntek.com · Zero Discharge · Zero Accident
        </p>
      </aside>

      {/* Form plane */}
      <main className="flex-1 flex items-center justify-center p-6 sm:p-10 bg-[var(--bg-soft)] relative">
        <div className="login-form-aura" aria-hidden />
        <div className="w-full max-w-[400px] relative z-10 login-form-enter">
          <div className="lg:hidden mb-8">
            <SuntekLogo size={48} withWordmark />
          </div>

          <div className="mb-6">
            <h2 className="font-heading text-[1.65rem] font-semibold tracking-tight text-[var(--dark)]">
              {tf('login.signIn')}
            </h2>
            <p className="text-sm text-slate-500 mt-1">{tf('login.subtitle')}</p>
          </div>

          <div className="bg-white rounded-[20px] border border-[var(--border)] shadow-[0_20px_50px_-28px_rgba(11,31,51,0.45)] p-6 sm:p-7">
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">
                  {tf('login.identifierLabel')}
                </label>
                <input
                  type="text"
                  required
                  autoComplete="username"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  placeholder={tf('login.identifierPlaceholder')}
                  className="login-input"
                />
              </div>
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">
                  {tf('login.passwordLabel')}
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="login-input pr-11"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? tf('login.hidePassword') : tf('login.showPassword')}
                    className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-slate-700 cursor-pointer"
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              {error && (
                <p className="text-xs text-red-700 bg-red-50 border border-red-100 rounded-xl px-3 py-2.5">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={submitting || loading}
                className="login-submit cursor-pointer"
              >
                {submitting ? tf('login.signingIn') : tf('login.signIn')}
              </button>
            </form>

            {import.meta.env.DEV && (
              <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-xl">
                <p className="text-xs text-amber-700 font-medium">{tf('login.devMode')}</p>
                <p className="text-xs text-amber-600 mt-0.5">{tf('login.devModeHint')}</p>
                <button
                  type="button"
                  onClick={() => navigate(dest)}
                  className="mt-2 text-xs font-semibold text-amber-700 underline hover:no-underline cursor-pointer"
                >
                  {tf('login.enterDashboard')}
                </button>
              </div>
            )}
          </div>

          <div className="mt-6 flex flex-wrap gap-2">
            {[
              { role: 'L0', label: 'Admin' },
              { role: 'L1', label: 'Management' },
              { role: 'L2', label: 'Unit Head' },
              { role: 'L3', label: 'Managers' },
              { role: 'L4', label: 'Ops & Foremen' },
            ].map(({ role, label }) => (
              <span key={role} className="login-tier-chip">
                <strong>{role}</strong> {label}
              </span>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
