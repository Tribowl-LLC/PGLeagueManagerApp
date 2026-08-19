import { beforeAll, describe, expect, it } from "vitest";
import { apiGet, login, TEST_ORG_A_EMAIL, TEST_ORG_PASSWORD, type AuthSession } from "../helpers";

function responseCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const error = "error" in value && typeof value.error === "object" && value.error !== null ? value.error : undefined;
  if (error && "code" in error && typeof error.code === "string") return error.code;
  return "code" in value && typeof value.code === "string" ? value.code : undefined;
}

describe("F3 API/provider boundary contract", () => {
  let session: AuthSession;
  let leagueId: number;
  let bowlerId: number;
  beforeAll(async () => {
    session = await login(TEST_ORG_A_EMAIL, TEST_ORG_PASSWORD);
    const leagues = await apiGet<Array<{ id: number }>>("/api/leagues", session);
    leagueId = leagues.data.data?.[0]?.id ?? 1;
    const bowlers = await apiGet<Array<{ id: number }>>("/api/bowlers", session);
    bowlerId = bowlers.data.data?.[0]?.id ?? 1;
  });

  it("requires authentication and returns the typed default-off response", async () => {
    const anonymous = await apiGet(`/api/financials/f3/leagues/${leagueId}/prequote?bowlerId=1`);
    expect(anonymous.status).toBe(401);
    const disabled = await apiGet(`/api/financials/f3/leagues/${leagueId}/prequote?bowlerId=${bowlerId}`, session);
    expect([404, 409]).toContain(disabled.status);
    if (disabled.status === 409) expect(responseCode(disabled.data)).toBe("F3_DISABLED");
  });

  it("does not expose policy candidates or authorization commands while disabled", async () => {
    const candidates = await apiGet(`/api/financials/f3/leagues/${leagueId}/policy/candidates`, session);
    expect(candidates.status).toBe(409);
    expect(responseCode(candidates.data)).toBe("F3_DISABLED");
    const authorize = await apiGet(`/api/financials/f3/leagues/${leagueId}/quote?bowlerId=${bowlerId}`, session);
    expect(authorize.status).toBe(409);
    expect(responseCode(authorize.data)).toBe("F3_DISABLED");
  });
});
