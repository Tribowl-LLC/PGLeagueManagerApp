/**
 * Apple Pay accepted-domain rules for org-scoped registration.
 *
 * Rationale (see task #277):
 *   The historical rule was "domain MUST equal `${subdomain || slug}.leaguevault.app`".
 *   That breaks the rare-but-real case where an org's `subdomain` or `slug`
 *   was renamed AFTER their canonical wallet domain was first registered
 *   with the payment provider — Apple Pay still serves the OLD domain, so
 *   the org admin cannot re-register their existing wallet domain through
 *   our UI.
 *
 *   We pick option (a) from the task: accept the current canonical
 *   forms (`subdomain.leaguevault.app` AND `slug.leaguevault.app`) PLUS
 *   any domain we've previously registered successfully for this org
 *   (read from `apple_pay_job_items` succeeded rows). No schema change is
 *   required because we already have a per-org registration audit trail
 *   in the bulk-job tables.
 *
 *   Rejected alternatives:
 *   - (b) explicit `acceptedApplePayDomains` per-org list: requires a
 *     migration AND a UI to manage it; adds surface area for no benefit
 *     because the audit trail already records what we've registered.
 *   - (c) accept current `subdomain` + `slug` only: does not solve the
 *     rename-then-re-register case, which is the whole point of this fix.
 */

import { env } from "../config";

export interface OrgLikeForApplePay {
  subdomain?: string | null;
  slug: string;
}

/**
 * Resolve the app-domain suffix used to build accepted Apple Pay domains.
 * Defaults to `env.APP_DOMAIN` (typically `leaguevault.app`) when not
 * explicitly provided. Tests pass an explicit value so they don't depend
 * on the production literal — see `apple-pay-domains.test.ts`.
 */
function resolveSuffix(suffix?: string): string {
  if (suffix && suffix.trim()) return suffix.trim().toLowerCase();
  // The defensive `.toLowerCase()` is redundant with the parse-time
  // normalisation introduced in task #335 (env.APP_DOMAIN is already
  // lowercase) but is kept as belt-and-braces because the test-only
  // `suffix` override path above is also lowercased — both sides of the
  // accepted-domain compare in `isAcceptedApplePayDomain` lowercase
  // their inputs, so this stays case-insensitive end-to-end.
  return env.APP_DOMAIN.toLowerCase();
}

/**
 * The single canonical form we mint for new registrations. Historical
 * organization-derived domains remain accepted below so existing wallets do
 * not break during the host migration.
 */
export function canonicalApplePayDomain(
  org: OrgLikeForApplePay,
  suffix?: string,
): string {
  void org;
  return resolveSuffix(suffix);
}

/**
 * The full set of domains accepted for a given org. Order is not
 * meaningful; duplicates are removed.
 *
 * Includes:
 *   - `<subdomain>.<suffix>` if subdomain is set
 *   - `<slug>.<suffix>`
 *   - every `previouslyRegisteredDomain` (case-insensitive de-dup)
 */
export function acceptedApplePayDomainsForOrg(
  org: OrgLikeForApplePay,
  previouslyRegisteredDomains: string[] = [],
  suffix?: string,
): string[] {
  const resolvedSuffix = resolveSuffix(suffix);
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (d: string | null | undefined) => {
    if (!d) return;
    const norm = d.trim().toLowerCase();
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    out.push(norm);
  };

  add(resolvedSuffix);
  if (org.subdomain) add(`${org.subdomain}.${resolvedSuffix}`);
  add(`${org.slug}.${resolvedSuffix}`);
  for (const d of previouslyRegisteredDomains) add(d);
  return out;
}

/**
 * Returns true iff `candidate` matches the org's accepted-domain set.
 * Comparison is case-insensitive and trims surrounding whitespace, since
 * Apple Pay treats domain names as case-insensitive identifiers.
 */
export function isAcceptedApplePayDomain(
  org: OrgLikeForApplePay,
  candidate: string,
  previouslyRegisteredDomains: string[] = [],
  suffix?: string,
): boolean {
  if (!candidate) return false;
  const norm = candidate.trim().toLowerCase();
  return acceptedApplePayDomainsForOrg(org, previouslyRegisteredDomains, suffix).includes(norm);
}
