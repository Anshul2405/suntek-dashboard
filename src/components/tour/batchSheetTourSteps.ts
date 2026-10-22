import type { GuidedTourStep } from './GuidedTour';
import { BATCH_FLOW_TOUR_ID } from './batchFlowTourSession';

/** @deprecated use BATCH_FLOW_TOUR_ID — kept so old imports still resolve. */
export const BATCH_SHEET_TOUR_ID = BATCH_FLOW_TOUR_ID;

/**
 * Full Batch Sheet workflow walkthrough, in the order the plant actually works:
 * reactor starts → hourly readings → close → sheet with density + photos →
 * stock → dispatch. `path` navigates; `wizardStep` parks the create wizard.
 */
export const BATCH_SHEET_TOUR_STEPS: GuidedTourStep[] = [
  {
    id: 'welcome',
    path: '/dashboard/batches',
    titleKey: 'welcomeTitle',
    bodyKey: 'welcomeBody',
    titleDefault: 'The full batch workflow',
    bodyDefault:
      'This walkthrough follows one batch from the moment the reactor starts to the moment drums are dispatched.\n\nOrder of the tour:\n1. Start the batch (New Batch)\n2. Log hourly readings\n3. Close the batch\n4. Make the batch sheet (density + photos)\n5. Register, stock, dispatch\n\nPress Next — the app moves screens for you.',
  },
  {
    id: 'two-records',
    path: '/dashboard/batches',
    titleKey: 'twoRecordsTitle',
    bodyKey: 'twoRecordsBody',
    titleDefault: 'First: one batch, two records',
    bodyDefault:
      'A batch is stored as two separate things, and this is the main source of confusion:\n\n• Active batch — the LIVE run while the reactor is working. Hourly temperature / CP / Cl₂ readings go here.\n• Production batch sheet — the RECORD of the finished batch: density, evidence photos, and stock stage.\n\nBoth appear on this page: sheets on top, live runs below. Deleting one does not touch the other.',
  },

  // ── 1. Batch starts ───────────────────────────────────────────────────────
  {
    id: 'start-new-batch',
    path: '/dashboard/batch-entry?tab=new-batch',
    target: 'tour-new-batch',
    titleKey: 'startTitle',
    bodyKey: 'startBody',
    titleDefault: 'Step 1 — the reactor starts: New Batch',
    bodyDefault:
      'This is where a batch begins in the system, at charging time.\n\nYou enter:\n• Batch number for the run\n• Recipe / density (1300, 1400 …)\n• Target quantity in kg\n\nStart New Batch creates the Active Batch. From this moment the run is live and can accept readings. Nothing is written to the sheet register yet.',
  },

  // ── 2. Readings during the run ────────────────────────────────────────────
  {
    id: 'reading-pick',
    path: '/dashboard/batch-entry?tab=reading',
    target: 'tour-reading-batch',
    titleKey: 'readingPickTitle',
    bodyKey: 'readingPickBody',
    titleDefault: 'Step 2 — Log Reading: pick the running batch',
    bodyDefault:
      'While the reactor runs, the operator comes here every hour.\n\nFirst choose which active batch the reading belongs to. Only live runs appear in this list, shown as #batch number with its density.',
  },
  {
    id: 'reading-values',
    path: '/dashboard/batch-entry?tab=reading',
    target: 'tour-reading-values',
    titleKey: 'readingValuesTitle',
    bodyKey: 'readingValuesBody',
    titleDefault: 'Step 2 — the three readings',
    bodyDefault:
      'Three values per reading:\n\n• Temperature (°C)\n• CP gravity\n• Cl₂ pressure\n\nSave Reading stores it with the time and the operator name. These are the same numbers written on the paper hourly sheet, so the app and the paper stay comparable.',
  },
  {
    id: 'reading-log',
    path: '/dashboard/batch-entry?tab=reading',
    target: 'tour-reading-log',
    titleKey: 'readingLogTitle',
    bodyKey: 'readingLogBody',
    titleDefault: 'Step 2 — the live log',
    bodyDefault:
      'Every saved reading appears here for the selected batch, newest at the top, with the running time and the count at the bottom.\n\nThis log only shows on Log Reading and History. New Batch and Upload deliberately do not show it, so you never mistake another batch’s readings for the one you are starting.',
  },
  {
    id: 'close-batch',
    path: '/dashboard/batch-entry?tab=reading',
    target: 'tour-close-batch',
    titleKey: 'closeTitle',
    bodyKey: 'closeBody',
    titleDefault: 'Step 3 — closing the batch',
    bodyDefault:
      'When the reaction is finished, the run is closed from here.\n\nClosing is the point where yield QC is meant to run: actual drums and HCL against the oil-ratio table for that gravity, flagging anything beyond ±3%.\n\nBe aware for today: the calculation exists in the system, but the plant-facing close-and-QC screen is not finished. That is why the QC column still shows PENDING on every live row.',
  },
  {
    id: 'history',
    path: '/dashboard/batch-entry?tab=history',
    target: 'tour-log-reading',
    titleKey: 'historyTitle',
    bodyKey: 'historyBody',
    titleDefault: 'Reading History',
    bodyDefault:
      'History is the read-only view of the same data: choose any batch and see every reading logged against it.\n\nUse it to check a past batch without risk of adding a new reading by mistake.',
  },
  {
    id: 'upload-ocr',
    path: '/dashboard/batch-entry?tab=upload',
    target: 'tour-upload',
    titleKey: 'uploadTitle',
    bodyKey: 'uploadBody',
    titleDefault: 'Alternative — Upload Batch Sheet (OCR)',
    bodyDefault:
      'If the shift was written on paper first, photograph the sheet instead of retyping it.\n\nThe AI reads the header and the hourly rows into a review form. Every cell can be corrected before saving, and the original photo stays attached as evidence.\n\nThis is a faster way to enter the same readings — it is not a way to start a new run.',
  },

  // ── 4. Making the production sheet ────────────────────────────────────────
  {
    id: 'create-intro',
    path: '/dashboard/batch-entry?tab=create-sheet',
    target: 'tour-wizard-steps',
    wizardStep: 0,
    titleKey: 'createIntroTitle',
    bodyKey: 'createIntroBody',
    titleDefault: 'Step 4 — now the batch sheet itself',
    bodyDefault:
      'Once the product is made and sampled, the production batch sheet is created.\n\nIt is a four-stage form: Reactor → Density → Photos → Review. The four chips at the top show where you are; you cannot move on until the current stage is complete.\n\nThe next steps walk each stage.',
  },
  {
    id: 'wizard-reactor',
    path: '/dashboard/batch-entry?tab=create-sheet',
    target: 'tour-wizard-reactor',
    wizardStep: 0,
    titleKey: 'wizardReactorTitle',
    bodyKey: 'wizardReactorBody',
    titleDefault: 'Stage 1 — plant and reactor',
    bodyDefault:
      'Choose the factory, then the reactor that ran the batch (P1–P49 depending on plant).\n\nThe reactor decides the batch number. Each reactor keeps its own running sequence, so numbers read as reactor + sequence: P12-13 is the 13th batch on reactor P12.\n\nOnly plants that actually run batch sheets are listed here.',
  },
  {
    id: 'wizard-density',
    path: '/dashboard/batch-entry?tab=create-sheet',
    target: 'tour-wizard-density',
    wizardStep: 1,
    titleKey: 'wizardDensityTitle',
    bodyKey: 'wizardDensityBody',
    titleDefault: 'Stage 2 — density, colour, notes',
    bodyDefault:
      'Density is compulsory — it is the identity of the product and is what reports group on.\n\nColour label is optional and only exists to make batches searchable later; the photo is still the real evidence. Notes are free text for anything unusual in the batch.',
  },
  {
    id: 'wizard-photos',
    path: '/dashboard/batch-entry?tab=create-sheet',
    target: 'tour-wizard-photos',
    wizardStep: 2,
    titleKey: 'wizardPhotosTitle',
    bodyKey: 'wizardPhotosBody',
    titleDefault: 'Stage 3 — three compulsory photos',
    bodyDefault:
      'All three slots are required, up to two photos each, taken with the camera or uploaded:\n\n• Batch sheet — the physical sheet\n• Bucket / balti — colour of the product in the bucket\n• Heat sample — colour of the finished product after heat\n\nThe form will not submit until all three are present. This is the evidence trail that replaces trusting the number alone.',
  },
  {
    id: 'wizard-review',
    path: '/dashboard/batch-entry?tab=create-sheet',
    target: 'tour-wizard-review',
    wizardStep: 3,
    titleKey: 'wizardReviewTitle',
    bodyKey: 'wizardReviewBody',
    titleDefault: 'Stage 4 — review and submit',
    bodyDefault:
      'A last check of plant, reactor, density, colour and the photo count.\n\nThe batch number is allocated at submit, not before — that keeps the sequence gap-free even when two people create sheets at the same time. Photos upload, the sheet is written with stage Created, and you are taken to the register with the new number highlighted.',
  },

  // ── 5. Register, stock, dispatch ──────────────────────────────────────────
  {
    id: 'register',
    path: '/dashboard/batches',
    target: 'prod-register',
    titleKey: 'registerTitle',
    bodyKey: 'registerBody',
    titleDefault: 'Step 5 — the sheet register',
    bodyDefault:
      'Every submitted sheet lands in this table, one row per batch: batch no, plant, reactor, reactor sequence, density, photo links, stage and who created it.\n\nThe photo links open the original images. If this table says empty, no sheet has been created in this flow yet — the first Create fills it.',
  },
  {
    id: 'stage',
    path: '/dashboard/batches',
    target: 'prod-stage',
    titleKey: 'stageTitle',
    bodyKey: 'stageBody',
    titleDefault: 'Step 6 — Created → In stock → Dispatched',
    bodyDefault:
      'The stage column is the life of the batch after production, and it only moves forward.\n\nCreated means produced and recorded. In stock means drums are in the yard. Dispatched means gone to the customer.\n\nOnly the Factory Accountant can advance a stage from this page; other roles see the row but not the action. Customer and billing linkage is deliberately not built yet.',
  },
  {
    id: 'active-back',
    path: '/dashboard/batches',
    target: 'active-batches',
    titleKey: 'activeTitle',
    bodyKey: 'activeBody',
    titleDefault: 'The live table, back on this page',
    bodyDefault:
      'The lower table is the other half — the live runs from step 1 and 2, updating as readings are saved.\n\nTest names such as p11-dummy sit here. Deleting a row from the sheet register above will not remove them, because they are runs, not sheets. They have to be closed or cleaned separately.',
  },
  {
    id: 'qc',
    path: '/dashboard/batches',
    target: 'qc-col',
    titleKey: 'qcTitle',
    bodyKey: 'qcBody',
    titleDefault: 'Why QC says PENDING',
    bodyDefault:
      'PENDING simply means the batch is still open, so yield QC has not run.\n\nIt is not a warning and not missing paperwork. Pass or flag comes from comparing the closed batch against the oil-ratio table, which is step 3 of this workflow.',
  },
  {
    id: 'kpis',
    path: '/dashboard/batches',
    target: 'batch-kpis',
    titleKey: 'kpisTitle',
    bodyKey: 'kpisBody',
    titleDefault: 'Reading the four counters',
    bodyDefault:
      'Active batches counts open runs. Prod. sheets counts rows in the register. They are different numbers by design and should not match.\n\nAvg yield and Variance flagged stay empty until batches are being closed with QC, for the same reason as the PENDING badge.',
  },
  {
    id: 'done',
    path: '/dashboard/batches',
    titleKey: 'doneTitle',
    bodyKey: 'doneBody',
    titleDefault: 'The whole flow in one page',
    bodyDefault:
      'New Batch starts the run → Log Reading records it hourly → Close runs yield QC → Create Batch Sheet records density and photos as P12-13 → the register holds it → the accountant moves it to stock, then dispatch. Upload OCR is the paper shortcut into the readings.\n\nOpen questions for the plant: who creates the sheet, who closes the run, and whether every batch gets a sheet or only the ones that go to stock.\n\nReplay this anytime with How this works.',
  },
];
