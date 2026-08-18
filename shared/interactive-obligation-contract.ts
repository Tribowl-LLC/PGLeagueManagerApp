import { z } from "zod";

export const INTERACTIVE_OBLIGATION_QUOTE_CONTRACT = "interactive-obligation-quote/1" as const;
export const INTERACTIVE_OBLIGATION_QUOTE_ORDER = "due-at,bowler,occurrence,obligation/1" as const;

export const interactiveObligationSelectionSchema = z.object({
  obligationId: z.string().uuid(),
  amountMinor: z.number().int().positive(),
}).strict();

export const interactiveObligationQuoteRequestSchema = z.object({
  leagueId: z.number().int().positive(),
  amountMinor: z.number().int().positive(),
  occurrenceAllocations: z.array(interactiveObligationSelectionSchema).min(1).max(100).optional(),
  occurrenceQuoteFingerprint: z.string().regex(/^lvpayquote:v1:[0-9a-f]{64}$/).optional(),
}).strict();

export type InteractiveObligationSelection = z.infer<typeof interactiveObligationSelectionSchema>;
