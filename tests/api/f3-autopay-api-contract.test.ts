import { beforeAll, describe, expect, it } from "vitest";
import { apiGet, login, TEST_ORG_A_EMAIL, TEST_ORG_PASSWORD, type AuthSession } from "../helpers";

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

  it("requires authentication and does not expose a retired F3 namespace", async () => {
    const anonymous = await apiGet(`/api/financials/f3/leagues/${leagueId}/prequote?bowlerId=1`);
    expect(anonymous.status).toBe(401);
    const disabled = await apiGet(`/api/financials/f3/leagues/${leagueId}/prequote?bowlerId=${bowlerId}`, session);
    expect(disabled.status).toBe(404);
  });

  it("does not expose policy candidates or authorization commands while disabled", async () => {
    const candidates = await apiGet(`/api/financials/f3/leagues/${leagueId}/policy/candidates`, session);
    expect(candidates.status).toBe(404);
    const authorize = await apiGet(`/api/financials/f3/leagues/${leagueId}/quote?bowlerId=${bowlerId}`, session);
    expect(authorize.status).toBe(404);
  });
});
