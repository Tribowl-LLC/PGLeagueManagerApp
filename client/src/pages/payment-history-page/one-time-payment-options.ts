type OpenPaymentRow = {
  occurrenceId: string | null;
  amountMinor: number;
  outstandingMinor: number;
  state: "open" | "partially_settled" | "settled" | "voided";
};

export type OneTimePaymentOption = {
  weekCount: number;
  amountMinor: number;
};

/** Build fixed week-count choices from the server-ordered canonical rows.
 * Regular leagues naturally produce weeklyFee × weeks. Summing original
 * obligation amounts also preserves split responsibilities, while capping
 * the final choice at the remaining balance closes any prior partial credit. */
export function buildOneTimePaymentOptions(
  rows: OpenPaymentRow[],
  remainingBalance: number,
): OneTimePaymentOption[] {
  if (!Number.isSafeInteger(remainingBalance) || remainingBalance <= 0) return [];
  const amountByOccurrence = new Map<string, number>();
  for (const row of rows) {
    if ((row.state !== "open" && row.state !== "partially_settled") || row.outstandingMinor <= 0 || !row.occurrenceId) continue;
    amountByOccurrence.set(row.occurrenceId, (amountByOccurrence.get(row.occurrenceId) ?? 0) + row.amountMinor);
  }
  const options: OneTimePaymentOption[] = [];
  let scheduledMinor = 0;
  for (const amountMinor of amountByOccurrence.values()) {
    scheduledMinor += amountMinor;
    const boundedMinor = Math.min(scheduledMinor, remainingBalance);
    if (boundedMinor > (options.at(-1)?.amountMinor ?? 0)) {
      options.push({ weekCount: options.length + 1, amountMinor: boundedMinor });
    }
    if (boundedMinor === remainingBalance) break;
  }
  return options;
}
