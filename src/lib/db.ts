import { supabase } from './supabase';
import type { Database } from './database.types';

type Tables = Database['public']['Tables'];
type TableName = keyof Tables;

/**
 * Typed write helpers.
 *
 * The schema in database.types.ts is intentionally "loose" (see the note there),
 * so the typed client resolves `.insert()/.update()` payloads to `never`. These
 * helpers enforce the Insert/Update SHAPE at the CALL SITE, then confine the one
 * unavoidable cast to this single file — instead of scattering
 * `(supabase.from(x) as any)` across every page. Reads stay fully typed via
 * `supabase.from(x).select(...).returns<T>()`.
 *
 * The returned builder is chainable (`.select().single()`, `.eq(...)`, etc.)
 * exactly like the native query builder.
 */
export function insertRows<T extends TableName>(
  table: T,
  values: Tables[T]['Insert'] | Tables[T]['Insert'][],
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (supabase.from(table) as any).insert(values);
}

export function updateRows<T extends TableName>(table: T, values: Tables[T]['Update']) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (supabase.from(table) as any).update(values);
}

export function upsertRows<T extends TableName>(
  table: T,
  values: Tables[T]['Insert'] | Tables[T]['Insert'][],
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (supabase.from(table) as any).upsert(values);
}

/**
 * Call a Postgres RPC (SECURITY DEFINER function). The loose schema carries no
 * Functions metadata, so — exactly like the write helpers above — the one cast
 * lives here and callers stay typed on the result.
 */
export async function callRpc<T = unknown>(
  fn: 'apply_stock_purchase' | 'resolve_stock_anomaly' | 'apply_repair_return' | 'reverse_repair_return'
    | 'record_defective_disposition'
    | 'preview_import_batch' | 'delete_import_batch' | 'delete_import_batches'
    | 'soft_delete_user' | 'restore_deleted_user'
    | 'allocate_production_batch_numbers'
    | 'latest_batch_closing_balance',
  args: Record<string, unknown>,
): Promise<{ data: T | null; error: { message: string } | null }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return await (supabase.rpc as any)(fn, args);
}
