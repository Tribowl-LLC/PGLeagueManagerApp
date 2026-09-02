export function parseOneTimePaymentAmount(value: string, remainingBalance: number): number | null {
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(trimmed)) return null;
  const amountMinor = Math.round(Number(trimmed) * 100);
  return Number.isSafeInteger(amountMinor) && amountMinor > 0 && amountMinor <= remainingBalance
    ? amountMinor
    : null;
}
