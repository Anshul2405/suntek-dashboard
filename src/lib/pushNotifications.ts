/**
 * Browser Notification API helpers — desktop/mobile push when the tab is
 * backgrounded. Requires a one-time permission grant from Settings / TopBar.
 */

const PREF_KEY = 'suntek.push.enabled';

export function isPushSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function getPushPermission(): NotificationPermission | 'unsupported' {
  if (!isPushSupported()) return 'unsupported';
  return Notification.permission;
}

export function isPushEnabledLocally(): boolean {
  try { return localStorage.getItem(PREF_KEY) === '1'; } catch { return false; }
}

export function setPushEnabledLocally(on: boolean): void {
  try { localStorage.setItem(PREF_KEY, on ? '1' : '0'); } catch { /* ignore */ }
}

/** Ask the browser for permission; returns the resulting permission. */
export async function requestPushPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!isPushSupported()) return 'unsupported';
  if (Notification.permission === 'granted') {
    setPushEnabledLocally(true);
    return 'granted';
  }
  if (Notification.permission === 'denied') return 'denied';
  try {
    const result = await Notification.requestPermission();
    if (result === 'granted') setPushEnabledLocally(true);
    return result;
  } catch {
    return Notification.permission;
  }
}

/**
 * Fire a system notification when the document is hidden (or always if
 * `force`). No-ops when permission is missing or the user disabled the pref.
 */
export function showBrowserPush(opts: {
  title: string;
  body?: string | null;
  tag?: string;
  onClickUrl?: string | null;
  force?: boolean;
}): void {
  if (!isPushSupported()) return;
  if (Notification.permission !== 'granted') return;
  if (!isPushEnabledLocally() && !opts.force) return;
  if (!opts.force && typeof document !== 'undefined' && !document.hidden) return;

  try {
    const n = new Notification(opts.title, {
      body: opts.body || undefined,
      tag: opts.tag,
      icon: `${window.location.origin}/brand/suntek-official.png`,
      badge: `${window.location.origin}/brand/suntek-icon.png`,
    });
    n.onclick = () => {
      window.focus();
      if (opts.onClickUrl) {
        try {
          const path = opts.onClickUrl.startsWith('http')
            ? new URL(opts.onClickUrl).pathname + new URL(opts.onClickUrl).search
            : opts.onClickUrl;
          window.location.assign(path);
        } catch { /* ignore */ }
      }
      n.close();
    };
  } catch {
    /* Safari private mode etc. */
  }
}
