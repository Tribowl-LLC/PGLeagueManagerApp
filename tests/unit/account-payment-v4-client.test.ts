import { describe, expect, it } from "vitest";
import {
  accountPaymentParticipantsQueryKey,
  accountParticipantsForPaymentChooser,
  buildAccountPaymentSelectionsV4,
  clampInteractivePaymentWeeks,
  defaultSelectedAccountRecipients,
  initialInteractivePaymentWeeks,
  isInteractivePaymentQuoteCurrent,
  parseExplicitPaymentAmountMinor,
  participantAmountForSelection,
  type ConfirmedAccountPaymentParticipantsV4,
} from "../../client/src/lib/account-payment-v4";

const participants: ConfirmedAccountPaymentParticipantsV4 = {
  contractVersion: "interactive-payment-participants/4",
  accountingMode: "confirmed_account_v4",
  organizationId: 9,
  leagueId: 17,
  payerBowlerId: 42,
  paymentMode: "weekly",
  recipients: [
    {
      bowlerId: 42,
      name: "Avery Lane",
      role: "self",
      confirmedDebtMinor: 0,
      confirmedPastDueMinor: 0,
      availableCreditMinor: 1_000,
      forecastTargets: { currentCollectionMinor: 0, selectedWeeks: [{ weeks: 1, amountMinor: 0 }], fullSeasonMinor: 0 },
    },
    {
      bowlerId: 84,
      name: "Blair Quinn",
      role: "partner",
      confirmedDebtMinor: 2_500,
      confirmedPastDueMinor: 500,
      availableCreditMinor: 500,
      forecastTargets: { currentCollectionMinor: 1_500, selectedWeeks: [{ weeks: 1, amountMinor: 2_500 }, { weeks: 2, amountMinor: 5_000 }], fullSeasonMinor: 8_000 },
    },
  ],
};

const noWeeklyPresetParticipants: ConfirmedAccountPaymentParticipantsV4 = {
  ...participants,
  recipients: participants.recipients.map((recipient) => recipient.bowlerId === participants.payerBowlerId
    ? {
      ...recipient,
      forecastTargets: { ...recipient.forecastTargets, selectedWeeks: [] },
    }
    : recipient),
};

const prepaidWeekParticipants: ConfirmedAccountPaymentParticipantsV4 = {
  ...participants,
  recipients: [
    {
      bowlerId: 42,
      name: "Avery Lane",
      role: "self",
      confirmedDebtMinor: 0,
      confirmedPastDueMinor: 0,
      availableCreditMinor: 9_000,
      forecastTargets: {
        currentCollectionMinor: 9_000,
        selectedWeeks: [3_000, 6_000, 9_000, 12_000, 15_000].map((amountMinor, index) => ({ weeks: index + 1, amountMinor })),
        fullSeasonMinor: 15_000,
      },
    },
    {
      bowlerId: 84,
      name: "Blair Quinn",
      role: "partner",
      confirmedDebtMinor: 0,
      confirmedPastDueMinor: 0,
      availableCreditMinor: 3_000,
      forecastTargets: {
        currentCollectionMinor: 6_000,
        selectedWeeks: [{ weeks: 1, amountMinor: 3_000 }, { weeks: 2, amountMinor: 6_000 }],
        fullSeasonMinor: 6_000,
      },
    },
  ],
};

function payerRecipient(response: ConfirmedAccountPaymentParticipantsV4) {
  const recipient = response.recipients.find((candidate) => candidate.role === "self");
  if (!recipient) throw new Error("self recipient fixture is missing");
  return recipient;
}

describe("account payment V4 client adapter", () => {
  it.each([
    [".50", 50],
    ["25.", 2_500],
    ["25.4", 2_540],
    ["0001.09", 109],
  ])("parses explicit dollar amount %s as integer cents", (value, amountMinor) => {
    expect(parseExplicitPaymentAmountMinor(value)).toEqual({ amountMinor, valid: true });
  });

  it.each(["-", ".", "25.001", "1e3", "$25", "21474836.48"]) (
    "rejects malformed or out-of-range explicit amount %s",
    (value) => expect(parseExplicitPaymentAmountMinor(value).valid).toBe(false),
  );

  it("keeps a self funding choice available when the account has no debt or forecast", () => {
    const chooser = accountParticipantsForPaymentChooser(participants);
    expect(chooser[0]).toMatchObject({ bowlerId: 42, eligible: true, remainingMinor: 0 });
    expect(defaultSelectedAccountRecipients(participants)).toEqual({ 42: true, 84: false });
  });

  it("shows only the server-derived net past-due amount, not all confirmed debt", () => {
    expect(accountParticipantsForPaymentChooser(participants)[1]?.pastDueMinor).toBe(500);
    expect(accountParticipantsForPaymentChooser(participants)[1]?.weeklyOptions).toEqual([
      { weeks: 1, amountMinor: 2_000 },
      { weeks: 2, amountMinor: 4_500 },
    ]);
  });

  it("skips fully credit-covered week choices and maps paid week counts to original V4 targets per recipient", () => {
    const chooser = accountParticipantsForPaymentChooser(prepaidWeekParticipants);
    expect(chooser.map(({ bowlerId, weeklyOptions }) => ({ bowlerId, weeklyOptions }))).toEqual([
      { bowlerId: 42, weeklyOptions: [{ weeks: 1, amountMinor: 3_000 }, { weeks: 2, amountMinor: 6_000 }] },
      { bowlerId: 84, weeklyOptions: [{ weeks: 1, amountMinor: 3_000 }] },
    ]);

    expect(buildAccountPaymentSelectionsV4({
      response: prepaidWeekParticipants,
      selected: { 42: true, 84: true },
      weeksByBowlerId: { 42: 2, 84: 1 },
    })).toEqual([
      { bowlerId: 42, selection: { kind: "forecast_collection_target", scope: "selected_weeks", weeks: 5 } },
      { bowlerId: 84, selection: { kind: "forecast_collection_target", scope: "selected_weeks", weeks: 2 } },
    ]);
  });

  it("keeps the first weekly choice at week one when no credit exists", () => {
    const noCreditParticipants: ConfirmedAccountPaymentParticipantsV4 = {
      ...prepaidWeekParticipants,
      recipients: [
        {
          ...payerRecipient(prepaidWeekParticipants),
          availableCreditMinor: 0,
        },
      ],
    };

    expect(accountParticipantsForPaymentChooser(noCreditParticipants)[0]?.weeklyOptions).toEqual([
      { weeks: 1, amountMinor: 3_000 },
      { weeks: 2, amountMinor: 6_000 },
      { weeks: 3, amountMinor: 9_000 },
      { weeks: 4, amountMinor: 12_000 },
      { weeks: 5, amountMinor: 15_000 },
    ]);
    expect(buildAccountPaymentSelectionsV4({
      response: noCreditParticipants,
      selected: { 42: true },
      weeksByBowlerId: { 42: 1 },
    })).toEqual([{ bowlerId: 42, selection: { kind: "forecast_collection_target", scope: "selected_weeks", weeks: 1 } }]);
  });

  it("offers no weekly preset when credit covers the entire available forecast", () => {
    const coveredParticipants: ConfirmedAccountPaymentParticipantsV4 = {
      ...prepaidWeekParticipants,
      recipients: [
        {
          ...payerRecipient(prepaidWeekParticipants),
          forecastTargets: {
            currentCollectionMinor: 9_000,
            selectedWeeks: [{ weeks: 1, amountMinor: 3_000 }, { weeks: 2, amountMinor: 6_000 }, { weeks: 3, amountMinor: 9_000 }],
            fullSeasonMinor: 9_000,
          },
        },
      ],
    };

    expect(accountParticipantsForPaymentChooser(coveredParticipants)[0]).toMatchObject({
      eligible: true,
      remainingMinor: 0,
      weeklyOptions: [],
    });
    expect(buildAccountPaymentSelectionsV4({
      response: coveredParticipants,
      selected: { 42: true },
      weeksByBowlerId: { 42: 1 },
    })).toEqual([]);
  });

  it("sends explicit payer amounts as exact V4 amounts even when credit exists", () => {
    expect(buildAccountPaymentSelectionsV4({
      response: participants,
      selected: { 42: true, 84: true },
      weeksByBowlerId: { 84: 1 },
      explicitPayerAmountMinor: 4_000,
    })).toEqual([
      { bowlerId: 42, selection: { kind: "explicit_amount", amountMinor: 4_000 } },
      { bowlerId: 84, selection: { kind: "forecast_collection_target", scope: "selected_weeks", weeks: 1 } },
    ]);
  });

  it("omits a zero-priced preset when the explicit amount is blank and omits an explicit zero", () => {
    expect(buildAccountPaymentSelectionsV4({
      response: participants,
      selected: { 42: true },
      weeksByBowlerId: {},
      explicitPayerAmountMinor: null,
    })).toEqual([]);
    expect(buildAccountPaymentSelectionsV4({
      response: participants,
      selected: { 42: true, 84: true },
      weeksByBowlerId: {},
      explicitPayerAmountMinor: 0,
    })).toEqual([{ bowlerId: 84, selection: { kind: "forecast_collection_target", scope: "selected_weeks", weeks: 1 } }]);
  });

  it("omits an unpriced weekly payer until a positive explicit amount is entered", () => {
    expect(buildAccountPaymentSelectionsV4({
      response: noWeeklyPresetParticipants,
      selected: { 42: true },
      weeksByBowlerId: {},
      explicitPayerAmountMinor: null,
    })).toEqual([]);

    expect(buildAccountPaymentSelectionsV4({
      response: noWeeklyPresetParticipants,
      selected: { 42: true },
      weeksByBowlerId: {},
      explicitPayerAmountMinor: 2_500,
    })).toEqual([{ bowlerId: 42, selection: { kind: "explicit_amount", amountMinor: 2_500 } }]);
  });

  it("keeps valid partner, current-collection, and upfront selections without weekly presets", () => {
    expect(buildAccountPaymentSelectionsV4({
      response: noWeeklyPresetParticipants,
      selected: { 42: true, 84: true },
      weeksByBowlerId: { 84: 2 },
      explicitPayerAmountMinor: null,
    })).toEqual([{ bowlerId: 84, selection: { kind: "forecast_collection_target", scope: "selected_weeks", weeks: 2 } }]);

    expect(buildAccountPaymentSelectionsV4({
      response: noWeeklyPresetParticipants,
      selected: { 42: true },
      weeksByBowlerId: {},
      currentCollectionOnly: true,
    })).toEqual([{ bowlerId: 42, selection: { kind: "forecast_collection_target", scope: "current_collection" } }]);

    const upfrontParticipants: ConfirmedAccountPaymentParticipantsV4 = {
      ...noWeeklyPresetParticipants,
      paymentMode: "upfront",
      recipients: noWeeklyPresetParticipants.recipients.map((recipient) => recipient.bowlerId === participants.payerBowlerId
        ? {
          ...recipient,
          forecastTargets: { ...recipient.forecastTargets, fullSeasonMinor: 4_500 },
        }
        : recipient),
    };
    expect(buildAccountPaymentSelectionsV4({
      response: upfrontParticipants,
      selected: { 42: true },
      weeksByBowlerId: {},
    })).toEqual([{ bowlerId: 42, selection: { kind: "forecast_collection_target", scope: "full_season" } }]);
  });

  it("scopes participant cache identity by both league and payer", () => {
    expect(accountPaymentParticipantsQueryKey(17, 42)).not.toEqual(accountPaymentParticipantsQueryKey(17, 84));
    expect(accountPaymentParticipantsQueryKey(17, 42)).not.toEqual(accountPaymentParticipantsQueryKey(18, 42));
  });

  it("clamps week choices to the priced options and prices upfront at the full balance", () => {
    const chooser = {
      remainingMinor: 8_750,
      weeklyOptions: [
        { weeks: 1, amountMinor: 3_000 },
        { weeks: 2, amountMinor: 6_000 },
        { weeks: 3, amountMinor: 8_750 },
      ],
    };
    expect(clampInteractivePaymentWeeks(chooser, 99)).toBe(3);
    expect(clampInteractivePaymentWeeks(chooser, 0)).toBe(1);
    expect(clampInteractivePaymentWeeks({ weeklyOptions: [] }, 4)).toBe(1);
    expect(initialInteractivePaymentWeeks(chooser, "weekly")).toBe(1);
    expect(initialInteractivePaymentWeeks(chooser, "upfront")).toBe(3);
    expect(participantAmountForSelection(chooser, 1, "weekly")).toBe(3_000);
    expect(participantAmountForSelection(chooser, 2, "weekly")).toBe(6_000);
    expect(participantAmountForSelection(chooser, 4, "weekly")).toBe(0);
    expect(participantAmountForSelection(chooser, 1, "upfront")).toBe(8_750);
  });

  it("rejects a quote when fingerprint, amount, or selected recipient set changed", () => {
    const displayed = { fingerprint: "quote-8750", amountMinor: 8_750, selectionKey: "selection-a" };
    const matching = { fingerprint: "quote-8750", amountMinor: 8_750 };
    expect(isInteractivePaymentQuoteCurrent(displayed, matching, displayed.selectionKey)).toBe(true);
    expect(isInteractivePaymentQuoteCurrent(displayed, { ...matching, fingerprint: "quote-6000" }, displayed.selectionKey)).toBe(false);
    expect(isInteractivePaymentQuoteCurrent(displayed, { ...matching, amountMinor: 6_000 }, displayed.selectionKey)).toBe(false);
    expect(isInteractivePaymentQuoteCurrent(displayed, matching, "selection-b")).toBe(false);
    expect(isInteractivePaymentQuoteCurrent(null, matching, displayed.selectionKey)).toBe(false);
  });
});
