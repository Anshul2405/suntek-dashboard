/**
 * Cross-route Batch Sheet flow tour session.
 * Survives navigations between /dashboard/batches and /dashboard/batch-entry?tab=…
 */
import { markTourSeen } from './GuidedTour';

export const BATCH_FLOW_TOUR_ID = 'batch-sheet-flow-v3';
export const BATCH_FLOW_TOUR_EVENT = 'suntek-batch-flow-tour';
/** Lets the tour drive the Create-sheet wizard so each stage can be spotlit. */
export const BATCH_FLOW_WIZARD_EVENT = 'suntek-batch-flow-tour-wizard';

const SESSION_KEY = `suntek.tour.${BATCH_FLOW_TOUR_ID}.session`;
const WIZARD_KEY = `suntek.tour.${BATCH_FLOW_TOUR_ID}.wizard`;

export type BatchFlowTourSession = {
  open: boolean;
  index: number;
};

export function readBatchFlowTourSession(): BatchFlowTourSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BatchFlowTourSession;
    if (typeof parsed?.open !== 'boolean' || typeof parsed?.index !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeBatchFlowTourSession(session: BatchFlowTourSession): void {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    /* ignore */
  }
}

export function clearBatchFlowTourSession(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(WIZARD_KEY);
  } catch {
    /* ignore */
  }
}

/** Ask the Create-sheet wizard to show a given stage (0-3), or release it (null). */
export function requestWizardStep(step: number | null): void {
  try {
    if (step == null) sessionStorage.removeItem(WIZARD_KEY);
    else sessionStorage.setItem(WIZARD_KEY, String(step));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(BATCH_FLOW_WIZARD_EVENT));
}

export function readWizardStep(): number | null {
  try {
    const raw = sessionStorage.getItem(WIZARD_KEY);
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 && n <= 3 ? n : null;
  } catch {
    return null;
  }
}

/** Start (or restart) the multi-screen Batch Sheet tour. */
export function startBatchFlowTour(): void {
  writeBatchFlowTourSession({ open: true, index: 0 });
  window.dispatchEvent(new Event(BATCH_FLOW_TOUR_EVENT));
}

export function stopBatchFlowTour(): void {
  clearBatchFlowTourSession();
  markTourSeen(BATCH_FLOW_TOUR_ID);
  window.dispatchEvent(new Event(BATCH_FLOW_TOUR_EVENT));
}

export function setBatchFlowTourIndex(index: number): void {
  const cur = readBatchFlowTourSession();
  if (!cur?.open) return;
  writeBatchFlowTourSession({ open: true, index });
  window.dispatchEvent(new Event(BATCH_FLOW_TOUR_EVENT));
}

export function tourPathMatches(pathname: string, search: string, desired?: string): boolean {
  if (!desired) return true;
  try {
    const want = new URL(desired, window.location.origin);
    if (want.pathname !== pathname) return false;
    const wantTab = want.searchParams.get('tab');
    if (!wantTab) return true;
    return new URLSearchParams(search).get('tab') === wantTab;
  } catch {
    return false;
  }
}
