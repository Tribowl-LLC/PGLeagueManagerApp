import { storage } from '../storage';
import { db } from '../db.js';
import { bowlerLeagues, leagues, emailChangeRequests } from '@shared/schema';
import { eq, inArray } from 'drizzle-orm';
import { createLogger } from '../logger';
import { getPaymentProvider } from './payment-provider-factory';
import { buildPaymentErrorResponse } from '../utils/payment-error-response';
import { hasCustomerCleanupSupport } from './payment-provider';
import { sendAccountDeletionConfirmation } from './email';
import type { DeletionExecutionSummary } from '@shared/schema';

const log = createLogger('AccountDeletion');

interface ProviderTarget {
  locationId: number;
  customerId: string;
}

/**
 * Collect every distinct (locationId, paymentCustomerId) pair we should
 * try to delete on the payment processor side for this set of bowlers.
 *
 * Modern rows carry `bowlers.paymentProviderLocationId`, which records
 * the originating processor at the time the customer record was first
 * written (see task #346 and the writers in
 * `server/services/payment-customer-sync.ts`,
 * `server/services/bowler-sync.ts`,
 * and the bowlers PATCH route). For those rows we emit a single
 * (locationId, customerId) pair per saved id — no fan-out across
 * unrelated locations and no spurious `provider does not support
 * customer deletion` audit entries.
 *
 * Legacy rows (column NULL — written before #346) still need the old
 * best-effort behaviour: scan every location reachable through the
 * bowler's leagues and try each one. We carry the legacy code path
 * unchanged for those rows and skip the join entirely if every row
 * has the column populated.
 */
async function collectProviderTargets(
  bowlers: {
    id: number;
    paymentCustomerId: string | null;
    paymentProviderLocationId: number | null;
  }[],
): Promise<ProviderTarget[]> {
  const customerByBowler = new Map<number, string[]>();
  for (const b of bowlers) {
    const ids: string[] = [];
    if (b.paymentCustomerId) ids.push(b.paymentCustomerId);
    if (ids.length > 0) customerByBowler.set(b.id, ids);
  }
  if (customerByBowler.size === 0) return [];

  const targets: ProviderTarget[] = [];
  const seen = new Set<string>();
  const pushTarget = (locationId: number, customerId: string) => {
    const key = `${locationId}:${customerId}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ locationId, customerId });
  };

  // Direct-lookup path: bowlers whose origin location is recorded.
  const legacyBowlerIds: number[] = [];
  for (const b of bowlers) {
    const ids = customerByBowler.get(b.id);
    if (!ids) continue;
    if (b.paymentProviderLocationId != null) {
      for (const cid of ids) pushTarget(b.paymentProviderLocationId, cid);
    } else {
      legacyBowlerIds.push(b.id);
    }
  }

  // Legacy fan-out path: only run the join for rows that lack the
  // origin column, so modern callers don't pay for it.
  if (legacyBowlerIds.length > 0) {
    const rows = await db
      .selectDistinct({ bowlerId: bowlerLeagues.bowlerId, locationId: leagues.locationId })
      .from(bowlerLeagues)
      .innerJoin(leagues, eq(bowlerLeagues.leagueId, leagues.id))
      .where(inArray(bowlerLeagues.bowlerId, legacyBowlerIds));

    for (const r of rows) {
      if (r.locationId == null) continue;
      const ids = customerByBowler.get(r.bowlerId) ?? [];
      for (const cid of ids) pushTarget(r.locationId, cid);
    }
  }

  return targets;
}

/**
 * Execute the automated account-data deletion for a single email
 * address. Anonymizes every matching bowler row (preserving FK-protected
 * historical data), best-effort deletes the corresponding customer
 * records on each configured payment provider, removes any pending
 * email-change requests for the user account, and finally deletes the
 * user row.
 *
 * Returns a structured audit summary describing what was removed. The
 * caller is expected to persist this onto the originating deletion
 * request (see `completeDeletionRequestWithExecution`).
 */
export async function executeAccountDeletion(
  email: string,
  reviewerId: number,
  // Task #349: when false, skip the post-deletion confirmation email
  // entirely. The originating deletion request stores this flag (set
  // by the requester on the public form); the admin /execute route
  // reads it off the row and forwards it here. Defaults to true so
  // direct callers (e.g. the existing test suite) and historic rows
  // — where the column did not exist — keep the original behaviour.
  notifyOnCompletion: boolean = true,
): Promise<DeletionExecutionSummary> {
  const summary: DeletionExecutionSummary = {
    executedAt: new Date().toISOString(),
    executedBy: reviewerId,
    email,
    user: { deleted: false, userId: null },
    bowlers: [],
    paymentProvider: [],
    emailChangeRequestsDeleted: 0,
    confirmationEmail: {
      sent: false,
      suppressedByUser: !notifyOnCompletion,
    },
  };

  const bowlersToScrub = await storage.getBowlersByEmailSystemAdmin(email);

  // Collect provider cleanup targets BEFORE we anonymize, since the
  // anonymize step nulls paymentCustomerId.
  const providerTargets = await collectProviderTargets(bowlersToScrub);

  // 1. Best-effort delete customer records at the payment processors.
  for (const target of providerTargets) {
    let providerName = 'unknown';
    try {
      const provider = await getPaymentProvider(target.locationId);
      providerName = provider.providerName;
      if (!hasCustomerCleanupSupport(provider)) {
        summary.paymentProvider.push({
          locationId: target.locationId,
          providerName,
          customerId: target.customerId,
          deleted: false,
          error: 'provider does not support customer deletion',
        });
        continue;
      }
      await provider.deleteCustomer(target.customerId);
      summary.paymentProvider.push({
        locationId: target.locationId,
        providerName,
        customerId: target.customerId,
        deleted: true,
      });
    } catch (error) {
      // Route the error through the shared helper so the typed
      // PaymentProviderError.userMessage / ProviderNotConfiguredError
      // map to the same actionable strings every other payment-write
      // path uses. The audit summary's `error` field is rendered to
      // an admin in the deletion-history view, so a typed
      // "Your payment was declined." would be misleading here — for
      // anything we don't recognize as typed, we keep the raw
      // `error.message` (server-side audit, not user-visible toast).
      // Task #605.
      const fallback = error instanceof Error ? error.message : String(error);
      const { userMessage } = buildPaymentErrorResponse(
        error,
        fallback,
        'PROVIDER_DELETION_FAILED',
      );
      log.warn('Payment-provider customer deletion failed', {
        locationId: target.locationId,
        customerId: target.customerId,
        error: userMessage,
      });
      summary.paymentProvider.push({
        locationId: target.locationId,
        providerName,
        customerId: target.customerId,
        deleted: false,
        error: userMessage,
      });
    }
  }

  // 2. Anonymize each bowler row in place. We deliberately do NOT
  //    cascade-delete bowlers here because that would wipe payments,
  //    scores, and historical league data via the ON DELETE CASCADE
  //    foreign keys. Anonymization preserves history while removing
  //    PII.
  for (const bowler of bowlersToScrub) {
    const entry = {
      bowlerId: bowler.id,
      anonymized: false,
      hadPaymentCustomerId: !!bowler.paymentCustomerId,
    } as DeletionExecutionSummary['bowlers'][number];
    try {
      await storage.anonymizeBowler(bowler.id);
      entry.anonymized = true;
    } catch (error) {
      entry.reason = error instanceof Error ? error.message : String(error);
      log.error('Failed to anonymize bowler', { bowlerId: bowler.id, error: entry.reason });
    }
    summary.bowlers.push(entry);
  }

  // 3. Find the user row by email (case-insensitive lookup since the
  //    schema stores them as-supplied; getUserByEmail uses exact match
  //    so we try a normalised variant too).
  const user =
    (await storage.getUserByEmail(email)) ??
    (await storage.getUserByEmail(email.toLowerCase()));

  if (user) {
    summary.user.userId = user.id;

    // Delete pending email-change requests up front. They have ON
    // DELETE CASCADE, so this is mostly belt-and-suspenders, but we
    // also want a count for the audit log.
    const ecrRows = await db
      .delete(emailChangeRequests)
      .where(eq(emailChangeRequests.userId, user.id))
      .returning({ id: emailChangeRequests.id });
    summary.emailChangeRequestsDeleted = ecrRows.length;

    try {
      await storage.deleteUser(user.id, undefined, reviewerId);
      summary.user.deleted = true;
    } catch (error) {
      summary.user.reason = error instanceof Error ? error.message : String(error);
      log.error('Failed to delete user during automated deletion', {
        userId: user.id,
        error: summary.user.reason,
      });
    }
  } else {
    summary.user.reason = 'no user account found for this email';
  }

  const bowlersAnonymized = summary.bowlers.filter((b) => b.anonymized).length;
  const paymentProviderRecordsDeleted = summary.paymentProvider.filter((p) => p.deleted).length;

  log.info('Executed automated account deletion', {
    email,
    reviewerId,
    bowlersAnonymized,
    providerDeletions: paymentProviderRecordsDeleted,
    userDeleted: summary.user.deleted,
  });

  // Best-effort confirmation email to the original requester.
  // Per task #314: a SendGrid failure (or missing key, or a thrown
  // exception inside the email helper) must NEVER roll back the
  // deletion that just happened — log and move on.
  //
  // Task #349: skip the send entirely when the requester opted out on
  // the public deletion-request form. The summary's
  // `confirmationEmail` block was already initialised above to
  // `{ sent: false, suppressedByUser: !notifyOnCompletion }`, so the
  // admin history view can render "suppressed by user" without an
  // additional flag.
  if (!notifyOnCompletion) {
    log.info('Skipping account-deletion confirmation email (requester opted out)', {
      email,
    });
  } else {
    try {
      const sent = await sendAccountDeletionConfirmation(email, {
        bowlersAnonymized,
        userAccountDeleted: summary.user.deleted,
        paymentProviderRecordsDeleted,
        emailChangeRequestsDeleted: summary.emailChangeRequestsDeleted,
        executedAt: summary.executedAt,
      });
      if (sent) {
        summary.confirmationEmail!.sent = true;
      } else {
        summary.confirmationEmail!.error = 'SendGrid send returned false (see server logs)';
        log.warn('Account-deletion confirmation email was not sent', { email });
      }
    } catch (err) {
      summary.confirmationEmail!.error =
        err instanceof Error ? err.message : String(err);
      log.error('Account-deletion confirmation email threw', {
        email,
        error: summary.confirmationEmail!.error,
      });
    }
  }

  return summary;
}
