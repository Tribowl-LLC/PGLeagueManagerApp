import type { QueryClient } from "@tanstack/react-query";

export function paymentHistoryFinancialQueryKey(leagueId: number, bowlerId: number) {
  return ["/api/financials/leagues", leagueId, "canonical-due-past-due/2", bowlerId] as const;
}

/** Await the canonical balance refresh before allowing history checkout to reopen. */
export async function invalidatePaymentHistoryFinancials(
  client: Pick<QueryClient, "invalidateQueries">,
  leagueId: number,
  bowlerId: number,
): Promise<void> {
  await client.invalidateQueries({ queryKey: paymentHistoryFinancialQueryKey(leagueId, bowlerId) });
}
