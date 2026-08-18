export type InteractivePaymentSelection = { obligationId: string; amountMinor: number };

/** Fields shared by interactive one-time card and wallet request bodies. */
export function buildInteractiveOccurrenceFields(
  selections: InteractivePaymentSelection[] | undefined,
  fingerprint: string | undefined,
  enabled = true,
): Record<string, unknown> {
  if (!enabled || !selections || selections.length === 0) return {};
  return {
    occurrenceAllocations: selections,
    ...(fingerprint ? { occurrenceQuoteFingerprint: fingerprint } : {}),
  };
}

export function interactiveIntentSemanticKey(
  selections: InteractivePaymentSelection[] | undefined,
  fingerprint: string | undefined,
): string {
  if (!selections || selections.length === 0) return 'legacy';
  const ordered = [...selections].sort((left, right) => left.obligationId.localeCompare(right.obligationId));
  return `${fingerprint ?? 'missing'}:${JSON.stringify(ordered)}`;
}
