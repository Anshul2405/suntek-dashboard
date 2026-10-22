/**
 * Turning failures into something a person can act on.
 *
 * The app talks to Postgres, PostgREST, Supabase Auth and an edge function, and
 * each reports failure in a different shape — an `Error`, a `{ message, code,
 * details, hint }` object, a `FunctionsHttpError` whose real body is buried in
 * `.context`, or occasionally a bare object with nothing useful in it at all.
 * Toasts were interpolating those straight into the message, which is how a
 * store manager ended up staring at `Login update failed: {}`.
 *
 * Two jobs here:
 *   rawErrorText()  — dig the best available technical string out of ANY shape
 *   humanizeError() — say what actually happened, in plain language
 *
 * The technical detail is never thrown away: it goes to the console, and when
 * nothing is recognisable the user gets a short reference code they can quote
 * to whoever supports them. "Something went wrong" with no way to trace it is
 * as unhelpful as `{}`.
 */

/** Pull the most useful technical string out of whatever was thrown. */
export function rawErrorText(e: unknown): string {
  if (e == null) return '';
  if (typeof e === 'string') return e.trim();
  if (e instanceof Error) return e.message;

  const o = e as {
    message?: unknown; error?: unknown; error_description?: unknown;
    details?: unknown; hint?: unknown; code?: unknown; msg?: unknown;
  };
  // `error` may itself be a nested object (an edge function forwarding a
  // Postgres error verbatim) — recurse rather than stringifying to "[object Object]".
  for (const key of ['message', 'error_description', 'msg', 'error', 'details', 'hint'] as const) {
    const v = o[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (v && typeof v === 'object') {
      const nested = rawErrorText(v);
      if (nested) return nested;
    }
  }
  if (typeof o.code === 'string' && o.code) return `Error ${o.code}`;

  // Nothing readable. Don't return "{}" or "[object Object]".
  return '';
}

/** Postgres SQLSTATE, when the error carries one. */
function sqlState(e: unknown): string {
  const c = (e as { code?: unknown })?.code;
  return typeof c === 'string' ? c : '';
}

/** Short, stable-ish reference so a user can quote an otherwise opaque failure. */
function referenceCode(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h.toString(36).toUpperCase().slice(0, 5).padStart(5, '0');
}

export interface HumanizeOptions {
  /** What the user was trying to do, e.g. "save this user". Completes "Couldn't …". */
  action?: string;
  /** Logged alongside the raw error so support can find it. */
  context?: string;
}

/**
 * A sentence the person in front of the screen can understand — and, where
 * possible, act on.
 *
 * Messages the backend already wrote for humans (our edge function's
 * "Forbidden — you cannot assign that role…", "Password must be at least 8
 * characters") are passed through untouched: rewording them would lose detail
 * the user needs.
 */
export function humanizeError(e: unknown, opts: HumanizeOptions = {}): string {
  const raw = rawErrorText(e);
  const state = sqlState(e);
  const low = raw.toLowerCase();
  const doing = opts.action ? `Couldn't ${opts.action}` : 'Something went wrong';

  // Keep the technical detail reachable without putting it in front of the user.
  if (raw || e) {
    // eslint-disable-next-line no-console
    console.error(`[${opts.context ?? 'error'}]`, raw || e, e);
  }

  // ── Already written for a human by our own backend ────────────────────────
  if (/^forbidden\s*—/i.test(raw) || /^password must be/i.test(raw)) return raw;

  // ── Connectivity ──────────────────────────────────────────────────────────
  if (
    low.includes('failed to send a request') || low.includes('failed to fetch') ||
    low.includes('networkerror') || low.includes('load failed') ||
    low.includes('err_internet') || low.includes('timeout')
  ) {
    return `${doing} — the server couldn't be reached. Check your internet connection and try again.`;
  }

  // ── Session / permission ──────────────────────────────────────────────────
  if (low.includes('jwt expired') || low.includes('invalid or expired session') || low.includes('refresh token')) {
    return 'Your session has expired. Please sign in again.';
  }
  if (low.includes('missing authorization') || low.includes('not_authenticated')) {
    return 'You are signed out. Please sign in again.';
  }
  if (state === '42501' || low.includes('row-level security') || low.includes('permission denied') || low.includes('forbidden')) {
    return `${doing} — you don't have permission for this. Ask an admin if you think you should.`;
  }

  // ── Data conflicts ────────────────────────────────────────────────────────
  if (state === '23505' || low.includes('duplicate key') || low.includes('already registered') || low.includes('already been registered')) {
    if (low.includes('mobile')) return 'That mobile number is already used by another user.';
    if (low.includes('email') || low.includes('registered')) return 'That email address is already in use by another account.';
    if (low.includes('item_name') || low.includes('store_items')) return 'That item already exists in this store.';
    return `${doing} — one of these values is already in use. Change it and try again.`;
  }
  if (state === '23503' || low.includes('violates foreign key')) {
    return `${doing} — it is still linked to other records. Remove those links first.`;
  }
  if (state === '23514' || low.includes('violates check constraint')) {
    if (low.includes('on_hand')) return 'That would take stock below zero. Check the quantity and try again.';
    if (low.includes('reserved')) return 'That would reserve more than is on hand.';
    return `${doing} — one of the values is out of the allowed range.`;
  }
  if (state === '22P02' || low.includes('invalid input syntax')) {
    if (low.includes('integer') || low.includes('oil_ratio')) {
      return `${doing} — oil ratio still has to be a number in the database. Run supabase-queries/88_oil_ratio_text.sql, then try again (values like 52% or dummy need that update).`;
    }
    return `${doing} — one field has the wrong type. Check the values and try again.`;
  }
  if (low.includes('not_found') || state === 'PGRST116') {
    return `${doing} — the record no longer exists. Refresh the page and try again.`;
  }

  // ── Schema drift — the code expects a database shape that isn't there ─────
  // These all mean the same thing to a user: the app and the database are out
  // of step. Postgres words it very differently each time, and none of those
  // words help someone trying to upload a spreadsheet.
  //   42703 undefined column · 42P01 undefined table · 42883 undefined function
  //   42P10 bad ON CONFLICT target (a constraint the code expects is missing)
  //   PGRST202/PGRST204 PostgREST cannot find the function/column
  if (
    state === '42703' || state === '42P01' || state === '42883' || state === '42P10' ||
    state === 'PGRST202' || state === 'PGRST204' ||
    low.includes('does not exist') ||
    low.includes('on conflict specification') ||
    low.includes('no unique or exclusion constraint') ||
    low.includes('schema cache')
  ) {
    return `${doing} — the app is expecting a database update that hasn't been applied yet. Nothing has been changed. Please send this to your administrator: a pending database migration needs to be run.`;
  }

  // ── Recognisable but not mapped: show it, it is better than nothing ───────
  if (raw && raw.length <= 160 && !raw.startsWith('{')) {
    return `${doing}: ${raw}`;
  }

  // ── Nothing usable. Be honest, and give them something to quote. ──────────
  const ref = referenceCode(raw || String(opts.context ?? '') || 'unknown');
  return `${doing} — an unexpected error occurred. Please try again. If it keeps happening, quote reference ${ref} to support.`;
}
