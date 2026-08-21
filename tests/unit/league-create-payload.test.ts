import { describe, expect, it } from "vitest";
import { buildCanonicalLeagueCreatePayload } from "@/lib/league-create-payload";
import { insertLeagueSchema } from "@shared/schema";

function parsedBrowserFormData() {
  return insertLeagueSchema.parse({
    name: "Monday Farmington Mixed League",
    description: "Fall 2026",
    active: true,
    allowPublicSignup: false,
    seasonStart: new Date("2026-09-14T00:00:00.000Z"),
    seasonEnd: new Date("2027-04-26T00:00:00.000Z"),
    weekDay: "Monday",
    practiceStartTime: "18:20",
    competitionStartTime: "18:30",
    timezone: "America/New_York",
    weeklyFee: 2_000,
    lineageFee: null,
    prizeFundFee: null,
    paymentMode: "weekly",
    locationId: 1,
    totalBowlingWeeks: 32,
    skipDates: ["2026-12-28"],
    cancelledDates: [],
    doublePayDates: ["2027-04-12", "2027-04-19"],
  });
}

describe("canonical league create payload", () => {
  it("removes schema defaults and lineage fields owned by direct-v2 setup", () => {
    const parsed = parsedBrowserFormData();
    expect(parsed.seasonNumber).toBe(1);

    const payload = buildCanonicalLeagueCreatePayload({
      ...parsed,
      previousSeasonId: 91,
      finalTwoWeeksDueWeek: 30,
      organizationId: 999,
    });

    expect(payload).not.toHaveProperty("seasonEnd");
    expect(payload).not.toHaveProperty("seasonNumber");
    expect(payload).not.toHaveProperty("previousSeasonId");
    expect(payload).not.toHaveProperty("finalTwoWeeksDueWeek");
    expect(payload).not.toHaveProperty("organizationId");
    expect(payload).toMatchObject({
      name: "Monday Farmington Mixed League",
      seasonStart: "2026-09-14T00:00:00.000Z",
      weekDay: "Monday",
      competitionStartTime: "18:30",
      timezone: "America/New_York",
      paymentMode: "weekly",
      totalBowlingWeeks: 32,
    });
  });

  it("uses only the explicitly selected system-admin organization scope", () => {
    const payload = buildCanonicalLeagueCreatePayload(
      { ...parsedBrowserFormData(), organizationId: 999 },
      3,
    );

    expect(payload.organizationId).toBe(3);
  });
});
