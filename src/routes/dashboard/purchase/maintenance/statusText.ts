import type { TFunction } from 'i18next';
import { STATUS_CFG } from './shared';

/** Ticket status as people say it ("Pending Store"), never the DB slug. */
export function statusText(status: string, t?: TFunction): string {
  const cfg = STATUS_CFG[status];
  if (!cfg) return status.replace(/_/g, ' ');
  return t && cfg.labelKey ? t(cfg.labelKey, cfg.label) : cfg.label;
}
