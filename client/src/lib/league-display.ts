/** Display a configured local league time without inventing a date or timezone. */
export function formatLeagueCompetitionTime(value: string | null | undefined): string | null {
  const match = /^(\d{1,2}):([0-5]\d)/.exec(value?.trim() ?? "");
  if (!match) return null;
  const hour = Number(match[1]);
  if (hour > 23) return null;
  return `${hour % 12 || 12}:${match[2]} ${hour < 12 ? "AM" : "PM"}`;
}
