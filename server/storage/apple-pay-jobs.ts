import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  applePayJobs,
  applePayJobItems,
  APPLE_PAY_ITEM_LEASE_MS,
  type ApplePayJob,
  type ApplePayJobItem,
  type ApplePayJobStatus,
  type ApplePayJobItemStatus,
} from "@shared/schema";

export async function createApplePayJob(createdBy: number | null): Promise<ApplePayJob> {
  const [row] = await db
    .insert(applePayJobs)
    .values({ status: "pending", createdBy: createdBy ?? null })
    .returning();
  return row;
}

/**
 * A parent Apple Pay job predates the singleton refactor and has no durable
 * organization column. In scoped mode, it is eligible only when its creator
 * belongs to the configured organization and every existing item belongs to
 * that organization. Foreign and org-less jobs/items are never claimed or
 * exposed by scoped callers. A deleted creator leaves an ambiguous historical
 * job; the preflight reports it as a blocker and the worker fails closed.
 */
function organizationJobScope(organizationId: number | undefined) {
  if (organizationId === undefined) return undefined;
  return sql`NOT EXISTS (
    SELECT 1
    FROM apple_pay_job_items scoped_item
    LEFT JOIN locations scoped_location
      ON scoped_location.id = scoped_item.location_id
    WHERE scoped_item.job_id = ${applePayJobs.id}
      AND (
        scoped_item.organization_id IS DISTINCT FROM ${organizationId}
        OR (
          scoped_item.location_id IS NOT NULL
          AND scoped_location.organization_id IS DISTINCT FROM ${organizationId}
        )
      )
  )
  AND (
    EXISTS (
      SELECT 1
      FROM users scoped_creator
      WHERE scoped_creator.id = ${applePayJobs.createdBy}
        AND (
          scoped_creator.organization_id = ${organizationId}
          OR (
            scoped_creator.role::text = 'system_admin'
            AND scoped_creator.organization_id IS NULL
          )
        )
    )
  )`;
}

export async function getApplePayJob(id: number, organizationId?: number): Promise<ApplePayJob | undefined> {
  const scope = organizationJobScope(organizationId);
  const [row] = await db
    .select()
    .from(applePayJobs)
    .where(scope ? and(eq(applePayJobs.id, id), scope) : eq(applePayJobs.id, id));
  return row;
}

/**
 * Sentinel TLD used by the Vitest suite for synthetic Apple Pay items
 * (task #592). Real Apple Pay domains can never end in
 * `.vitest-fixture.invalid` because `.invalid` is reserved by RFC 2606
 * for non-resolvable use, so any item carrying this suffix is
 * unambiguously test-fixture data.
 *
 * Two consumers:
 *   1. The `excludeAllSentinelJobs` predicate below hides jobs whose
 *      items are ENTIRELY sentinel from the admin listing + the
 *      attention-count badge — protects the Apple Pay Jobs page from
 *      Vitest workers that crash mid-test before `afterEach` runs.
 *   2. Test-suite `beforeAll`/`afterAll` hooks use it as the cleanup
 *      discriminator to sweep any leftover sentinel rows from prior
 *      crashed runs.
 */
export const APPLE_PAY_TEST_FIXTURE_DOMAIN_SUFFIX = ".vitest-fixture.invalid";

/**
 * Subdomain prefixes used by individual test files under the single
 * sentinel TLD above. See task #592 architect review.
 *
 * The reason both prefixes (and not a single shared marker) exist:
 * each test file's `beforeAll`/`afterAll` purge sweep deletes rows
 * matching its OWN prefix only. Without per-file prefixes, the unit
 * file's afterAll could race-delete the api file's in-flight rows
 * when both files run in parallel vitest workers, breaking the
 * sibling suite. The TLD remains a single canonical sentinel; only
 * the subdomain layer is suite-specific.
 *
 * Convention:
 *   - tests/unit/apple-pay-jobs.test.ts            → `*.unit.vitest-fixture.invalid`
 *   - tests/api/apple-pay-job-cancel-retry.test.ts → `*.api.vitest-fixture.invalid`
 *
 * The production filter (`excludeAllSentinelJobsPredicate`) matches
 * `%.vitest-fixture.invalid` so it covers BOTH variants uniformly.
 */
export const APPLE_PAY_UNIT_TEST_DOMAIN_SUFFIX = `.unit${APPLE_PAY_TEST_FIXTURE_DOMAIN_SUFFIX}`;
export const APPLE_PAY_API_TEST_DOMAIN_SUFFIX = `.api${APPLE_PAY_TEST_FIXTURE_DOMAIN_SUFFIX}`;

/**
 * SQL predicate that EXCLUDES jobs whose items are entirely sentinel
 * test-fixture rows. Two-armed so we are conservative on edge cases:
 *   - A job with NO items at all (e.g. a real production job that is
 *     freshly created and still mid-enumeration) passes — `EXISTS
 *     non-sentinel` is false but `NOT EXISTS sentinel` is true.
 *   - A job with at least one real-domain item passes — `EXISTS
 *     non-sentinel` is true.
 *   - A job whose every item is sentinel is filtered out — both arms
 *     are false.
 *
 * Real production jobs never carry a `.vitest-fixture.invalid` domain,
 * so this filter cannot suppress legitimate data.
 */
const sentinelDomainPattern = `%${APPLE_PAY_TEST_FIXTURE_DOMAIN_SUFFIX}`;
/**
 * EXPORTED for the unit test (#592) so the test can run a scoped
 * version of the same predicate against a single jobId. That gives a
 * race-free per-job assertion (concurrent vitest workers cannot affect
 * a query restricted to one id), independent of the global count delta.
 *
 * Not intended for production callers — use `listApplePayJobs` /
 * `countApplePayJobsNeedingAttention` which compose this internally.
 */
export const excludeAllSentinelJobsPredicate = sql`(
  EXISTS (
    SELECT 1 FROM apple_pay_job_items i
    WHERE i.job_id = ${applePayJobs.id}
      AND i.domain NOT LIKE ${sentinelDomainPattern}
  )
  OR NOT EXISTS (
    SELECT 1 FROM apple_pay_job_items i
    WHERE i.job_id = ${applePayJobs.id}
      AND i.domain LIKE ${sentinelDomainPattern}
  )
)`;
const excludeAllSentinelJobs = excludeAllSentinelJobsPredicate;

/**
 * Backstop filter for stranded item-less jobs (#606).
 *
 * The sentinel-TLD filter above intentionally lets jobs with ZERO items
 * through, because real production jobs have a brief empty window
 * between `createApplePayJob(...)` (the row insert) and the worker's
 * first `insertApplePayJobItems(...)` call (item enumeration). Without
 * that carve-out, a real in-flight job would briefly disappear from the
 * admin page mid-enumeration.
 *
 * That carve-out is exactly the leak shape that
 * `tests/unit/users-delete.test.ts` exposes: it calls
 * `createApplePayJob(userId)` to verify `deleteUser` nullifies
 * `apple_pay_jobs.created_by` and never attaches items because the test
 * doesn't care about them. When the worker is killed mid-test the bare
 * row outlives `afterEach`, has no items, and slips past the sentinel
 * filter onto the admin Apple Pay Jobs page.
 *
 * The fix below: a job with zero items AND `created_at` older than a
 * short grace window is also hidden. The window is sized so:
 *   - It is comfortably longer than any realistic mid-enumeration gap
 *     (production enumeration completes in well under a second).
 *   - It is short enough that any stranded empty test row from a prior
 *     crashed run has long since aged past it before the next admin
 *     page load.
 *
 * 60 seconds is plenty. (The much longer `APPLE_PAY_ITEM_LEASE_MS` is
 * 10 minutes and covers a different scenario — recovering items that
 * were claimed by a crashed worker mid-call. That lease is irrelevant
 * here because we are talking about jobs that have NO items at all,
 * not stalled `processing` items.)
 *
 * Exported for test parity (mirrors `excludeAllSentinelJobsPredicate`):
 * the unit suite exercises the same SQL the production listing uses.
 */
export const APPLE_PAY_EMPTY_JOB_GRACE_MS = 60_000;
export const excludeStaleEmptyJobsPredicate = sql`(
  EXISTS (
    SELECT 1 FROM apple_pay_job_items i
    WHERE i.job_id = ${applePayJobs.id}
  )
  OR ${applePayJobs.createdAt} > NOW() - INTERVAL '60 seconds'
)`;

/**
 * Composite admin-listing filter (#606): hides all-sentinel jobs AND
 * stranded item-less jobs. Used by `listApplePayJobs` and
 * `countApplePayJobsNeedingAttention` so the page and the sidebar
 * attention badge agree exactly on what is or isn't visible.
 */
const adminListingFilter = and(excludeAllSentinelJobs, excludeStaleEmptyJobsPredicate);

export async function listApplePayJobs(limit = 25, organizationId?: number): Promise<ApplePayJob[]> {
  const scope = organizationJobScope(organizationId);
  return db
    .select()
    .from(applePayJobs)
    .where(scope ? and(adminListingFilter, scope) : adminListingFilter)
    .orderBy(desc(applePayJobs.createdAt))
    .limit(limit);
}

/**
 * Count of Apple Pay jobs that should pull a system admin's attention,
 * used to drive the sidebar badge next to "Apple Pay Jobs" (#313).
 *
 * "Attention" = jobs that are either still in flight (pending / running)
 * or terminated in a state the admin needs to react to (failed / partial).
 * `succeeded` and `canceled` are intentionally excluded — succeeded jobs
 * need no action, and a canceled job is the result of an explicit admin
 * decision so it would be noisy to keep nagging.
 *
 * Mirrors the listing filter EXACTLY so all-sentinel test-fixture jobs
 * (#592) AND stranded item-less jobs past the empty-grace window
 * (#606) cannot inflate the badge count either. Reuses
 * `adminListingFilter` so page rows and badge always agree on what is
 * or isn't visible.
 */
const ATTENTION_STATUSES: ApplePayJobStatus[] = [
  "pending",
  "running",
  "failed",
  "partial",
];

export async function countApplePayJobsNeedingAttention(organizationId?: number): Promise<number> {
  const scope = organizationJobScope(organizationId);
  const [row] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(applePayJobs)
    .where(scope
      ? and(inArray(applePayJobs.status, ATTENTION_STATUSES), adminListingFilter, scope)
      : and(inArray(applePayJobs.status, ATTENTION_STATUSES), adminListingFilter));
  return row?.count ?? 0;
}

/**
 * Per-job aggregate of `apple_pay_job_items.recovered_count`. Used by the
 * admin list view to flag jobs that had any items recovered after their
 * pre-call lease expired (#270). Returns a map of jobId -> total
 * recovered count so callers can decorate list rows without N+1 queries.
 */
export async function getApplePayJobsRecoveredItemTotals(
  jobIds: number[],
  organizationId?: number,
): Promise<Map<number, number>> {
  if (jobIds.length === 0) return new Map();
  const predicates = [inArray(applePayJobItems.jobId, jobIds)];
  if (organizationId !== undefined) predicates.push(eq(applePayJobItems.organizationId, organizationId));
  const rows = await db
    .select({
      jobId: applePayJobItems.jobId,
      total: sql<number>`COALESCE(SUM(${applePayJobItems.recoveredCount}), 0)::int`,
    })
    .from(applePayJobItems)
    .where(and(...predicates))
    .groupBy(applePayJobItems.jobId);
  return new Map(rows.map((r) => [r.jobId, Number(r.total) || 0]));
}

/**
 * Atomically claim the next `pending` job to work on. Returns the claimed job
 * (with `status` set to `running`) or `undefined` if there is nothing to do.
 *
 * Only `pending` jobs are eligible — running jobs are assumed owned by another
 * worker. Stale `running` rows from a crashed worker are revived by
 * `recoverInterruptedApplePayJobs()` at server startup.
 *
 * Row is locked `FOR UPDATE SKIP LOCKED` so two workers cannot claim the same
 * job concurrently.
 *
 * Test-only: pass `onlyJobIds` to scope the candidate set to the IDs created
 * by the calling test. The shared test database means another test file can
 * have inserted a `pending` row in between this test's insert and claim;
 * scoping the SELECT keeps the claim-ordering / SKIP-LOCKED assertions
 * deterministic without serialising the whole apple-pay test group. The
 * `FOR UPDATE SKIP LOCKED` semantics still apply within the scoped set.
 * Production callers do not pass this option and behaviour is unchanged.
 */
export async function claimNextApplePayJob(
  opts?: { onlyJobIds?: number[]; organizationId?: number },
): Promise<ApplePayJob | undefined> {
  const onlyJobIds = opts?.onlyJobIds;
  if (onlyJobIds && onlyJobIds.length === 0) return undefined;
  return db.transaction(async (tx) => {
    const scope = onlyJobIds
      ? sql`AND id IN (${sql.join(onlyJobIds.map((id) => sql`${id}`), sql`, `)})`
      : sql``;
    const organizationScope = opts?.organizationId === undefined
      ? sql``
      : sql`AND ${organizationJobScope(opts.organizationId)}`;
    const candidates = await tx.execute(sql`
      SELECT id FROM apple_pay_jobs
      WHERE status = 'pending'
      ${scope}
      ${organizationScope}
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);
    const row = (candidates.rows ?? candidates)[0] as { id: number } | undefined;
    if (!row) return undefined;

    const [updated] = await tx
      .update(applePayJobs)
      .set({
        status: "running",
        startedAt: sql`COALESCE(${applePayJobs.startedAt}, NOW())`,
      })
      .where(eq(applePayJobs.id, row.id))
      .returning();
    return updated;
  });
}

/**
 * Server-startup recovery of mid-flight Apple Pay work.
 *
 * Two passes:
 *   1. Re-open `running` jobs (the worker re-claims via `claimNextApplePayJob`).
 *   2. Revive `processing` items whose pre-call lease has expired (i.e.
 *      `claimed_at` is older than `APPLE_PAY_ITEM_LEASE_MS`, or NULL —
 *      the latter is a defensive fallback for rows written before the
 *      lease column was added). Items whose lease is still valid belong
 *      to a sibling instance that is actively mid-call and MUST NOT be
 *      reverted, because doing so would let a third worker re-issue the
 *      provider call before the original returns.
 *
 * This makes the at-most-once provider-call guarantee hold across both
 * single-instance crashes (lease expires before we boot, item is revived)
 * and overlapping rolling restarts (sibling's lease is still fresh, item
 * stays `processing` until the sibling writes its terminal result).
 *
 * Returns both the revived job ids and the per-item revivals so callers
 * can log/alert on items that stalled long enough to expire their lease
 * (an anomaly worth surfacing — see #270).
 */
export interface ApplePayRecoveryResult {
  /** Jobs flipped from `running` back to `pending`. */
  revivedJobIds: number[];
  /** Items whose pre-call lease expired (or was NULL backfill). */
  revivedItems: Array<{ jobId: number; itemId: number }>;
}

export async function recoverInterruptedApplePayJobs(
  opts?: { onlyJobIds?: number[]; organizationId?: number },
): Promise<ApplePayRecoveryResult> {
  const onlyJobIds = opts?.onlyJobIds;
  if (onlyJobIds && onlyJobIds.length === 0) {
    return { revivedJobIds: [], revivedItems: [] };
  }

  const predicates = [eq(applePayJobs.status, "running")];
  if (onlyJobIds) predicates.push(inArray(applePayJobs.id, onlyJobIds));
  const organizationScope = organizationJobScope(opts?.organizationId);
  if (organizationScope) predicates.push(organizationScope);
  const jobScope = and(...predicates);

  const updatedJobs = await db
    .update(applePayJobs)
    .set({ status: "pending" })
    .where(jobScope)
    .returning({ id: applePayJobs.id });

  // Lease cutoff is computed entirely in DB time (NOW() - interval) to
  // avoid clock skew between app servers and Postgres. Any `processing`
  // row whose `claimed_at` is older than the lease is presumed orphaned
  // by a crashed worker. We bump `recovered_count` so the admin UI can
  // flag jobs that had any items stall mid-call.
  const leaseSeconds = Math.ceil(APPLE_PAY_ITEM_LEASE_MS / 1000);
  const itemScope = and(
    eq(applePayJobItems.status, "processing"),
    // `claimed_at IS NULL` covers rows written before the lease
    // column existed; `claimed_at < NOW() - lease` is the normal case.
    sql`(${applePayJobItems.claimedAt} IS NULL OR ${applePayJobItems.claimedAt} < NOW() - (${leaseSeconds} || ' seconds')::interval)`,
    ...(onlyJobIds ? [inArray(applePayJobItems.jobId, onlyJobIds)] : []),
    ...(opts?.organizationId !== undefined ? [eq(applePayJobItems.organizationId, opts.organizationId)] : []),
  );
  const updatedItems = await db
    .update(applePayJobItems)
    .set({
      status: "pending",
      claimedAt: null,
      recoveredCount: sql`${applePayJobItems.recoveredCount} + 1`,
    })
    .where(itemScope)
    .returning({ id: applePayJobItems.id, jobId: applePayJobItems.jobId });

  return {
    revivedJobIds: updatedJobs.map((j) => j.id),
    revivedItems: updatedItems.map((i) => ({ jobId: i.jobId, itemId: i.id })),
  };
}

export async function insertApplePayJobItems(
  jobId: number,
  items: Array<{
    organizationId: number | null;
    locationId: number | null;
    domain: string;
    status?: ApplePayJobItemStatus;
    message?: string | null;
  }>,
): Promise<void> {
  if (items.length === 0) return;
  const now = new Date().toISOString();
  // ON CONFLICT DO NOTHING makes enumeration idempotent — if a previous run
  // (or a re-claim) already inserted items for this (job, org, location,
  // domain), we silently skip duplicates.
  await db
    .insert(applePayJobItems)
    .values(
      items.map((it) => ({
        jobId,
        organizationId: it.organizationId,
        locationId: it.locationId,
        domain: it.domain,
        status: it.status ?? "pending",
        message: it.message ?? null,
        processedAt: it.status && it.status !== "pending" ? now : null,
      })),
    )
    .onConflictDoNothing();
}

export async function countApplePayJobItems(jobId: number, organizationId?: number): Promise<number> {
  const predicates = [eq(applePayJobItems.jobId, jobId)];
  if (organizationId !== undefined) predicates.push(eq(applePayJobItems.organizationId, organizationId));
  const rows = await db
    .select({ id: applePayJobItems.id })
    .from(applePayJobItems)
    .where(and(...predicates));
  return rows.length;
}

export async function setApplePayJobTotal(jobId: number, total: number, organizationId?: number): Promise<void> {
  const scope = organizationJobScope(organizationId);
  await db.update(applePayJobs)
    .set({ totalDomains: total })
    .where(scope ? and(eq(applePayJobs.id, jobId), scope) : eq(applePayJobs.id, jobId));
}

export async function getPendingApplePayJobItems(jobId: number, organizationId?: number): Promise<ApplePayJobItem[]> {
  const predicates = [eq(applePayJobItems.jobId, jobId), eq(applePayJobItems.status, "pending")];
  if (organizationId !== undefined) predicates.push(eq(applePayJobItems.organizationId, organizationId));
  return db
    .select()
    .from(applePayJobItems)
    .where(and(...predicates))
    .orderBy(asc(applePayJobItems.id));
}

/**
 * Distinct Apple Pay domains that have been registered SUCCESSFULLY for an
 * organization in the past, drawn from the per-job audit trail. Used by
 * the org-admin register-domain route (see task #277) to allow re-registering
 * a wallet domain even after the org's slug/subdomain was renamed.
 *
 * Returns lowercased, trimmed domains with no duplicates.
 */
export async function getRegisteredApplePayDomainsForOrg(
  organizationId: number,
): Promise<string[]> {
  const rows = await db
    .select({ domain: applePayJobItems.domain })
    .from(applePayJobItems)
    .where(and(
      eq(applePayJobItems.organizationId, organizationId),
      eq(applePayJobItems.status, "succeeded"),
    ));
  const seen = new Set<string>();
  for (const r of rows) {
    const d = (r.domain ?? "").trim().toLowerCase();
    if (d) seen.add(d);
  }
  return Array.from(seen);
}

export async function getApplePayJobItems(jobId: number, organizationId?: number): Promise<ApplePayJobItem[]> {
  const predicates = [eq(applePayJobItems.jobId, jobId)];
  if (organizationId !== undefined) predicates.push(eq(applePayJobItems.organizationId, organizationId));
  return db
    .select()
    .from(applePayJobItems)
    .where(and(...predicates))
    .orderBy(asc(applePayJobItems.id));
}

export async function updateApplePayJobItem(
  itemId: number,
  patch: { status: ApplePayJobItemStatus; message?: string | null },
): Promise<void> {
  await db
    .update(applePayJobItems)
    .set({
      status: patch.status,
      message: patch.message ?? null,
      processedAt: new Date().toISOString(),
    })
    .where(eq(applePayJobItems.id, itemId));
}

/**
 * Atomically claim an item for the worker about to issue a provider call.
 * Flips `pending` -> `processing` and stamps `claimed_at = NOW()`. Returns
 * `true` only if THIS caller won the claim. A second worker racing on the
 * same item will get `false` and must NOT issue the provider call.
 *
 * The `claimed_at` timestamp acts as a lease: if the process crashes
 * between this claim and the terminal write, `recoverInterruptedApplePayJobs`
 * will only revert the row once the lease (`APPLE_PAY_ITEM_LEASE_MS`) has
 * expired. A live sibling instance whose lease is still valid is therefore
 * never disturbed by another instance's startup recovery.
 */
export async function claimApplePayJobItemForProcessing(itemId: number, organizationId?: number): Promise<boolean> {
  const predicates = [
    eq(applePayJobItems.id, itemId),
    eq(applePayJobItems.status, "pending"),
  ];
  if (organizationId !== undefined) predicates.push(eq(applePayJobItems.organizationId, organizationId));
  const updated = await db
    .update(applePayJobItems)
    .set({ status: "processing", claimedAt: sql`NOW()` })
    .where(and(...predicates))
    .returning({ id: applePayJobItems.id });
  return updated.length > 0;
}

/**
 * Atomically transition an item from `pending` or `processing` to a
 * terminal state. Returns `true` if the update was applied. Accepts
 * `processing` so the worker can complete an item it pre-claimed via
 * `claimApplePayJobItemForProcessing`, and `pending` so terminal-only
 * paths (e.g. "skipped, no location") that bypass the pre-claim still
 * work without a redundant round-trip.
 */
export async function claimAndCompleteApplePayJobItem(
  itemId: number,
  patch: { status: Exclude<ApplePayJobItemStatus, "pending" | "processing">; message?: string | null },
  organizationId?: number,
): Promise<boolean> {
  const predicates = [
    eq(applePayJobItems.id, itemId),
    sql`${applePayJobItems.status} IN ('pending', 'processing')`,
  ];
  if (organizationId !== undefined) predicates.push(eq(applePayJobItems.organizationId, organizationId));
  const updated = await db
    .update(applePayJobItems)
    .set({
      status: patch.status,
      message: patch.message ?? null,
      processedAt: new Date().toISOString(),
      // Clear the lease — terminal rows are no longer "in flight" and
      // must not look like a stuck claim to startup recovery.
      claimedAt: null,
    })
    .where(and(...predicates))
    .returning({ id: applePayJobItems.id });
  return updated.length > 0;
}

export async function getApplePayJobItemCounts(jobId: number, organizationId?: number): Promise<{
  succeeded: number;
  failed: number;
  skipped: number;
  pending: number;
}> {
  const predicates = [eq(applePayJobItems.jobId, jobId)];
  if (organizationId !== undefined) predicates.push(eq(applePayJobItems.organizationId, organizationId));
  const items = await db
    .select({ status: applePayJobItems.status })
    .from(applePayJobItems)
    .where(and(...predicates));
  const result = { succeeded: 0, failed: 0, skipped: 0, pending: 0 };
  for (const it of items) {
    if (it.status === "succeeded") result.succeeded++;
    else if (it.status === "failed") result.failed++;
    else if (it.status === "skipped") result.skipped++;
    // `processing` is not yet a terminal state — show it as pending in
    // the UI so progress stays accurate while the worker is mid-call.
    else if (it.status === "pending" || it.status === "processing") result.pending++;
  }
  return result;
}

/**
 * Lightweight status read used by the worker to detect mid-job cancellation.
 */
export async function getApplePayJobStatus(jobId: number, organizationId?: number): Promise<ApplePayJobStatus | undefined> {
  const scope = organizationJobScope(organizationId);
  const [row] = await db
    .select({ status: applePayJobs.status })
    .from(applePayJobs)
    .where(scope ? and(eq(applePayJobs.id, jobId), scope) : eq(applePayJobs.id, jobId));
  return row?.status as ApplePayJobStatus | undefined;
}

/**
 * Cancel a job. Behavior depends on current status:
 *  - `pending`: flips to `canceled` immediately and stamps completedAt.
 *  - `running`: flips to `canceled`; the worker checks status between items
 *    and stops issuing new provider calls. Already-claimed items finish.
 * Returns the updated job, or `undefined` if it was not in a cancelable state.
 */
export async function cancelApplePayJob(jobId: number, organizationId?: number): Promise<ApplePayJob | undefined> {
  const predicates = [
    eq(applePayJobs.id, jobId),
    sql`${applePayJobs.status} IN ('pending', 'running')`,
  ];
  const scope = organizationJobScope(organizationId);
  if (scope) predicates.push(scope);
  const [updated] = await db
    .update(applePayJobs)
    .set({
      status: "canceled",
      completedAt: sql`COALESCE(${applePayJobs.completedAt}, NOW())`,
    })
    .where(and(...predicates))
    .returning();
  return updated;
}

/**
 * Hard-delete a job and (via FK ON DELETE CASCADE) its items. Only acts on
 * jobs in a TERMINAL state (succeeded / failed / partial / canceled) — an
 * active pending/running job must be canceled first so the worker can't
 * keep claiming items out from under a deleted parent. Returns true if a
 * row was deleted, false otherwise (active job, unknown id, or already
 * gone). #5104 was the orphan test job that motivated this admin action.
 */
export async function deleteApplePayJob(jobId: number, organizationId?: number): Promise<boolean> {
  const predicates = [
    eq(applePayJobs.id, jobId),
    sql`${applePayJobs.status} NOT IN ('pending', 'running')`,
  ];
  const scope = organizationJobScope(organizationId);
  if (scope) predicates.push(scope);
  const deleted = await db
    .delete(applePayJobs)
    .where(and(...predicates))
    .returning({ id: applePayJobs.id });
  return deleted.length > 0;
}

/**
 * Reset failed items in a terminal job back to `pending` and re-open the job
 * so the worker will pick it up again. Idempotent — only acts on jobs in a
 * terminal state. Returns the re-opened job, or `undefined` if not retryable
 * (e.g. already pending/running, or no failed items).
 */
export async function retryApplePayJob(jobId: number, organizationId?: number): Promise<{ job: ApplePayJob; resetCount: number } | undefined> {
  return db.transaction(async (tx) => {
    const scope = organizationJobScope(organizationId);
    const [job] = await tx
      .select()
      .from(applePayJobs)
      .where(scope ? and(eq(applePayJobs.id, jobId), scope) : eq(applePayJobs.id, jobId));
    if (!job) return undefined;
    if (job.status !== "failed" && job.status !== "partial" && job.status !== "canceled") {
      return undefined;
    }

    const reset = await tx
      .update(applePayJobItems)
      .set({ status: "pending", message: null, processedAt: null })
      .where(and(eq(applePayJobItems.jobId, jobId), eq(applePayJobItems.status, "failed")))
      .returning({ id: applePayJobItems.id });

    if (reset.length === 0) return undefined;

    const [updated] = await tx
      .update(applePayJobs)
      .set({
        status: "pending",
        completedAt: null,
        errorMessage: null,
      })
      .where(eq(applePayJobs.id, jobId))
      .returning();
    return { job: updated, resetCount: reset.length };
  });
}

/**
 * Reset a single failed item back to `pending` and re-open its parent job
 * so the worker will retry just that item. The retry is only permitted when
 * the parent job is itself in a terminal state — retrying an item while the
 * job is still `running` would strand the reset row outside the worker's
 * already-loaded pending queue, leading to incorrect final accounting.
 *
 * Scoping is enforced atomically: the item must belong to `jobId`. If the
 * caller passes a mismatched `(jobId, itemId)` pair, no rows are mutated.
 *
 * Returns the updated item + job, or `undefined` if the item/job is not in
 * a retryable state.
 */
export async function retryApplePayJobItem(
  jobId: number,
  itemId: number,
  organizationId?: number,
): Promise<{ item: ApplePayJobItem; job: ApplePayJob } | undefined> {
  return db.transaction(async (tx) => {
    // Validate parent-job state BEFORE touching the item, so a mismatched
    // (jobId, itemId) or a non-terminal job leaves all rows unchanged.
    const scope = organizationJobScope(organizationId);
    const [job] = await tx
      .select()
      .from(applePayJobs)
      .where(scope ? and(eq(applePayJobs.id, jobId), scope) : eq(applePayJobs.id, jobId));
    if (!job) return undefined;
    if (job.status !== "failed" && job.status !== "partial" && job.status !== "canceled") {
      return undefined;
    }

    const itemPredicates = [
      eq(applePayJobItems.id, itemId),
      eq(applePayJobItems.jobId, jobId),
      eq(applePayJobItems.status, "failed"),
    ];
    if (organizationId !== undefined) itemPredicates.push(eq(applePayJobItems.organizationId, organizationId));
    const [updatedItem] = await tx
      .update(applePayJobItems)
      .set({ status: "pending", message: null, processedAt: null })
      .where(and(...itemPredicates))
      .returning();
    if (!updatedItem) return undefined;

    const [reopened] = await tx
      .update(applePayJobs)
      .set({ status: "pending", completedAt: null, errorMessage: null })
      .where(eq(applePayJobs.id, jobId))
      .returning();

    return { item: updatedItem, job: reopened };
  });
}

/**
 * Flip a job that is currently `running` back to `pending` so the next
 * `claimNextApplePayJob` cycle owns it. Used by the worker when it
 * cannot finalize because items are still non-terminal after a bounded
 * re-drain — e.g. a sibling instance is genuinely mid-call on an item
 * whose pre-call lease is still fresh, so we must not write a terminal
 * status that would silently strand that item (#568).
 *
 * Idempotent: only acts on `running` rows. If the job has already been
 * canceled or finalized by another path we leave it alone. Clears any
 * stale `completedAt`/`errorMessage` so the re-claimed run starts from
 * a clean slate.
 */
export async function reopenApplePayJobForRetry(jobId: number, organizationId?: number): Promise<boolean> {
  const scope = organizationJobScope(organizationId);
  const updated = await db
    .update(applePayJobs)
    .set({ status: "pending", completedAt: null, errorMessage: null })
    .where(scope
      ? and(eq(applePayJobs.id, jobId), eq(applePayJobs.status, "running"), scope)
      : and(eq(applePayJobs.id, jobId), eq(applePayJobs.status, "running")))
    .returning({ id: applePayJobs.id });
  return updated.length > 0;
}

export async function finalizeApplePayJob(
  jobId: number,
  patch: {
    status: ApplePayJobStatus;
    succeededCount: number;
    failedCount: number;
    skippedCount: number;
    errorMessage?: string | null;
  },
  organizationId?: number,
): Promise<void> {
  const scope = organizationJobScope(organizationId);
  await db
    .update(applePayJobs)
    .set({
      status: patch.status,
      succeededCount: patch.succeededCount,
      failedCount: patch.failedCount,
      skippedCount: patch.skippedCount,
      errorMessage: patch.errorMessage ?? null,
      completedAt: new Date().toISOString(),
    })
    .where(scope ? and(eq(applePayJobs.id, jobId), scope) : eq(applePayJobs.id, jobId));
}
