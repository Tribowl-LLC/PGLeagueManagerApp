import { describe, expect, it } from "vitest";
import {
  bowlerScoreHistoryRequest,
  leagueLatestScoresRequest,
} from "../../client/src/lib/score-requests";

describe("business-scoped score client requests", () => {
  it("selects recent league scores through the server physical-session contract", () => {
    expect(leagueLatestScoresRequest(42, 7)).toEqual({
      queryKey: [
        "/api/scores/latest-scored-session",
        42,
        7,
        "/api/scores?leagueId=42&selection=latest_scored_session",
      ],
      url: "/api/scores?leagueId=42&selection=latest_scored_session",
    });
  });

  it("keeps the organization in the internal query key without sending it as a selector", () => {
    expect(bowlerScoreHistoryRequest(93, 7)).toEqual({
      queryKey: [
        "/api/scores/history",
        93,
        7,
        "/api/scores/history?bowlerId=93",
      ],
      url: "/api/scores/history?bowlerId=93",
    });
  });
});
