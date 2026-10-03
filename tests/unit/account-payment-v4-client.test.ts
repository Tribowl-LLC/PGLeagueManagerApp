import { describe, expect, it } from "vitest";
import {
  accountPaymentParticipantsQueryKey,
  accountParticipantsForPaymentChooser,
  buildAccountPaymentSelectionsV4,
  defaultSelectedAccountRecipients,
  parseExplicitPaymentAmountMinor,
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

  it("uses the server-priced preset when the explicit amount is blank and omits an explicit zero", () => {
    expect(buildAccountPaymentSelectionsV4({
      response: participants,
      selected: { 42: true },
      weeksByBowlerId: {},
      explicitPayerAmountMinor: null,
    })).toEqual([{ bowlerId: 42, selection: { kind: "forecast_collection_target", scope: "selected_weeks", weeks: 1 } }]);
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
});
