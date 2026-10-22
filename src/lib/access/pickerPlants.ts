/** Plants a person may pick. Blank grant = none, never "every plant". */
export function plantsForPicker<T>(allowed: T[], ready: boolean): T[] {
  if (!ready) return [];
  return allowed;
}
