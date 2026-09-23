/** Return the current business-local calendar date in a stable YYYY-MM-DD form. */
export function businessLocalDate(now: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = new Map(formatter.formatToParts(now).map(({ type, value }) => [type, value]));
  const year = parts.get("year");
  const month = parts.get("month");
  const day = parts.get("day");
  if (!year || !month || !day) throw new Error("The business-local date could not be formatted.");
  return `${year.padStart(4, "0")}-${month}-${day}`;
}

export function nearestCanonicalOccurrence<T extends { occurrenceLocalDate: string }>(
  occurrences: readonly T[],
  timeZone: string,
  now = new Date(),
): T | undefined {
  if (occurrences.length === 0) return undefined;
  let currentDate: string;
  try {
    currentDate = businessLocalDate(now, timeZone);
  } catch {
    currentDate = businessLocalDate(now, "UTC");
  }
  return occurrences.find(({ occurrenceLocalDate }) => occurrenceLocalDate >= currentDate) ?? occurrences.at(-1);
}
