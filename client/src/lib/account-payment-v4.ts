import type {
  AccountPaymentFundingSelectionV4,
  AccountPaymentParticipantsResponseV4,
} from "@shared/account-payment-v4-contract";
import { accountPaymentParticipantsResponseV4Schema } from "@shared/account-payment-v4-contract";
import { makeApiError } from "@/lib/api-error";
import type { InteractivePaymentParticipant, InteractivePaymentMode } from "@/lib/interactive-payment-v3";

export type ConfirmedAccountPaymentParticipantsV4 = Extract<
  AccountPaymentParticipantsResponseV4,
  { accountingMode: "confirmed_account_v4" }
>;

export interface AccountPaymentRecipientSelectionV4 {
  bowlerId: number;
  selection: AccountPaymentFundingSelectionV4;
}

export function accountPaymentParticipantsQueryKey(leagueId: number, payerBowlerId: number) {
  return ["/api/financials/leagues", leagueId, "interactive-payment-participants/4", payerBowlerId] as const;
}

export async function loadAccountPaymentParticipantsV4(
  leagueId: number,
  payerBowlerId: number,
  signal?: AbortSignal,
): Promise<AccountPaymentParticipantsResponseV4> {
  const response = await fetch(`/api/financials/leagues/${leagueId}/interactive-payment-participants/4?payerBowlerId=${payerBowlerId}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
    signal,
  });
  const body = await response.json().catch(() => ({})) as { data?: unknown; error?: { message?: string; code?: string } };
  if (!response.ok) throw makeApiError(body, response.status, "Account payment mode is unavailable");
  return accountPaymentParticipantsResponseV4Schema.parse(body.data);
}

/** Parse the common dollar entry without converting malformed input to zero.
 * Blank means the caller chose a server-priced preset. */
export function parseExplicitPaymentAmountMinor(value: string): { amountMinor: number | null; valid: boolean } {
  const trimmed = value.trim();
  if (!trimmed) return { amountMinor: null, valid: true };
  if (!/^(?:\d+)?(?:\.\d{0,2})?$/.test(trimmed) || trimmed === ".") return { amountMinor: null, valid: false };
  const [wholeText = "0", fractionText = ""] = trimmed.split(".");
  const whole = Number(wholeText || "0");
  const fraction = Number((fractionText + "00").slice(0, 2));
  const amountMinor = whole * 100 + fraction;
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0 || amountMinor > 2_147_483_647) {
    return { amountMinor: null, valid: false };
  }
  return { amountMinor, valid: true };
}

function netTargetMinor(targetMinor: number, availableCreditMinor: number): number {
  return Math.max(0, targetMinor - availableCreditMinor);
}

type AccountPaymentRecipientV4 = ConfirmedAccountPaymentParticipantsV4["recipients"][number];

interface PricedAccountWeeklyOption {
  /** Dense chooser ordinal, counting only options with a positive new charge. */
  weeks: number;
  amountMinor: number;
  /** Original V4 ordinal used to request this gross target from the server. */
  targetWeeks: number;
}

function pricedAccountWeeklyOptions(recipient: AccountPaymentRecipientV4): PricedAccountWeeklyOption[] {
  return recipient.forecastTargets.selectedWeeks
    .map((option) => ({
      targetWeeks: option.weeks,
      amountMinor: netTargetMinor(option.amountMinor, recipient.availableCreditMinor),
    }))
    .filter((option) => option.amountMinor > 0)
    .map((option, index) => ({ ...option, weeks: index + 1 }));
}

/** Adapt only for the existing recipient chooser and balance labels. Every
 * amount remains sourced from the V4 participant response; quotes still come
 * from the V4 server endpoint. */
export function accountParticipantsForPaymentChooser(
  response: ConfirmedAccountPaymentParticipantsV4,
): InteractivePaymentParticipant[] {
  return response.recipients.map((recipient) => {
    const creditMinor = recipient.availableCreditMinor;
    const fullBalanceMinor = netTargetMinor(recipient.forecastTargets.fullSeasonMinor, creditMinor);
    const currentCollectionMinor = netTargetMinor(recipient.forecastTargets.currentCollectionMinor, creditMinor);
    const weeklyOptions = response.paymentMode === "upfront"
      ? [{ weeks: 1, amountMinor: fullBalanceMinor }]
      : pricedAccountWeeklyOptions(recipient).map(({ weeks, amountMinor }) => ({ weeks, amountMinor }));
    const hasPreset = weeklyOptions.some((option) => option.amountMinor > 0)
      || currentCollectionMinor > 0
      || fullBalanceMinor > 0;
    const eligible = hasPreset || recipient.role === "self";
    return {
      bowlerId: recipient.bowlerId,
      name: recipient.name,
      role: recipient.role,
      remainingMinor: fullBalanceMinor,
      pastDueMinor: recipient.confirmedPastDueMinor,
      weeklyOptions,
      eligible,
      reason: eligible ? null : "No balance or forecast is currently available",
      dueNowMinor: currentCollectionMinor,
      catchUpAmountMinor: currentCollectionMinor,
      catchUpWeeks: recipient.forecastTargets.selectedWeeks[0]?.weeks ?? 1,
    };
  });
}

/** Build exact V4 server selection semantics from the existing preset UI. */
export function buildAccountPaymentSelectionsV4(input: {
  response: ConfirmedAccountPaymentParticipantsV4;
  selected: Readonly<Record<number, boolean>>;
  weeksByBowlerId: Readonly<Record<number, number>>;
  explicitPayerAmountMinor?: number | null;
  currentCollectionOnly?: boolean;
}): AccountPaymentRecipientSelectionV4[] {
  return input.response.recipients
    .filter((recipient) => input.selected[recipient.bowlerId] === true)
    .flatMap((recipient) => {
      let selection: AccountPaymentFundingSelectionV4;
      if (recipient.bowlerId === input.response.payerBowlerId
        && input.explicitPayerAmountMinor !== undefined
        && input.explicitPayerAmountMinor !== null
        ) {
        if (input.explicitPayerAmountMinor <= 0) return [];
        selection = { kind: "explicit_amount", amountMinor: input.explicitPayerAmountMinor };
      } else if (input.currentCollectionOnly && recipient.bowlerId === input.response.payerBowlerId) {
        selection = { kind: "forecast_collection_target", scope: "current_collection" };
      } else if (input.response.paymentMode === "upfront") {
        selection = { kind: "forecast_collection_target", scope: "full_season" };
      } else {
        const availableWeeks = pricedAccountWeeklyOptions(recipient);
        if (availableWeeks.length === 0) return [];
        const maxWeeks = availableWeeks.length;
        const requestedWeeks = input.weeksByBowlerId[recipient.bowlerId] ?? 1;
        const weeks = Math.min(Math.max(1, Math.trunc(requestedWeeks)), maxWeeks);
        const selectedOption = availableWeeks[weeks - 1];
        if (!selectedOption) return [];
        selection = { kind: "forecast_collection_target", scope: "selected_weeks", weeks: selectedOption.targetWeeks };
      }
      return [{ bowlerId: recipient.bowlerId, selection }];
    })
    .sort((left, right) => left.bowlerId - right.bowlerId);
}

export function defaultSelectedAccountRecipients(
  response: ConfirmedAccountPaymentParticipantsV4,
): Record<number, boolean> {
  const selected: Record<number, boolean> = {};
  for (const recipient of response.recipients) {
    selected[recipient.bowlerId] = recipient.role === "self";
  }
  return selected;
}

export function accountPaymentMode(response: ConfirmedAccountPaymentParticipantsV4): InteractivePaymentMode {
  return response.paymentMode;
}
