import { queryClient } from "./queryClient";

/**
 * Shared query-key registry + named invalidation helpers (Task #767).
 *
 * Cache-key strings and invalidation logic used to be scattered as inline
 * literals across many components, which made the React Doctor
 * `il-invalidation` triage hard to audit and easy to drift. This module
 * centralizes the handful of keys/helpers involved in that triage so the
 * intent of each post-mutation refresh is explicit and recognizable.
 *
 * Scope is intentionally narrow: only the keys/helpers needed to resolve
 * the flagged mutations (org-admin users, unclaimed self-registered users,
 * and the Apple Pay job views) live here — not a repo-wide migration of
 * every query-key literal.
 */

const orgAdminUsersKey = () => ["/api/org-admin/users"] as const;

const unclaimedUsersKey = () => ["/api/admin/unclaimed-users"] as const;

const unclaimedUsersCountKey = () => ["/api/admin/unclaimed-users/count"] as const;

export const applePayJobKeys = {
  /** Listing of Apple Pay registration jobs. */
  list: () => ["/api/payments-provider/apple-pay/jobs"] as const,
  /** A single job's detail (items + counts). */
  detail: (jobId: number) =>
    ["/api/payments-provider/apple-pay/jobs", jobId] as const,
  /** Sidebar attention badge count. */
  pendingCount: () =>
    ["/api/payments-provider/apple-pay/jobs/pending-count"] as const,
};

/** Refresh the org-admin users table after a role/location change. */
export function invalidateOrgAdminUsers() {
  queryClient.invalidateQueries({ queryKey: orgAdminUsersKey() });
}

/** Refresh the unclaimed self-registered users list and sidebar badge after a triage action. */
export function invalidateUnclaimedUsers() {
  queryClient.invalidateQueries({ queryKey: unclaimedUsersKey() });
  queryClient.invalidateQueries({ queryKey: unclaimedUsersCountKey() });
}

/**
 * Refresh every Apple Pay job view touched by a cancel/retry/delete:
 * the listing, the affected job's detail, and the sidebar badge.
 *
 * The listing key (`applePayJobKeys.list()`) is a prefix of the
 * pending-count key, so React Query would normally refetch the badge via
 * prefix matching — but we invalidate it explicitly so the guarantee
 * survives any future refactor that narrows the listing key (#313).
 */
export function invalidateApplePayJobQueries(jobId?: number) {
  queryClient.invalidateQueries({ queryKey: applePayJobKeys.list() });
  if (jobId !== undefined) {
    queryClient.invalidateQueries({ queryKey: applePayJobKeys.detail(jobId) });
  }
  queryClient.invalidateQueries({ queryKey: applePayJobKeys.pendingCount() });
}
