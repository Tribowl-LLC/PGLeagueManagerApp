export interface ScoreReadRequest {
  queryKey: readonly [string, number, number, string];
  url: string;
}

export function leagueLatestScoresRequest(leagueId: number, organizationId: number): ScoreReadRequest {
  const url = `/api/scores?leagueId=${leagueId}&selection=latest_scored_session`;
  return {
    queryKey: ["/api/scores/latest-scored-session", leagueId, organizationId, url],
    url,
  };
}

export function bowlerScoreHistoryRequest(bowlerId: number, organizationId: number): ScoreReadRequest {
  const url = `/api/scores/history?bowlerId=${bowlerId}`;
  return {
    queryKey: ["/api/scores/history", bowlerId, organizationId, url],
    url,
  };
}
