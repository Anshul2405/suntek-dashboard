import { insertRows } from './db';
import { probeColumn } from './schemaProbe';
import type { Database } from './database.types';
import type { ActivityEntityType } from './activityLinks';

type ActivityInsert = Database['public']['Tables']['activity_logs']['Insert'];

/**
 * Write an Activity Log row that points at its entry (entity_type + entity_id).
 * The two columns arrive with migration 0042; until it is applied the row is
 * written without them (the log then opens it by name, or in its own panel).
 */
export async function logActivity(
  row: ActivityInsert,
  entity?: { type: ActivityEntityType; id: string } | null,
  /** Write nothing when the row could not point at its entry (new row types). */
  opts?: { onlyIfLinked?: boolean },
) {
  const typed = !!entity && (await probeColumn('activity_logs', 'entity_type'));
  if (opts?.onlyIfLinked && !typed) return { data: null, error: null };
  return insertRows('activity_logs', typed && entity ? { ...row, entity_type: entity.type, entity_id: entity.id } : row);
}
