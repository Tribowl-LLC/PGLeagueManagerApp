import { z } from "zod";

export const MANAGE_PAYMENTS_CONTRACT_VERSION = 1 as const;
export const MANAGE_PAYMENTS_CHANGED_ROWS_MAX = 1_000;
export const MANAGE_PAYMENTS_STATE_FINGERPRINT_PREFIX = "lvmanagepayments:v1:";

export const MANAGE_PAYMENT_FEE_COMPONENTS = ["full", "lineage", "prize"] as const;
export type ManagePaymentFeeComponent = (typeof MANAGE_PAYMENT_FEE_COMPONENTS)[number];

const positiveId = z.number().int().positive().max(2_147_483_647);
const safeMinor = z.number().int().safe();
const nonnegativeMinor = safeMinor.min(0).max(2_147_483_647);
const positiveMinor = nonnegativeMinor.min(1);
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const offsetDateTime = z.string().datetime({ offset: true });
const stateFingerprint = z.string().regex(/^lvmanagepayments:v1:[0-9a-f]{64}$/);
const idempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);

export const managePaymentsOccurrenceSchema = z.object({
  occurrenceId: z.string().uuid(),
  localDate,
  localStartTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  timeZone: z.string().min(1).max(128),
});
export type ManagePaymentsOccurrence = z.infer<typeof managePaymentsOccurrenceSchema>;

export const managePaymentsWeekOptionSchema = managePaymentsOccurrenceSchema.extend({
  label: z.string().min(1).max(160),
});
export type ManagePaymentsWeekOption = z.infer<typeof managePaymentsWeekOptionSchema>;

export const managePaymentsFeeTermsSchema = z.object({
  fullMinor: positiveMinor,
  lineageMinor: nonnegativeMinor,
  prizeMinor: nonnegativeMinor,
});
export type ManagePaymentsFeeTerms = z.infer<typeof managePaymentsFeeTermsSchema>;

export const managePaymentsCardReceiptSchema = z.object({
  paymentId: positiveId,
  type: z.enum(["credit_card", "square"]),
  amountMinor: positiveMinor,
  collectionLocalDate: localDate,
  recordedAt: offsetDateTime,
  receiptNumber: z.string().max(255).nullable(),
});
export type ManagePaymentsCardReceipt = z.infer<typeof managePaymentsCardReceiptSchema>;

export const managePaymentsManualReceiptSchema = z.object({
  receiptId: z.string().uuid(),
  revision: z.number().int().positive(),
  paymentId: positiveId,
  type: z.enum(["cash", "check"]),
  amountMinor: positiveMinor,
  businessCollectionLocalDate: localDate,
}).strict();
export type ManagePaymentsManualReceipt = z.infer<typeof managePaymentsManualReceiptSchema>;

export const managePaymentsRowSchema = z.object({
  bowlerId: positiveId,
  displayName: z.string().min(1).max(200),
  rosterRole: z.enum(["main", "substitute"]),
  responsible: z.boolean(),
  feeComponent: z.enum(MANAGE_PAYMENT_FEE_COMPONENTS),
  feeMinor: nonnegativeMinor,
  /** Signed cents: positive is credit, negative is owed, and zero is even. */
  balanceMinor: safeMinor,
  cardReceipts: z.array(managePaymentsCardReceiptSchema),
  manualReceipts: z.array(managePaymentsManualReceiptSchema),
  finalTwoWeeksPaid: z.boolean(),
});
export type ManagePaymentsRow = z.infer<typeof managePaymentsRowSchema>;

export const managePaymentsTeamSchema = z.object({
  teamId: positiveId,
  teamName: z.string().min(1).max(200),
  rows: z.array(managePaymentsRowSchema),
});
export type ManagePaymentsTeam = z.infer<typeof managePaymentsTeamSchema>;

export const managePaymentsSnapshotSchema = z.object({
  contractVersion: z.literal(MANAGE_PAYMENTS_CONTRACT_VERSION),
  league: z.object({
    leagueId: positiveId,
    name: z.string().min(1).max(200),
    timeZone: z.string().min(1).max(128),
    feeTerms: managePaymentsFeeTermsSchema,
  }),
  weekOptions: z.array(managePaymentsWeekOptionSchema),
  selectedOccurrence: managePaymentsOccurrenceSchema,
  weekConfirmed: z.boolean(),
  needsConfirmation: z.boolean(),
  revision: z.number().int().nonnegative(),
  stateFingerprint,
  teams: z.array(managePaymentsTeamSchema),
}).superRefine((snapshot, context) => {
  const seenBowlerIds = new Map<number, { teamIndex: number; rowIndex: number }>();
  snapshot.teams.forEach((team, teamIndex) => {
    team.rows.forEach((row, rowIndex) => {
      const previous = seenBowlerIds.get(row.bowlerId);
      if (previous) {
        context.addIssue({
          code: "custom",
          path: ["teams", teamIndex, "rows", rowIndex, "bowlerId"],
          message: `Bowler ${row.bowlerId} appears in more than one team row for this league week.`,
        });
      } else {
        seenBowlerIds.set(row.bowlerId, { teamIndex, rowIndex });
      }
    });
  });
});
export type ManagePaymentsSnapshot = z.infer<typeof managePaymentsSnapshotSchema>;

const managePaymentsManualReceiptEditSchema = z.object({
  receiptId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
  /** Zero logically clears this exact cash/check payment. */
  amountMinor: nonnegativeMinor,
}).strict();

const managePaymentsChangedRowSchema = z.object({
  teamId: positiveId,
  bowlerId: positiveId,
  responsible: z.boolean(),
  feeComponent: z.enum(MANAGE_PAYMENT_FEE_COMPONENTS),
  /** Each edit addresses one existing cash/check receipt; omitted means unchanged. */
  manualReceiptEdits: z.array(managePaymentsManualReceiptEditSchema),
  /** Only used when the row has no manual receipt; zero means no new receipt. */
  newManualReceiptAmountMinor: nonnegativeMinor.optional(),
}).strict().superRefine((row, context) => {
  const seenReceiptIds = new Set<string>();
  row.manualReceiptEdits.forEach((edit, index) => {
    if (seenReceiptIds.has(edit.receiptId)) {
      context.addIssue({
        code: "custom",
        path: ["manualReceiptEdits", index, "receiptId"],
        message: "A manual receipt may be edited at most once per save.",
      });
    }
    seenReceiptIds.add(edit.receiptId);
  });
  if (row.manualReceiptEdits.length > 0 && row.newManualReceiptAmountMinor !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["newManualReceiptAmountMinor"],
      message: "A new manual receipt is only accepted for a row without an existing manual receipt.",
    });
  }
});
export type ManagePaymentsChangedRow = z.infer<typeof managePaymentsChangedRowSchema>;

export const managePaymentsSaveRequestSchema = z.object({
  occurrenceId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  /** Returned by GET; clients must echo it verbatim and never compute it. */
  expectedStateFingerprint: stateFingerprint,
  idempotencyKey,
  /** Empty is valid to confirm the server's unconfirmed defaults for a week. */
  changedRows: z.array(managePaymentsChangedRowSchema).max(MANAGE_PAYMENTS_CHANGED_ROWS_MAX),
}).strict().superRefine((request, context) => {
  const seen = new Set<string>();
  const seenBowlers = new Set<number>();
  const seenReceiptIds = new Set<string>();
  request.changedRows.forEach((row, index) => {
    const rowKey = `${row.teamId}:${row.bowlerId}`;
    if (seen.has(rowKey)) {
      context.addIssue({
        code: "custom",
        path: ["changedRows", index],
        message: "Each team and bowler row may appear at most once.",
      });
    }
    if (seenBowlers.has(row.bowlerId)) {
      context.addIssue({
        code: "custom",
        path: ["changedRows", index, "bowlerId"],
        message: "A bowler may be changed only once per league week.",
      });
    }
    seen.add(rowKey);
    seenBowlers.add(row.bowlerId);
    row.manualReceiptEdits.forEach((edit, editIndex) => {
      if (seenReceiptIds.has(edit.receiptId)) {
        context.addIssue({
          code: "custom",
          path: ["changedRows", index, "manualReceiptEdits", editIndex, "receiptId"],
          message: "A manual receipt may be edited only once in a save.",
        });
      }
      seenReceiptIds.add(edit.receiptId);
    });
  });
});
export type ManagePaymentsSaveRequest = z.infer<typeof managePaymentsSaveRequestSchema>;

export const managePaymentsSaveResponseSchema = z.object({
  snapshot: managePaymentsSnapshotSchema,
  replayed: z.boolean(),
});
export type ManagePaymentsSaveResponse = z.infer<typeof managePaymentsSaveResponseSchema>;

export const managePaymentsApiPaths = {
  leagueSnapshot: (leagueId: number) => `/api/financials/leagues/${leagueId}/manage-payments/1`,
  saveWeek: (leagueId: number) => `/api/financials/leagues/${leagueId}/manage-payments/1`,
} as const;
