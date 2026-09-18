/**
 * Apple Pay domain registration (single + bulk).
 *
 * Routes:
 *  - POST /apple-pay/register-all-domains   (system-admin; enqueues a background job, returns 202 + jobId)
 *  - GET  /apple-pay/jobs/:id              (system-admin; poll job status + per-item results)
 *  - GET  /apple-pay/jobs                  (system-admin; recent jobs)
 *  - POST /apple-pay/register-domain        (sync, single-domain — unchanged)
 */
import { Router } from 'express';
import { storage } from '../../storage';
import { sendSuccess, sendError } from '../../utils/api.js';
import { createLogger } from '../../logger';
import { getPaymentProvider, ProviderNotConfiguredError } from '../../services/payment-provider-factory';
import { hasWalletSupport } from '../../services/payment-provider';
import { applePayWorker } from '../../services/apple-pay-worker';
import { acceptedApplePayDomainsForOrg, isAcceptedApplePayDomain } from '../../services/apple-pay-domains';
import { applePayRecoveryAlertKind } from '../../services/apple-pay-alerts';
import type { ApplePayRecoveryAlerterSummary } from '@shared/schema';
import { isTestKickSuppressed, APPLE_PAY_WORKER_KICK_HEADER } from '../../utils/test-suppression';
import { requireOrganizationAccess } from '../../utils/access-control.js';

// How far back the admin dashboard banner should consider an Apple Pay
// recovery alert "recent". 24 hours is generous enough to survive an
// overnight outage but tight enough that stale, already-investigated
// events don't keep nagging the next admin who logs in (#272).
const RECENT_ALERT_WINDOW_MS = 24 * 60 * 60 * 1000;

const log = createLogger('Payments');

const router = Router();

/**
 * Test-only: when the request carries `x-test-suppress-apple-pay-kick: 1`
 * AND we are not in production, the route hands the worker a no-op kick.
 * Without this, the dev server's live `applePayWorker` (which shares a
 * DB with the vitest suite) races the apple-pay job tests by claiming
 * `pending` rows out from under them — see task #569 for the failure
 * mode. The header is wired in tests/helpers.ts via `withTestBypassHeader`
 * so every test request short-circuits the kick by default. Generic
 * helper + header constant live in `server/utils/test-suppression.ts`
 * (#571 generalised the convention to every other route-kicked worker).
 */
function isWorkerKickSuppressed(req: { headers: Record<string, unknown> }): boolean {
  return isTestKickSuppressed(req, APPLE_PAY_WORKER_KICK_HEADER);
}

router.post('/apple-pay/register-all-domains', async (req, res) => {
  try {
    if (req.user?.role !== 'system_admin') {
      return sendError(res, 'System admin access required', 403, 'FORBIDDEN');
    }

    const job = await applePayWorker.enqueue(req.user?.id ?? null, {
      suppressKick: isWorkerKickSuppressed(req),
    });

    res.status(202).json({
      success: true,
      data: {
        jobId: job.id,
        status: job.status,
        createdAt: job.createdAt,
        message: 'Bulk Apple Pay registration enqueued. Poll GET /api/payments-provider/apple-pay/jobs/:id for status.',
      },
    });
  } catch (error) {
    log.error('Apple Pay bulk registration enqueue error:', error);
    sendError(res, 'Failed to enqueue bulk Apple Pay registration job', 500);
  }
});

router.get('/apple-pay/jobs', async (req, res) => {
  try {
    if (req.user?.role !== 'system_admin') {
      return sendError(res, 'System admin access required', 403, 'FORBIDDEN');
    }
    const jobs = req.organizationContextId === undefined
      ? await storage.listApplePayJobs(25)
      : await storage.listApplePayJobs(25, req.organizationContextId);
    // Decorate each row with its lease-recovered total so admins can spot
    // anomalous jobs at a glance from the list view (#270).
    const totals = req.organizationContextId === undefined
      ? await storage.getApplePayJobsRecoveredItemTotals(jobs.map((j) => j.id))
      : await storage.getApplePayJobsRecoveredItemTotals(jobs.map((j) => j.id), req.organizationContextId);
    const jobsWithRecovery = jobs.map((j) => ({
      ...j,
      recoveredItemCount: totals.get(j.id) ?? 0,
    }));
    sendSuccess(res, { jobs: jobsWithRecovery });
  } catch (error) {
    log.error('Apple Pay list jobs error:', error);
    sendError(res, 'Failed to list jobs', 500);
  }
});

// Sidebar badge feed (#313). Returns the number of jobs in a state that
// requires admin attention (pending / running / failed / partial). Mounted
// BEFORE `/apple-pay/jobs/:id` so the literal `pending-count` segment is
// not captured by the `:id` param. System-admin only — same gate as the
// rest of the apple-pay job routes.
router.get('/apple-pay/jobs/pending-count', async (req, res) => {
  try {
    if (req.user?.role !== 'system_admin') {
      return sendError(res, 'System admin access required', 403, 'FORBIDDEN');
    }
    const count = req.organizationContextId === undefined
      ? await storage.countApplePayJobsNeedingAttention()
      : await storage.countApplePayJobsNeedingAttention(req.organizationContextId);
    sendSuccess(res, { count });
  } catch (error) {
    log.error('Apple Pay pending-count error:', error);
    sendError(res, 'Failed to compute pending Apple Pay jobs count', 500);
  }
});

router.get('/apple-pay/jobs/:id', async (req, res) => {
  try {
    if (req.user?.role !== 'system_admin') {
      return sendError(res, 'System admin access required', 403, 'FORBIDDEN');
    }
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendError(res, 'Invalid job id', 400, 'INVALID_ID');

    const job = req.organizationContextId === undefined
      ? await storage.getApplePayJob(id)
      : await storage.getApplePayJob(id, req.organizationContextId);
    if (!job) return sendError(res, 'Job not found', 404, 'NOT_FOUND');

    // Live counts from the items table — these stay accurate while the job is
    // mid-flight (the job row's counts are only finalized at job completion).
    const [items, liveCounts] = await Promise.all([
      req.organizationContextId === undefined
        ? storage.getApplePayJobItems(id)
        : storage.getApplePayJobItems(id, req.organizationContextId),
      req.organizationContextId === undefined
        ? storage.getApplePayJobItemCounts(id)
        : storage.getApplePayJobItemCounts(id, req.organizationContextId),
    ]);

    // Aggregate lease-recovered items so the admin UI can flag the job
    // as "had an anomaly" without having to scan every row (#270).
    const recoveredItemCount = items.reduce(
      (sum, it) => sum + (it.recoveredCount ?? 0),
      0,
    );

    sendSuccess(res, {
      job,
      counts: {
        total: job.totalDomains,
        succeeded: liveCounts.succeeded,
        failed: liveCounts.failed,
        skipped: liveCounts.skipped,
        pending: liveCounts.pending,
      },
      recoveredItemCount,
      items,
    });
  } catch (error) {
    log.error('Apple Pay job status error:', error);
    sendError(res, 'Failed to fetch job status', 500);
  }
});

router.post('/apple-pay/jobs/:id/cancel', async (req, res) => {
  try {
    if (req.user?.role !== 'system_admin') {
      return sendError(res, 'System admin access required', 403, 'FORBIDDEN');
    }
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendError(res, 'Invalid job id', 400, 'INVALID_ID');

    const existing = req.organizationContextId === undefined
      ? await storage.getApplePayJob(id)
      : await storage.getApplePayJob(id, req.organizationContextId);
    if (!existing) return sendError(res, 'Job not found', 404, 'NOT_FOUND');

    const updated = req.organizationContextId === undefined
      ? await storage.cancelApplePayJob(id)
      : await storage.cancelApplePayJob(id, req.organizationContextId);
    if (!updated) {
      return sendError(
        res,
        `Job is ${existing.status}; only pending or running jobs can be canceled.`,
        409,
        'NOT_CANCELABLE',
      );
    }
    log.warn('Apple Pay job canceled by admin', { jobId: id, by: req.user?.id });
    sendSuccess(res, { job: updated });
  } catch (error) {
    log.error('Apple Pay job cancel error:', error);
    sendError(res, 'Failed to cancel job', 500);
  }
});

router.delete('/apple-pay/jobs/:id', async (req, res) => {
  try {
    if (req.user?.role !== 'system_admin') {
      return sendError(res, 'System admin access required', 403, 'FORBIDDEN');
    }
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendError(res, 'Invalid job id', 400, 'INVALID_ID');

    const existing = req.organizationContextId === undefined
      ? await storage.getApplePayJob(id)
      : await storage.getApplePayJob(id, req.organizationContextId);
    if (!existing) return sendError(res, 'Job not found', 404, 'NOT_FOUND');

    const deleted = req.organizationContextId === undefined
      ? await storage.deleteApplePayJob(id)
      : await storage.deleteApplePayJob(id, req.organizationContextId);
    if (!deleted) {
      // Active jobs (pending/running) must be canceled first so the worker
      // can't keep claiming items out from under a deleted parent row.
      return sendError(
        res,
        `Job is ${existing.status}; only terminal jobs (succeeded, failed, partial, canceled) can be deleted. Cancel an active job first.`,
        409,
        'NOT_DELETABLE',
      );
    }
    log.warn('Apple Pay job deleted by admin', {
      jobId: id,
      by: req.user?.id,
      prevStatus: existing.status,
    });
    sendSuccess(res, { deleted: true, jobId: id });
  } catch (error) {
    log.error('Apple Pay job delete error:', error);
    sendError(res, 'Failed to delete job', 500);
  }
});

router.post('/apple-pay/jobs/:id/retry', async (req, res) => {
  try {
    if (req.user?.role !== 'system_admin') {
      return sendError(res, 'System admin access required', 403, 'FORBIDDEN');
    }
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendError(res, 'Invalid job id', 400, 'INVALID_ID');

    const existing = req.organizationContextId === undefined
      ? await storage.getApplePayJob(id)
      : await storage.getApplePayJob(id, req.organizationContextId);
    if (!existing) return sendError(res, 'Job not found', 404, 'NOT_FOUND');

    const result = req.organizationContextId === undefined
      ? await storage.retryApplePayJob(id)
      : await storage.retryApplePayJob(id, req.organizationContextId);
    if (!result) {
      return sendError(
        res,
        `No failed items to retry on this job (status: ${existing.status}).`,
        409,
        'NOT_RETRYABLE',
      );
    }
    if (!isWorkerKickSuppressed(req)) applePayWorker.kick();
    log.info('Apple Pay job retried by admin', { jobId: id, by: req.user?.id, resetCount: result.resetCount });
    sendSuccess(res, { job: result.job, resetCount: result.resetCount });
  } catch (error) {
    log.error('Apple Pay job retry error:', error);
    sendError(res, 'Failed to retry job', 500);
  }
});

router.post('/apple-pay/jobs/:id/items/:itemId/retry', async (req, res) => {
  try {
    if (req.user?.role !== 'system_admin') {
      return sendError(res, 'System admin access required', 403, 'FORBIDDEN');
    }
    const id = parseInt(req.params.id, 10);
    const itemId = parseInt(req.params.itemId, 10);
    if (isNaN(id) || isNaN(itemId)) return sendError(res, 'Invalid id', 400, 'INVALID_ID');

    const existing = req.organizationContextId === undefined
      ? await storage.getApplePayJob(id)
      : await storage.getApplePayJob(id, req.organizationContextId);
    if (!existing) return sendError(res, 'Job not found', 404, 'NOT_FOUND');

    const result = req.organizationContextId === undefined
      ? await storage.retryApplePayJobItem(id, itemId)
      : await storage.retryApplePayJobItem(id, itemId, req.organizationContextId);
    if (!result) {
      return sendError(
        res,
        `Item is not retryable (job status: ${existing.status}). Items can only be retried on failed/partial/canceled jobs.`,
        409,
        'NOT_RETRYABLE',
      );
    }
    if (!isWorkerKickSuppressed(req)) applePayWorker.kick();
    log.info('Apple Pay job item retried by admin', { jobId: id, itemId, by: req.user?.id });
    sendSuccess(res, { item: result.item, job: result.job });
  } catch (error) {
    log.error('Apple Pay item retry error:', error);
    sendError(res, 'Failed to retry item', 500);
  }
});

router.get('/apple-pay/recovery-alerts/recent', async (req, res) => {
  try {
    if (req.user?.role !== 'system_admin') {
      return sendError(res, 'System admin access required', 403, 'FORBIDDEN');
    }
    const event = await storage.getRecentAlerterEvent(
      applePayRecoveryAlertKind(req.organizationContextId),
      RECENT_ALERT_WINDOW_MS,
    );
    if (!event) return sendSuccess(res, { alert: null });
    // The shared `AlerterSummary` type is now a discriminated union
    // (#644 added the Square-catalog-cap variant). This row is keyed
    // by the Apple-Pay alert kind, so narrow with a Partial<> cast
    // and read defensively in case an old row is missing fields.
    const summary = event.summary as Partial<ApplePayRecoveryAlerterSummary> | null;
    sendSuccess(res, {
      alert: {
        sentAt: event.lastSentAt.toISOString(),
        itemCount: summary?.itemCount ?? 0,
        affectedJobIds: summary?.affectedJobIds ?? [],
      },
    });
  } catch (error) {
    log.error('Apple Pay recent recovery alert error:', error);
    sendError(res, 'Failed to load recent recovery alert', 500);
  }
});

router.post('/apple-pay/register-domain', async (req, res) => {
  try {
    if (req.user?.role !== 'system_admin' && req.user?.role !== 'org_admin') {
      return sendError(res, 'Admin access required', 403, 'FORBIDDEN');
    }

    const { domain, locationId } = req.body;
    if (!domain || typeof domain !== 'string') {
      return sendError(res, 'Domain is required', 400, 'VALIDATION_ERROR');
    }

    // Tenant-isolation invariant: an org_admin MUST resolve the payment
    // provider via one of their own locations. We enforce locationId
    // presence + ownership here so the org_admin branch never falls
    // through to `getPaymentProvider(null)`. Today that helper throws,
    // but a future refactor that resolves a "default" provider for null
    // would silently let an org_admin register their domain against
    // another tenant's Square account. Validate at the route boundary.
    if (req.user.role === 'org_admin') {
      // Defensive guard: an org_admin without an organizationId should
      // never have reached this route. Fail closed rather than risk
      // falling through to `getPaymentProvider(null)`.
      if (!req.user.organizationId) {
        return sendError(res, 'Org admin is missing an organization', 403, 'FORBIDDEN');
      }

      const org = await storage.getOrganization(req.user.organizationId);
      if (org) {
        // Accepted domain set: current `<subdomain>.leaguevault.app` and
        // `<slug>.leaguevault.app`, plus any domain we've previously
        // registered successfully for this org. The previously-registered
        // list is what makes this route tolerate a slug/subdomain rename
        // after the wallet domain was first registered (task #277).
        const previouslyRegistered = await storage.getRegisteredApplePayDomainsForOrg(org.id);
        if (!isAcceptedApplePayDomain(org, domain, previouslyRegistered)) {
          log.warn('Org admin Apple Pay domain rejected', {
            orgId: org.id,
            attempted: domain,
            accepted: acceptedApplePayDomainsForOrg(org, previouslyRegistered),
          });
          return sendError(res, 'Domain does not match your organization', 403, 'FORBIDDEN');
        }
      }

      // Strict integer validation: reject anything that isn't a whole
      // positive integer (e.g. "123abc", "1.5", " ", null, undefined,
      // ""). We deliberately avoid `parseInt` here because it accepts
      // numeric prefixes like "123abc" -> 123, which would silently
      // coerce malformed input into a valid-looking location ID.
      const rawLocationId = locationId;
      const isPositiveIntString =
        typeof rawLocationId === 'string' && /^\d+$/.test(rawLocationId.trim()) && rawLocationId.trim().length > 0;
      const isPositiveIntNumber =
        typeof rawLocationId === 'number' && Number.isInteger(rawLocationId) && rawLocationId > 0;
      if (!isPositiveIntString && !isPositiveIntNumber) {
        return sendError(res, 'locationId is required', 400, 'VALIDATION_ERROR');
      }
      const parsedLocationId =
        typeof rawLocationId === 'number' ? rawLocationId : Number(String(rawLocationId).trim());
      if (!Number.isInteger(parsedLocationId) || parsedLocationId <= 0) {
        return sendError(res, 'locationId is required', 400, 'VALIDATION_ERROR');
      }

      const location = await storage.getLocation(parsedLocationId);
      if (!location || location.organizationId !== req.user.organizationId) {
        return sendError(res, 'Location does not belong to your organization', 403, 'FORBIDDEN');
      }
    }

    if (req.organizationContextId !== undefined && req.user.role === 'system_admin') {
      const rawLocationId = locationId;
      const parsedLocationId = typeof rawLocationId === 'number'
        ? rawLocationId
        : typeof rawLocationId === 'string' && /^\d+$/.test(rawLocationId.trim())
          ? Number(rawLocationId.trim())
          : NaN;
      if (!Number.isSafeInteger(parsedLocationId) || parsedLocationId <= 0) {
        return sendError(res, 'locationId is required', 400, 'VALIDATION_ERROR');
      }
      const location = await storage.getLocation(parsedLocationId);
      if (!location || !requireOrganizationAccess(req, location.organizationId)) {
        return sendError(res, 'Location does not belong to the configured organization', 403, 'FORBIDDEN');
      }
    }

    const lvLocationId = locationId ? parseInt(String(locationId), 10) : null;
    try {
      const provider = await getPaymentProvider(lvLocationId);
      if (!hasWalletSupport(provider)) {
        return sendError(res, 'Payment provider does not support Apple Pay', 400, 'UNSUPPORTED_FEATURE');
      }

      const result = await provider.registerApplePayDomain(domain);

      if (result.success) {
        sendSuccess(res, result);
      } else {
        sendError(res, result.message, 400, 'REGISTRATION_FAILED');
      }
    } catch (e) {
      // ProviderNotConfiguredError can come from EITHER
      // `getPaymentProvider` (locationId is null / location row
      // missing / unknown provider type) OR from the provider's own
      // wallet method when its credentials aren't set up. Map both to
      // the same 422 so callers don't have to distinguish.
      if (e instanceof ProviderNotConfiguredError) {
        return sendError(res, 'Payment provider not configured for this location', 422, 'PROVIDER_NOT_CONFIGURED');
      }
      throw e;
    }
  } catch (error) {
    log.error('Apple Pay domain registration error:', error);
    sendError(res, 'Failed to register domain for Apple Pay', 500);
  }
});

export default router;
