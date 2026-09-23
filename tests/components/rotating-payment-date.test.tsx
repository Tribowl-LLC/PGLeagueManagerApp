import { describe, expect, it } from "vitest";
import { businessLocalDate, nearestCanonicalOccurrence } from "@/lib/rotating-payment-date";

describe("rotating payment canonical date selection", () => {
  it("formats the league-local day across UTC midnight", () => {
    expect(businessLocalDate(new Date("2026-09-24T03:59:00.000Z"), "America/Detroit")).toBe("2026-09-23");
    expect(businessLocalDate(new Date("2026-09-24T04:01:00.000Z"), "America/Detroit")).toBe("2026-09-24");
  });

  it("defaults to the nearest upcoming server-local canonical date", () => {
    const occurrences = [
      { id: "past", occurrenceLocalDate: "2026-09-22" },
      { id: "today", occurrenceLocalDate: "2026-09-23" },
      { id: "next", occurrenceLocalDate: "2026-09-30" },
    ];
    expect(nearestCanonicalOccurrence(occurrences, "America/Detroit", new Date("2026-09-24T03:59:00.000Z"))?.id).toBe("today");
    expect(nearestCanonicalOccurrence(occurrences, "America/Detroit", new Date("2026-09-24T04:01:00.000Z"))?.id).toBe("next");
  });
});
