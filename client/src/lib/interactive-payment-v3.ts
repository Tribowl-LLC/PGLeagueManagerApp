import type { InteractivePaymentRecipientSelectionV3 } from "@shared/interactive-payment-v3-contract";

export type InteractivePaymentMode = "weekly" | "upfront";

export interface InteractivePaymentWeeklyOption {
  weeks: number;
  amountMinor: number;
}

export interface InteractivePaymentParticipant {
  bowlerId: number;
  name: string;
  role: "self" | "partner";
  remainingMinor: number;
  pastDueMinor: number;
  weeklyOptions: InteractivePaymentWeeklyOption[];
  eligible: boolean;
  reason: string | null;
}

export interface InteractivePaymentParticipantsResponse {
  contractVersion: "interactive-payment-participants/3";
  organizationId: number;
  leagueId: number;
  paymentMode: InteractivePaymentMode;
  participants: InteractivePaymentParticipant[];
}

export interface InteractivePaymentQuoteRecipient {
  bowlerId: number;
  name: string;
  role: "self" | "partner";
  weeks: number;
  fullBalance: boolean;
  subtotalMinor: number;
}

export interface InteractivePaymentQuote {
  contractVersion: "interactive-payment-quote/3";
  organizationId: number;
  leagueId: number;
  payerBowlerId: number;
  currency: "USD";
  amountMinor: number;
  fingerprint: string;
  recipients: InteractivePaymentQuoteRecipient[];
}

export interface InteractivePaymentChargeResponse {
  contractVersion: "interactive-payment-charge/3";
  operationId?: string;
  status: string;
  amountMinor?: number;
}

export function isInteractivePaymentQuoteCurrent(
  displayedQuote: { fingerprint: string; amountMinor: number; selectionKey: string } | null,
  quote: Pick<InteractivePaymentQuote, "fingerprint" | "amountMinor"> | null | undefined,
  selectionKey: string,
): boolean {
  return displayedQuote !== null
    && quote !== null
    && quote !== undefined
    && displayedQuote.selectionKey === selectionKey
    && displayedQuote.fingerprint === quote.fingerprint
    && displayedQuote.amountMinor === quote.amountMinor;
}

export function clampInteractivePaymentWeeks(
  participant: Pick<InteractivePaymentParticipant, "weeklyOptions">,
  weeks: number,
): number {
  const maxWeeks = participant.weeklyOptions.at(-1)?.weeks ?? 0;
  if (maxWeeks <= 0) return 1;
  return Math.min(Math.max(1, Math.trunc(weeks)), maxWeeks);
}

export function initialInteractivePaymentWeeks(
  participant: Pick<InteractivePaymentParticipant, "weeklyOptions">,
  paymentMode: InteractivePaymentMode,
): number {
  if (paymentMode === "upfront") return participant.weeklyOptions.at(-1)?.weeks ?? 1;
  return clampInteractivePaymentWeeks(participant, 1);
}

export function isInteractiveParticipantSelectedByDefault(
  participant: Pick<InteractivePaymentParticipant, "role" | "eligible" | "remainingMinor">,
): boolean {
  return participant.role === "self" && participant.eligible && participant.remainingMinor > 0;
}

export function buildInteractivePaymentRecipients(
  participants: InteractivePaymentParticipant[],
  selected: Readonly<Record<number, boolean>>,
  weeksByBowlerId: Readonly<Record<number, number>>,
  paymentMode: InteractivePaymentMode,
): InteractivePaymentRecipientSelectionV3[] {
  return participants
    .filter((participant) => selected[participant.bowlerId] === true && participant.eligible && participant.remainingMinor > 0)
    .map((participant) => {
      const weeks = paymentMode === "upfront"
        ? initialInteractivePaymentWeeks(participant, paymentMode)
        : clampInteractivePaymentWeeks(participant, weeksByBowlerId[participant.bowlerId] ?? 1);
      return { bowlerId: participant.bowlerId, weeks, fullBalance: paymentMode === "upfront" };
    })
    .sort((left, right) => left.bowlerId - right.bowlerId);
}

export function participantAmountForSelection(
  participant: Pick<InteractivePaymentParticipant, "weeklyOptions" | "remainingMinor">,
  weeks: number,
  paymentMode: InteractivePaymentMode,
): number {
  if (paymentMode === "upfront") return participant.remainingMinor;
  const option = participant.weeklyOptions.find((candidate) => candidate.weeks === weeks);
  return option?.amountMinor ?? 0;
}
