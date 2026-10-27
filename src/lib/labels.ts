/**
 * Readable words for codes that reach the screen (statuses, modules, actions).
 * Display only — the database values are unchanged.
 */
const KNOWN: Record<string, string> = {
  pending: 'Pending',
  pending_store: 'Store check',
  pending_approval: 'Unit head approval',
  pending_unit_head: 'Unit head approval',
  pending_vijay: 'Vijay ji',
  pending_buyer: 'Purchaser',
  pending_purchase: 'Purchaser',
  pending_purchase_manager: 'Purchaser',
  pending_handover: 'Handover',
  in_transit: 'In transit',
  approved: 'Approved',
  rejected: 'Rejected',
  dispatched: 'Dispatched',
  received: 'Received',
  changes_requested: 'Changes requested',
  false_positive: 'False alarm',
  // Modules (opsControls MODULES keys + audit modules)
  stock: 'Stock Register',
  maintenance: 'Maintenance',
  batch: 'Batch Sheet',
  far: 'FAR',
  purchase: 'Purchases',
  store_req: 'Store requisitions',
  access: 'Access & backup',
  backup: 'Backup',
  // Roles
  factory_operator: 'Technical',
  unit_head: 'Unit head',
  management: 'Management',
  admin: 'Admin',
  purchase_manager: 'Purchase manager',
  accountant_delhi: 'Accounts (Delhi)',
  accountant_other: 'Accounts',
  technician_shd: 'Technician',
};

/** "pending_vijay" → "Vijay ji"; unknown codes → "Some code" (never a slug). */
export function codeLabel(code: string | null | undefined): string {
  const raw = (code || '').trim();
  if (!raw) return '—';
  const known = KNOWN[raw.toLowerCase()];
  if (known) return known;
  // A personal profile id (db_<uuid>) is not a role name.
  if (/^db_[0-9a-f-]{8,}$/i.test(raw)) return '—';
  const words = raw.replace(/[_-]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
