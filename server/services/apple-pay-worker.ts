import { logger } from "../logger";
import { storage } from "../storage";
import { getPaymentProvider, ProviderNotConfiguredError } from "./payment-provider-factory";
import { hasWalletSupport } from "./payment-provider";
import { applePayRecoveryAlerter } from "./apple-pay-alerts";
import { canonicalApplePayDomain } from "./apple-pay-domains";
import { SingleTenantContextError } from "./single-tenant-context";
import { resolveBackgroundOrganizationId } from "./single-tenant-context";
import type { ApplePayJob, ApplePayJobItem } from "@shared/schema";
import { isTransientDatabaseError, getPgErrorCode } from "../utils/db-errors.js";

const CONCURRENCY_LIMIT = 4;
/** Startup recovery must not hold boot indefinitely when the database is down. */
export const APPLE_PAY_STARTUP_RECOVERY_MAX_ATTEMPTS = 5;
export const APPLE_PAY_STARTUP_RECOVERY_BASE_BACKOFF_MS = 250;
export const APPLE_PAY_STARTUP_RECOVERY_MAX_BACKOFF_MS = 2_000;

const log = (msg: string, meta?: Record<string, unknown>) =>
  logger.info(`[ApplePayWorker] ${msg}`, meta ?? {});
const warn = (msg: string, meta?: Record<string, unknown>) =>
  logger.warn(`[ApplePayWorker] ${msg}`, meta ?? {});
const error = (msg: string, meta?: Record<string, unknown>) =>
  logger.error(`[ApplePayWorker] ${msg}`, meta ?? {});

class ApplePayWorker {
  private running = false;

  /** Enqueue a new bulk-register job. Returns the freshly-created job row. */
  async enqueue(createdBy: number | null, opts?: { suppressKick?: boolean }): Promise<ApplePayJob> {
    const job = await storage.createApplePayJob(createdBy);
    log("Job enqueued", { jobId: job.id, createdBy });
    if (!opts?.suppressKick) this.kick();
    return job;
  }

  /**
   * Kick the worker loop. Idempotent — concurrent calls coalesce into a
   * single in-flight loop.
   *
   * Test-only: callers in non-production environments can short-circuit
   * the kick by sending the `x-test-suppress-apple-pay-kick: 1` header
   * and routing the suppression decision through here. The worker
   * sharing a DB with the test suite would otherwise race apple-pay job
   * tests by claiming `pending` rows out from under them whenever a
   * route handler kicks (#569).
   */
  kick(organizationId?: number): void {
    if (this.running) return;
    this.running = true;
    setImmediate(() => {
      this.loop(organizationId)
        .catch((err) => error("Worker loop crashed", { err: err instanceof Error ? err.message : err }))
        .finally(() => {
          this.running = false;
        });
    });
  }

  /**
   * Called once at server boot. Any job left in `running` was interrupted by
   * the previous process — flip it back to `pending` so we can re-claim and
   * resume from the next pending item. Single-instance assumption (matches
   * PaymentScheduler).
   */
  async resumeOnStartup(organizationId?: number): Promise<void> {
    const scope = organizationId ?? await resolveBackgroundOrganizationId();
    const recovery = scope === undefined
      ? await recoverInterruptedApplePayJobsWithRetry()
      : await recoverInterruptedApplePayJobsWithRetry(scope);
    const { revivedJobIds, revivedItems } = recovery;
    if (revivedJobIds.length > 0) {
      warn("Revived interrupted jobs (status running -> pending)", {
        count: revivedJobIds.length,
        jobIds: revivedJobIds,
      });
    }
    if (revivedItems.length > 0) {
      // Lease-expired item revivals are an anomaly: the previous worker
      // either crashed mid-call or the provider call hung longer than
      // APPLE_PAY_ITEM_LEASE_MS. Either way, an operator should know.
      const affectedJobIds = Array.from(new Set(revivedItems.map((i) => i.jobId)));
      warn("Revived stalled items past lease expiry — investigate provider latency or worker crash", {
        itemCount: revivedItems.length,
        affectedJobIds,
        itemIds: revivedItems.map((i) => i.itemId),
      });
      // Out-of-band alert so an on-call admin gets paged the first time
      // this happens, even if nobody is reading the logs or has the
      // Apple Pay Jobs page open. Rate-limited inside the alerter so a
      // sustained outage doesn't spam.
      applePayRecoveryAlerter
        .notifyRecovered(revivedItems, scope)
        .catch((err) => error("Failed to dispatch Apple Pay recovery alert", {
          err: err instanceof Error ? err.message : String(err),
        }));
    }
    if (revivedJobIds.length === 0 && revivedItems.length === 0) {
      log("No interrupted jobs to recover on startup");
    }
    this.kick(scope);
  }

  private async loop(organizationId?: number): Promise<void> {
    const scope = organizationId ?? await resolveBackgroundOrganizationId();
    while (true) {
      const job = scope === undefined
        ? await storage.claimNextApplePayJob()
        : await storage.claimNextApplePayJob({ organizationId: scope });
      if (!job) {
        log("No claimable jobs, worker idle");
        return;
      }
      await this.processJob(job, scope);
    }
  }

  /**
   * Drives one job from claim through terminal status. In production this
   * is only reached via `loop()` after `claimNextApplePayJob` — exposed
   * (rather than `private`) so the white-box cancellation/finalize-guard
   * tests in `__tests__/apple-pay-worker.test.ts` can drive it directly
   * without `as unknown as` laundering past the type checker.
   * @internal Do not call from production code.
   */
  async processJob(job: ApplePayJob, organizationId?: number): Promise<void> {
    const scope = organizationId ?? await resolveBackgroundOrganizationId();
    log("Processing job", { jobId: job.id, totalDomains: job.totalDomains });
    try {
      // First-run path: enumerate orgs/locations into items table.
      // Resume path (job recovered from `running`): items already exist, so
      // we re-check by counting rows (totalDomains may not have been set yet
      // if the previous worker crashed mid-enumeration). `insertApplePayJobItems`
      // is idempotent via a unique index + ON CONFLICT DO NOTHING.
      const existingCount = scope === undefined
        ? await storage.countApplePayJobItems(job.id)
        : await storage.countApplePayJobItems(job.id, scope);
      if (existingCount === 0) {
        await this.enumerateItems(job.id, scope);
      } else if (job.totalDomains === 0) {
        if (scope === undefined) {
          await storage.setApplePayJobTotal(job.id, existingCount);
        } else {
          await storage.setApplePayJobTotal(job.id, existingCount, scope);
        }
      }

      // Cancellation may have flipped status to `canceled` during enumeration.
      if (await this.isCanceled(job.id, scope)) {
        await this.recordCanceled(job.id, scope);
        return;
      }

      const pending = scope === undefined
        ? await storage.getPendingApplePayJobItems(job.id)
        : await storage.getPendingApplePayJobItems(job.id, scope);
      log("Items to process", { jobId: job.id, pending: pending.length });

      const canceledMidFlight = await this.processItemsWithConcurrency(
        pending,
        CONCURRENCY_LIMIT,
        () => this.isCanceled(job.id, scope),
        scope,
      );

      if (canceledMidFlight) {
        await this.recordCanceled(job.id, scope);
        return;
      }

      // Bounded re-drain (#568): the initial pending snapshot was taken
      // BEFORE we started processing. Any item revived between then and
      // now (e.g. the parent job was just resumed after a crash and one
      // item didn't get picked up by the first pass) would otherwise be
      // stranded by a terminal finalize. Pull the current pending set
      // and run them through the same per-item path. Bounded to a single
      // extra pass so a genuinely stuck `processing` row cannot spin the
      // worker forever.
      const drained = await this.drainRemainingItems(job.id, scope);
      if (drained.canceled) {
        await this.recordCanceled(job.id, scope);
        return;
      }

      // Tally final counts from the source of truth (items table).
      const counts = scope === undefined
        ? await storage.getApplePayJobItemCounts(job.id)
        : await storage.getApplePayJobItemCounts(job.id, scope);
      // If items are STILL non-terminal after the bounded re-drain,
      // refuse to finalize. The most likely cause is a sibling instance
      // mid-call on an item whose pre-call lease is fresh — writing a
      // terminal status here would silently strand that item (the
      // canonical bug from job #523). Instead, hand the job back to the
      // pending queue so the next worker tick re-claims and resumes.
      if (counts.pending > 0) {
        const reopened = scope === undefined
          ? await storage.reopenApplePayJobForRetry(job.id)
          : await storage.reopenApplePayJobForRetry(job.id, scope);
        warn("Leaving job pending — items still non-terminal after bounded drain", {
          jobId: job.id,
          remainingNonTerminal: counts.pending,
          reopened,
          counts,
        });
        return;
      }

      const succeeded = counts.succeeded;
      const failed = counts.failed;
      const skipped = counts.skipped;

      let finalStatus: "succeeded" | "failed" | "partial";
      if (failed === 0 && skipped === 0) finalStatus = "succeeded";
      else if (succeeded === 0) finalStatus = "failed";
      else finalStatus = "partial";

      if (scope === undefined) {
        await storage.finalizeApplePayJob(job.id, {
          status: finalStatus,
          succeededCount: succeeded,
          failedCount: failed,
          skippedCount: skipped,
          errorMessage: null,
        });
      } else {
        await storage.finalizeApplePayJob(job.id, {
          status: finalStatus,
          succeededCount: succeeded,
          failedCount: failed,
          skippedCount: skipped,
          errorMessage: null,
        }, scope);
      }
      log("Job finished", { jobId: job.id, status: finalStatus, succeeded, failed, skipped });
    } catch (err) {
      error("Job aborted with error", {
        jobId: job.id,
        err: err instanceof Error ? err.message : String(err),
      });
      // Don't trample an admin's cancellation with a `failed` finalize.
      if (await this.isCanceled(job.id, scope)) {
        await this.recordCanceled(job.id, scope);
        return;
      }
      // Same guard as the happy path (#568): a thrown error mid-loop
      // must not finalize a job that still has non-terminal items, or
      // those items become orphans the worker will never revisit.
      // Best-effort drain (errors here are logged and we fall through
      // to the reopen branch rather than the terminal write).
      const drained = await this.drainRemainingItems(job.id, scope).catch((e) => {
        warn("Re-drain in catch-block failed", {
          jobId: job.id,
          err: e instanceof Error ? e.message : String(e),
        });
        return { canceled: false };
      });
      if (drained.canceled) {
        await this.recordCanceled(job.id, scope);
        return;
      }
      // If even the counts query fails, we cannot safely write a
      // terminal row — defaulting counts to zero would silently
      // succeed-finalize a job whose items might still be pending
      // (the same stranding hazard #568 exists to prevent). Prefer
      // reopening (defer to next worker tick) over writing a junk
      // terminal row under transient DB failure.
      const counts = await (scope === undefined
        ? storage.getApplePayJobItemCounts(job.id)
        : storage.getApplePayJobItemCounts(job.id, scope))
        .catch(() => null);
      if (counts === null || counts.pending > 0) {
        const reopened = await (scope === undefined
          ? storage.reopenApplePayJobForRetry(job.id)
          : storage.reopenApplePayJobForRetry(job.id, scope))
          .catch(() => false);
        warn("Catch-block leaving job pending — items still non-terminal", {
          jobId: job.id,
          remainingNonTerminal: counts?.pending ?? "unknown (counts query failed)",
          reopened,
          counts,
        });
        return;
      }
      const failurePatch = {
        status: "failed" as const,
        succeededCount: counts.succeeded,
        failedCount: counts.failed,
        skippedCount: counts.skipped,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
      if (scope === undefined) {
        await storage.finalizeApplePayJob(job.id, failurePatch);
      } else {
        await storage.finalizeApplePayJob(job.id, failurePatch, scope);
      }
    }
  }

  /**
   * Single bounded "second pass" over any items still `pending` for this
   * job. Returns `{ canceled }` so callers can preserve the same
   * "cancellation wins over finalize" semantics as the main loop.
   *
   * Items still in `processing` (lease fresh, presumably owned by a
   * sibling instance) are intentionally NOT touched here — that's the
   * scenario the caller's `counts.pending > 0` check handles by
   * reopening the job instead of finalizing.
   */
  private async drainRemainingItems(jobId: number, organizationId?: number): Promise<{ canceled: boolean }> {
    const leftover = organizationId === undefined
      ? await storage.getPendingApplePayJobItems(jobId)
      : await storage.getPendingApplePayJobItems(jobId, organizationId);
    if (leftover.length === 0) return { canceled: false };
    log("Re-draining pending items before finalize", {
      jobId,
      remaining: leftover.length,
    });
    const canceled = await this.processItemsWithConcurrency(
      leftover,
      CONCURRENCY_LIMIT,
      () => this.isCanceled(jobId, organizationId),
      organizationId,
    );
    return { canceled };
  }

  private async isCanceled(jobId: number, organizationId?: number): Promise<boolean> {
    const status = await (organizationId === undefined
      ? storage.getApplePayJobStatus(jobId)
      : storage.getApplePayJobStatus(jobId, organizationId)).catch(() => undefined);
    return status === "canceled";
  }

  /**
   * Roll up final counts on a canceled job without overwriting its status.
   * Cancellation already stamped status='canceled' + completedAt; we just
   * reconcile the per-status counters from the items table.
   */
  private async recordCanceled(jobId: number, organizationId?: number): Promise<void> {
    const counts = await (organizationId === undefined
      ? storage.getApplePayJobItemCounts(jobId)
      : storage.getApplePayJobItemCounts(jobId, organizationId))
      .catch(() => ({ succeeded: 0, failed: 0, skipped: 0, pending: 0 }));
    const patch = {
      status: "canceled" as const,
      succeededCount: counts.succeeded,
      failedCount: counts.failed,
      skippedCount: counts.skipped,
      errorMessage: null,
    };
    if (organizationId === undefined) {
      await storage.finalizeApplePayJob(jobId, patch);
    } else {
      await storage.finalizeApplePayJob(jobId, patch, organizationId);
    }
    warn("Job canceled by admin", { jobId, ...counts });
  }

  private async enumerateItems(jobId: number, organizationId?: number): Promise<void> {
    const scope = organizationId ?? await resolveBackgroundOrganizationId();
    let organizations;
    if (scope === undefined) {
      organizations = await storage.getOrganizations();
    } else {
      const organization = await storage.getOrganization(scope);
      if (!organization) {
        throw new SingleTenantContextError(
          "organization_not_found",
          `Configured organization ${scope} does not exist.`,
        );
      }
      organizations = [organization];
    }
    const items: Array<{
      organizationId: number | null;
      locationId: number | null;
      domain: string;
      status?: "pending" | "skipped";
      message?: string | null;
    }> = [];

    for (const org of organizations) {
      const subdomain = org.subdomain || org.slug;
      if (!subdomain) continue;
      const fullDomain = canonicalApplePayDomain(org);

      const orgLeagues = await storage.getLeagues(org.id);
      const locationIds = new Set<number>();
      for (const league of orgLeagues) {
        if (league.locationId) locationIds.add(league.locationId);
      }

      if (locationIds.size === 0) {
        items.push({
          organizationId: org.id,
          locationId: null,
          domain: fullDomain,
          status: "skipped",
          message: "No locations with payment credentials",
        });
        continue;
      }

      for (const locationId of locationIds) {
        items.push({
          organizationId: org.id,
          locationId,
          domain: fullDomain,
          status: "pending",
          message: null,
        });
      }
    }

    await storage.insertApplePayJobItems(jobId, items);
    if (scope === undefined) {
      await storage.setApplePayJobTotal(jobId, items.length);
    } else {
      await storage.setApplePayJobTotal(jobId, items.length, scope);
    }
    log("Enumerated items", { jobId, total: items.length });
  }

  /**
   * Returns `true` if processing was halted because `shouldCancel` flipped
   * to true mid-flight. Already-claimed items finish; no new items start.
   * Cancellation is polled at most once per second to keep DB load bounded
   * even with many short-running items.
   */
  private async processItemsWithConcurrency(
    items: ApplePayJobItem[],
    limit: number,
    shouldCancel: () => Promise<boolean>,
    organizationId?: number,
  ): Promise<boolean> {
    if (items.length === 0) return false;
    const queue = items.slice();
    const workers: Promise<void>[] = [];

    let canceled = false;
    let lastCheckAt = 0;
    const checkCancel = async (): Promise<void> => {
      if (canceled) return;
      const now = Date.now();
      if (now - lastCheckAt < 1000) return;
      lastCheckAt = now;
      if (await shouldCancel()) canceled = true;
    };

    const next = async (): Promise<void> => {
      while (queue.length > 0) {
        await checkCancel();
        if (canceled) return;
        const item = queue.shift();
        if (!item) return;
        await this.processItem(item, organizationId);
      }
    };

    for (let i = 0; i < Math.min(limit, items.length); i++) {
      workers.push(next());
    }
    await Promise.all(workers);
    return canceled;
  }

  private async processItem(item: ApplePayJobItem, organizationId?: number): Promise<void> {
    // Two-phase write to make the worker safe under multi-instance
    // deployments:
    //   1. `claimApplePayJobItemForProcessing` flips pending->processing
    //      atomically. If a second worker raced us to this item, our claim
    //      returns false and we skip — guaranteeing the provider call is
    //      issued at most once per item.
    //   2. `claimAndCompleteApplePayJobItem` writes the terminal result.
    //      It accepts either pending (for paths that don't pre-claim, e.g.
    //      a missing-location skip) or processing (for the normal path).
    // The pending->processing flip also stamps `claimed_at = NOW()` as
    // a lease. If the process dies between (1) and (2), the row stays
    // `processing` until the lease expires; `recoverInterruptedApplePayJobs`
    // then revives it on a future boot. Crucially, a sibling instance
    // booting up DURING our provider call sees a fresh lease and leaves
    // the row alone — so the at-most-once provider-call guarantee holds
    // across both single-instance crashes and overlapping rolling
    // restarts of multiple backend instances.
    const complete = (patch: {
      status: "succeeded" | "failed" | "skipped";
      message?: string | null;
    }) => organizationId === undefined
      ? storage.claimAndCompleteApplePayJobItem(item.id, patch)
      : storage.claimAndCompleteApplePayJobItem(item.id, patch, organizationId);
    try {
      if (item.locationId == null) {
        await complete({
          status: "skipped",
          message: item.message ?? "No location",
        });
        return;
      }

      const claimed = organizationId === undefined
        ? await storage.claimApplePayJobItemForProcessing(item.id)
        : await storage.claimApplePayJobItemForProcessing(item.id, organizationId);
      if (!claimed) {
        log("Item already in-flight or completed by another worker, skipping", {
          itemId: item.id,
        });
        return;
      }

      // The job-item organization stamp is durable evidence, but the
      // location row is the provider-account boundary. A corrupt or legacy
      // item whose location was reassigned must never turn into a provider
      // call merely because its item stamp still matches this business.
      if (organizationId !== undefined) {
        const location = await storage.getLocation(item.locationId);
        if (!location || location.organizationId !== organizationId) {
          await complete({
            status: "failed",
            message: "Location does not belong to the configured organization",
          });
          return;
        }
      }

      let provider;
      try {
        provider = await getPaymentProvider(item.locationId);
      } catch (e) {
        if (e instanceof ProviderNotConfiguredError) {
          await complete({
            status: "failed",
            message: "Payment provider not configured",
          });
          return;
        }
        throw e;
      }

      if (!hasWalletSupport(provider)) {
        await complete({
          status: "failed",
          message: "Provider does not support Apple Pay",
        });
        return;
      }

      const result = await provider.registerApplePayDomain(item.domain);
      await complete({
        status: result.success ? "succeeded" : "failed",
        message: result.message,
      });
    } catch (err) {
      warn("Item failed with unexpected error", {
        itemId: item.id,
        err: err instanceof Error ? err.message : String(err),
      });
      await (organizationId === undefined
        ? storage.claimAndCompleteApplePayJobItem(item.id, {
          status: "failed",
          message: err instanceof Error ? err.message : String(err),
        })
        : storage.claimAndCompleteApplePayJobItem(item.id, {
          status: "failed",
          message: err instanceof Error ? err.message : String(err),
        }, organizationId))
        .catch(() => {
          /* swallow secondary failure */
        });
    }
  }
}

/**
 * Recover interrupted work only after the database is reachable. Pool
 * acquisition can briefly fail during a rolling restart even though the
 * initial health probe succeeded. The storage operation is intentionally
 * idempotent (status predicates only match still-recoverable rows), so a
 * connection loss after commit is safe to retry without duplicating provider
 * calls or item rows.
 */
async function recoverInterruptedApplePayJobsWithRetry(
  organizationId?: number,
): Promise<Awaited<ReturnType<typeof storage.recoverInterruptedApplePayJobs>>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= APPLE_PAY_STARTUP_RECOVERY_MAX_ATTEMPTS; attempt++) {
    try {
      return organizationId === undefined
        ? await storage.recoverInterruptedApplePayJobs()
        : await storage.recoverInterruptedApplePayJobs({ organizationId });
    } catch (error) {
      lastError = error;
      const retryable = isTransientDatabaseError(error);
      if (!retryable || attempt === APPLE_PAY_STARTUP_RECOVERY_MAX_ATTEMPTS) {
        throw error;
      }

      const backoffMs = Math.min(
        APPLE_PAY_STARTUP_RECOVERY_BASE_BACKOFF_MS * 2 ** (attempt - 1),
        APPLE_PAY_STARTUP_RECOVERY_MAX_BACKOFF_MS,
      );
      warn("Startup recovery database acquisition failed; retrying", {
        attempt,
        maxAttempts: APPLE_PAY_STARTUP_RECOVERY_MAX_ATTEMPTS,
        backoffMs,
        errorCode: getPgErrorCode(error) ?? "unknown",
      });
      await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  // The loop always returns or throws. Keep the defensive throw explicit for
  // TypeScript and to avoid ever silently starting a worker without recovery.
  throw lastError;
}

export const applePayWorker = new ApplePayWorker();
