/**
 * Host for the multi-screen Batch Sheet tour.
 * Mount once in DashboardLayout so Next can navigate Create / New Batch / Log / Upload.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { GuidedTour } from './GuidedTour';
import { BATCH_SHEET_TOUR_STEPS } from './batchSheetTourSteps';
import {
  BATCH_FLOW_TOUR_EVENT,
  BATCH_FLOW_TOUR_ID,
  readBatchFlowTourSession,
  requestWizardStep,
  startBatchFlowTour,
  stopBatchFlowTour,
  tourPathMatches,
  writeBatchFlowTourSession,
} from './batchFlowTourSession';

export function BatchFlowTourHost() {
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);

  const syncFromSession = useCallback(() => {
    const s = readBatchFlowTourSession();
    if (s?.open) {
      setOpen(true);
      setIndex(s.index);
    } else {
      setOpen(false);
      setIndex(0);
    }
  }, []);

  useEffect(() => {
    syncFromSession();
    const onEvt = () => syncFromSession();
    window.addEventListener(BATCH_FLOW_TOUR_EVENT, onEvt);
    return () => window.removeEventListener(BATCH_FLOW_TOUR_EVENT, onEvt);
  }, [syncFromSession]);

  // Navigate to the step's screen when index changes.
  useEffect(() => {
    if (!open) return;
    const step = BATCH_SHEET_TOUR_STEPS[index];
    if (!step?.path) return;
    if (tourPathMatches(location.pathname, location.search, step.path)) return;
    navigate(step.path);
  }, [open, index, location.pathname, location.search, navigate]);

  // Drive the Create-sheet wizard so each of its four stages can be spotlit.
  useEffect(() => {
    if (!open) {
      requestWizardStep(null);
      return;
    }
    requestWizardStep(BATCH_SHEET_TOUR_STEPS[index]?.wizardStep ?? null);
  }, [open, index]);

  const onStepIndexChange = useCallback((next: number) => {
    setIndex(next);
    writeBatchFlowTourSession({ open: true, index: next });
  }, []);

  const onClose = useCallback(() => {
    stopBatchFlowTour();
    setOpen(false);
    // Land back on the register so they finish where they started.
    if (location.pathname !== '/dashboard/batches') {
      navigate('/dashboard/batches');
    }
  }, [location.pathname, navigate]);

  // Only show overlay on batch-related routes (avoid covering unrelated pages if they navigate away).
  const onBatchFlowRoute =
    location.pathname === '/dashboard/batches'
    || location.pathname === '/dashboard/batch-entry';

  if (!open || !onBatchFlowRoute) return null;

  return (
    <GuidedTour
      open={open}
      steps={BATCH_SHEET_TOUR_STEPS}
      stepIndex={index}
      onStepIndexChange={onStepIndexChange}
      onClose={onClose}
      i18nPrefix="batchSheetTour"
    />
  );
}

/** Imperative start used by Batch Sheet “How this works”. */
export function launchBatchFlowTour() {
  startBatchFlowTour();
}

export { BATCH_FLOW_TOUR_ID };
