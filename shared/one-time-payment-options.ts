export type OneTimePaymentOptionRow = {
  occurrenceId: string | null;
  amountMinor: number;
  outstandingMinor: number;
  state: "open" | "partially_settled" | "settled" | "voided";
};

export type OneTimePaymentOption = { weekCount: number; amountMinor: number };

/** Fixed week-count choices preserve the established partial-credit rule:
 * the option is based on the scheduled obligation amount, capped at the
 * recipient's remaining balance. FIFO then applies that amount to oldest
 * outstanding obligations, potentially spilling into the next occurrence. */
export function buildOneTimePaymentOptions(rows: OneTimePaymentOptionRow[], remainingBalance: number): OneTimePaymentOption[] {
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
    if (boundedMinor > (options.at(-1)?.amountMinor ?? 0)) options.push({ weekCount: options.length + 1, amountMinor: boundedMinor });
    if (boundedMinor === remainingBalance) break;
  }
  return options;
}
