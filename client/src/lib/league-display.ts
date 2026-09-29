/**
 * Display a configured local league time without inventing a date or timezone.
 *
 * This is the shared implementation for schedule and league-shell displays.
 * Keep the schedule fallback and invalid-value behavior intact because schedule
 * review and edit surfaces already depend on it.
 */
export function formatScheduleLocalTime(value: string | null): string {
  if (!value) return "Start time not configured";
  const match = /^([01]\d|2[0-3]):([0-5]\d)/.exec(value);
  if (!match) return value;
  const hour = Number(match[1]);
  return `${hour % 12 || 12}:${match[2]} ${hour < 12 ? "AM" : "PM"}`;
}
