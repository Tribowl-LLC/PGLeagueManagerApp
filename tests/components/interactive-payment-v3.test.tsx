import { describe, expect, it } from "vitest";
import {
  buildInteractivePaymentRecipients,
  clampInteractivePaymentWeeks,
  isInteractivePaymentQuoteCurrent,
  isInteractiveParticipantSelectedByDefault,
  participantAmountForSelection,
  type InteractivePaymentParticipant,
} from "@/lib/interactive-payment-v3";

const self: InteractivePaymentParticipant = {
  bowlerId: 42,
  name: "Bowler One",
  role: "self",
  remainingMinor: 8_750,
  pastDueMinor: 2_500,
  weeklyOptions: [
    { weeks: 1, amountMinor: 3_000 },
    { weeks: 2, amountMinor: 6_000 },
    { weeks: 3, amountMinor: 8_750 },
  ],
  eligible: true,
  reason: null,
};

const partner: InteractivePaymentParticipant = {
  bowlerId: 84,
  name: "Bowler Two",
  role: "partner",
  remainingMinor: 6_000,
  pastDueMinor: 1_000,
  weeklyOptions: [
    { weeks: 1, amountMinor: 2_000 },
    { weeks: 2, amountMinor: 4_000 },
    { weeks: 3, amountMinor: 6_000 },
  ],
  eligible: true,
  reason: null,
};

describe("interactive payment v3 client helpers", () => {
  it("defaults only payable self to selected and preserves independent partner weeks", () => {
    expect(isInteractiveParticipantSelectedByDefault(self)).toBe(true);
    expect(isInteractiveParticipantSelectedByDefault(partner)).toBe(false);
    expect(buildInteractivePaymentRecipients(
      [partner, self],
      { 42: true, 84: true },
      { 42: 2, 84: 3 },
      "weekly",
    )).toEqual([
      { bowlerId: 42, weeks: 2, fullBalance: false },
      { bowlerId: 84, weeks: 3, fullBalance: false },
    ]);
  });

  it("uses authoritative weekly options and full balance without inventing an outstanding-sum option", () => {
    expect(clampInteractivePaymentWeeks(self, 99)).toBe(3);
    expect(participantAmountForSelection(self, 1, "weekly")).toBe(3_000);
    expect(participantAmountForSelection(self, 2, "weekly")).toBe(6_000);
    expect(participantAmountForSelection(self, 1, "upfront")).toBe(8_750);
    expect(buildInteractivePaymentRecipients([self], { 42: true }, { 42: 1 }, "upfront")).toEqual([
      { bowlerId: 42, weeks: 3, fullBalance: true },
    ]);
  });

  it("rejects a quote when fingerprint, amount, or selected recipient set changed", () => {
    const displayed = { fingerprint: "quote-8750", amountMinor: 8_750, selectionKey: '[{"bowlerId":42,"weeks":3,"fullBalance":false}]' };
    const matching = { fingerprint: "quote-8750", amountMinor: 8_750 };
    expect(isInteractivePaymentQuoteCurrent(displayed, matching, displayed.selectionKey)).toBe(true);
    expect(isInteractivePaymentQuoteCurrent(displayed, { ...matching, fingerprint: "quote-6000" }, displayed.selectionKey)).toBe(false);
    expect(isInteractivePaymentQuoteCurrent(displayed, { ...matching, amountMinor: 6_000 }, displayed.selectionKey)).toBe(false);
    expect(isInteractivePaymentQuoteCurrent(displayed, matching, "[{\"bowlerId\":84,\"weeks\":3,\"fullBalance\":false}]")).toBe(false);
  });
});
