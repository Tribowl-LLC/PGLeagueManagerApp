import { describe, expect, it } from "vitest";
import {
  bowlerScoreHistoryRequest,
  leagueLatestScoresRequest,
} from "../../client/src/lib/score-requests";

describe("tenant-scoped score client requests", () => {
  it("selects recent league scores through the server physical-session contract", () => {
    expect(leagueLatestScoresRequest(42, 7)).toEqual({
      queryKey: [
        "/api/scores/latest-scored-session",
        42,
        7,
        "/api/scores?leagueId=42&selection=latest_scored_session&organizationId=7",
      ],
      url: "/api/scores?leagueId=42&selection=latest_scored_session&organizationId=7",
    });
  });

  it("includes bowler organization scope in both the URL and query key", () => {
    expect(bowlerScoreHistoryRequest(93, 7)).toEqual({
      queryKey: [
        "/api/scores/history",
        93,
        7,
        "/api/scores/history?bowlerId=93&organizationId=7",
      ],
      url: "/api/scores/history?bowlerId=93&organizationId=7",
    });
  });
});
