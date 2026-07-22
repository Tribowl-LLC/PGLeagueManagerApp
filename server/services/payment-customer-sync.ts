/**
 * Payment-customer sync helper used by profile updates and the admin
 * "retry payment sync" endpoint.
 *
 * Returns a status the API caller can use to surface a "your payment
 * record may be stale, we'll retry" notice when the provider call fails
 * for a real reason. Real failures also flip
 * `bowlers.payment_sync_pending_at` so the admin retry endpoint and the
 * next profile edit can re-attempt without losing track of the work.
 */
import { storage } from '../storage';
import { getPaymentProvider, ProviderNotConfiguredError } from './payment-provider-factory';
import { createLogger } from '../logger';
import { isDev } from '../config';
import type { PaymentProvider } from './payment-provider';
import { syncBowlerLeagueAttributesToProvider } from './bowler-attributes';
import type { Bowler, PaymentSyncStatus } from '@shared/schema';

const log = createLogger('PaymentCustomerSync');

// Re-exported for backwards compatibility with the many call sites that
// already import `PaymentSyncStatus` from this service. The single
// source of truth lives in `shared/schema/bowlers.ts` (task #374) so
// the client and server can never drift on the union's members.
export type { PaymentSyncStatus };

// Background retry sweep gives up after this many consecutive failed
// attempts (task #284). Surfaced here so the sweep service and the
// helper agree on when to log the structured "given up" error.
export const PAYMENT_SYNC_MAX_ATTEMPTS = 5;

export interface SyncableUser {
  id: number;
  bowlerId: number | null;
  name: string;
  email: string | null;
  phone: string | null;
  locationId: number | null;
  organizationId: number | null;
}

export interface ProfileChanges {
  nameChanged: boolean;
  emailChanged: boolean;
  phoneChanged: boolean;
}

export async function syncBowlerForUser(
  user: SyncableUser,
  changed: ProfileChanges,
): Promise<PaymentSyncStatus> {
  if (!user.bowlerId) return 'not_applicable';

  const bowler = await storage.getBowler(user.bowlerId);
  if (!bowler) return 'not_applicable';

  const bowlerUpdate: Record<string, unknown> = {};
  if (changed.nameChanged) bowlerUpdate.name = user.name;
  if (changed.emailChanged) bowlerUpdate.email = user.email;
  if (changed.phoneChanged) bowlerUpdate.phone = user.phone;

  if (Object.keys(bowlerUpdate).length > 0) {
    try {
      await storage.updateBowler(bowler.id, { ...bowler, ...bowlerUpdate });
      if (isDev) log.info('Synced profile changes to bowler record:', bowler.id);
    } catch (e) {
      log.error('Failed to write local bowler row during profile sync:', e);
      return 'pending_retry';
    }
  }

  if (!user.email) return 'skipped';

  let resolvedSquareLocationId: number | null = null;
  if (user.locationId) {
    const locationCreds = await storage.getLocationSquareConfig(user.locationId);
    if ((locationCreds?.accessToken ?? '').trim().length > 0) {
      resolvedSquareLocationId = user.locationId;
    }
  }
  if (!resolvedSquareLocationId && user.organizationId) {
    const sq = await storage.getFirstSquareConfiguredLocation(user.organizationId);
    resolvedSquareLocationId = sq?.id ?? null;
  }
  if (!resolvedSquareLocationId) {
    if (isDev) log.info('No payment-configured location found, skipping customer sync');
    return 'skipped';
  }

  let providerCustomer: { id: string } | null = null;
  // Lifted so the post-customer attribute sync (task #429) can reuse
  // the same provider instance.
  let userProvider: PaymentProvider | null = null;
  try {
    userProvider = await getPaymentProvider(resolvedSquareLocationId);
    providerCustomer = await userProvider.createOrUpdateCustomer(
      user.name,
      user.email,
      user.phone,
      // Bowler reference for the Square dashboard (task #429).
      `bowler:${bowler.id}`,
    );
  } catch (e) {
    if (e instanceof ProviderNotConfiguredError) {
      log.warn('User update: provider not configured, skipping customer sync', { locationId: resolvedSquareLocationId });
      return 'skipped';
    }
    log.warn('Payment customer sync failed, marking bowler for retry', {
      userId: user.id,
      bowlerId: bowler.id,
      locationId: resolvedSquareLocationId,
      errorName: e instanceof Error ? e.name : 'unknown',
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    const nowIso = new Date().toISOString();
    const nextAttempts = (bowler.paymentSyncAttempts ?? 0) + 1;
    try {
      await storage.updateBowler(bowler.id, {
        ...bowler,
        ...bowlerUpdate,
        // Preserve the original failure timestamp so admins can see how
        // long this bowler has been pending; only set it the first time.
        paymentSyncPendingAt: bowler.paymentSyncPendingAt ?? nowIso,
        paymentSyncAttempts: nextAttempts,
        paymentSyncLastAttemptAt: nowIso,
      });
    } catch (markErr) {
      log.error('Failed to flag bowler for payment-sync retry:', markErr);
    }
    if (nextAttempts >= PAYMENT_SYNC_MAX_ATTEMPTS) {
      log.error('Payment-customer sync gave up after max retry attempts', {
        userId: user.id,
        bowlerId: bowler.id,
        locationId: resolvedSquareLocationId,
        attempts: nextAttempts,
        maxAttempts: PAYMENT_SYNC_MAX_ATTEMPTS,
        pendingSince: bowler.paymentSyncPendingAt ?? nowIso,
        errorName: e instanceof Error ? e.name : 'unknown',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
    return 'pending_retry';
  }

  // Custom-attribute sync (task #429). Run BEFORE we clear the pending
  // flag below so a failure here keeps the bowler in the retry queue
  // for the next sweep. Non-fatal by contract — the customer record is
  // still considered successfully synced even if attribute writes fail.
  let attrSyncOk = true;
  if (providerCustomer && userProvider) {
    const attrResult = await syncBowlerLeagueAttributesToProvider(
      userProvider,
      providerCustomer.id,
      bowler.id,
    );
    attrSyncOk = attrResult.ok;
  }

  const updates: Record<string, unknown> = { ...bowlerUpdate };
  let needsWrite = false;
  if (providerCustomer && providerCustomer.id !== bowler.paymentCustomerId) {
    updates.paymentCustomerId = providerCustomer.id;
    // Stamp the originating location so account-deletion can target
    // exactly this processor for saved-card cleanup. See task #346.
    updates.paymentProviderLocationId = resolvedSquareLocationId;
    needsWrite = true;
    log.info('Linked payment customer to bowler:', providerCustomer.id);
  }
  if (attrSyncOk) {
    if (bowler.paymentSyncPendingAt !== null) {
      updates.paymentSyncPendingAt = null;
      needsWrite = true;
    }
    if ((bowler.paymentSyncAttempts ?? 0) > 0) {
      updates.paymentSyncAttempts = 0;
      needsWrite = true;
    }
    if (bowler.paymentSyncLastAttemptAt != null) {
      updates.paymentSyncLastAttemptAt = null;
      needsWrite = true;
    }
  } else {
    // Attribute writes failed: keep the bowler flagged so the retry
    // sweep (`payment-sync-retry.ts`) re-runs `syncBowlerForUser` and
    // ultimately re-runs the attribute upserts. Mirror the customer-
    // creation failure branch above and ALSO bump
    // `paymentSyncAttempts` + stamp `paymentSyncLastAttemptAt`.
    // Without these two writes the row stays at attempts=0 forever
    // and the retry sweep loops on it every tick, never crossing
    // PAYMENT_SYNC_MAX_ATTEMPTS and never logging the structured
    // "given up" line. Preserve the original `paymentSyncPendingAt`
    // so the admin "pending since" surface still reflects how long
    // the bowler has actually been stuck.
    const nowIso = new Date().toISOString();
    const nextAttempts = (bowler.paymentSyncAttempts ?? 0) + 1;
    if (bowler.paymentSyncPendingAt == null) {
      updates.paymentSyncPendingAt = nowIso;
      needsWrite = true;
    }
    updates.paymentSyncAttempts = nextAttempts;
    updates.paymentSyncLastAttemptAt = nowIso;
    needsWrite = true;
    if (nextAttempts >= PAYMENT_SYNC_MAX_ATTEMPTS) {
      log.error('Payment-customer sync gave up after max retry attempts', {
        userId: user.id,
        bowlerId: bowler.id,
        locationId: resolvedSquareLocationId,
        attempts: nextAttempts,
        maxAttempts: PAYMENT_SYNC_MAX_ATTEMPTS,
        pendingSince: bowler.paymentSyncPendingAt ?? nowIso,
        stage: 'custom_attribute_upsert',
      });
    }
  }
  if (needsWrite) {
    try {
      await storage.updateBowler(bowler.id, { ...bowler, ...updates });
    } catch (e) {
      log.error('Failed to persist post-sync bowler updates:', e);
      return 'pending_retry';
    }
  }
  return attrSyncOk ? 'synced' : 'pending_retry';
}

/**
 * Sync a bowler that has no linked user to the payment provider, using
 * the bowler row itself as the source of truth (task #705).
 *
 * `syncBowlerForUser` is the source-of-truth path for *claimed* bowlers
 * (a User row's name/email/phone wins). When an admin adds an email to
 * an unclaimed bowler — or any time a bowler with `bowlerId IS NULL` on
 * its linked user side ends up in `payment_sync_pending_at` (no Square
 * location at the moment of the foreground PATCH, transient Square
 * 5xx, attribute upsert failure, etc.) — there is no user profile to
 * push, but the bowler row itself has a perfectly good name + email +
 * phone. This helper reuses the same provider semantics
 * (`createOrUpdateCustomer` + `syncBowlerLeagueAttributesToProvider`)
 * and the same attempt-counter / pending-flag bookkeeping as the
 * claimed-bowler path so retries converge identically.
 *
 * Skip semantics (returns `'skipped'`, does NOT bump attempts, does
 * NOT clear the pending flag):
 *   - bowler has no email                 (nothing to push)
 *   - bowler has no organizationId        (no provider context)
 *   - org has no Square-configured location
 *   - resolved provider raises ProviderNotConfiguredError
 *
 * Failure semantics (returns `'pending_retry'`, bumps
 * `paymentSyncAttempts`, sets/preserves `paymentSyncPendingAt`,
 * stamps `paymentSyncLastAttemptAt`, logs the structured "given up"
 * line at the cap): mirrors `syncBowlerForUser`.
 *
 * Success semantics (returns `'synced'`, clears the pending flag and
 * attempt counter, stamps `paymentCustomerId` +
 * `paymentProviderLocationId`): also mirrors `syncBowlerForUser`.
 *
 */
export async function syncUnclaimedBowler(bowlerId: number): Promise<PaymentSyncStatus> {
  const bowler = await storage.getBowler(bowlerId);
  if (!bowler) return 'not_applicable';
  return syncUnclaimedBowlerRow(bowler);
}

async function syncUnclaimedBowlerRow(bowler: Bowler): Promise<PaymentSyncStatus> {
  if (!bowler.email) return 'skipped';
  if (!bowler.organizationId) return 'skipped';

  const sq = await storage.getFirstSquareConfiguredLocation(bowler.organizationId);
  const resolvedSquareLocationId = sq?.id ?? null;
  if (!resolvedSquareLocationId) {
    if (isDev) log.info('Unclaimed bowler sync: no payment-configured location, skipping');
    return 'skipped';
  }

  let providerCustomer: { id: string } | null = null;
  let provider: PaymentProvider | null = null;
  try {
    provider = await getPaymentProvider(resolvedSquareLocationId);
    providerCustomer = await provider.createOrUpdateCustomer(
      bowler.name,
      bowler.email,
      bowler.phone,
      `bowler:${bowler.id}`,
    );
  } catch (e) {
    if (e instanceof ProviderNotConfiguredError) {
      log.warn('Unclaimed bowler sync: provider not configured, skipping', {
        bowlerId: bowler.id,
        locationId: resolvedSquareLocationId,
      });
      return 'skipped';
    }
    log.warn('Unclaimed bowler sync failed, marking bowler for retry', {
      bowlerId: bowler.id,
      locationId: resolvedSquareLocationId,
      errorName: e instanceof Error ? e.name : 'unknown',
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    const nowIso = new Date().toISOString();
    const nextAttempts = (bowler.paymentSyncAttempts ?? 0) + 1;
    try {
      await storage.updateBowler(bowler.id, {
        ...bowler,
        paymentSyncPendingAt: bowler.paymentSyncPendingAt ?? nowIso,
        paymentSyncAttempts: nextAttempts,
        paymentSyncLastAttemptAt: nowIso,
      });
    } catch (markErr) {
      log.error('Failed to flag unclaimed bowler for payment-sync retry:', markErr);
    }
    if (nextAttempts >= PAYMENT_SYNC_MAX_ATTEMPTS) {
      log.error('Unclaimed bowler payment-sync gave up after max retry attempts', {
        bowlerId: bowler.id,
        locationId: resolvedSquareLocationId,
        attempts: nextAttempts,
        maxAttempts: PAYMENT_SYNC_MAX_ATTEMPTS,
        pendingSince: bowler.paymentSyncPendingAt ?? nowIso,
        errorName: e instanceof Error ? e.name : 'unknown',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
    return 'pending_retry';
  }

  let attrSyncOk = true;
  if (providerCustomer && provider) {
    const attrResult = await syncBowlerLeagueAttributesToProvider(
      provider,
      providerCustomer.id,
      bowler.id,
    );
    attrSyncOk = attrResult.ok;
  }

  const updates: Record<string, unknown> = {};
  let needsWrite = false;
  if (providerCustomer && providerCustomer.id !== bowler.paymentCustomerId) {
    updates.paymentCustomerId = providerCustomer.id;
    updates.paymentProviderLocationId = resolvedSquareLocationId;
    needsWrite = true;
    log.info('Linked payment customer to unclaimed bowler:', providerCustomer.id);
  }
  if (attrSyncOk) {
    if (bowler.paymentSyncPendingAt !== null) {
      updates.paymentSyncPendingAt = null;
      needsWrite = true;
    }
    if ((bowler.paymentSyncAttempts ?? 0) > 0) {
      updates.paymentSyncAttempts = 0;
      needsWrite = true;
    }
    if (bowler.paymentSyncLastAttemptAt != null) {
      updates.paymentSyncLastAttemptAt = null;
      needsWrite = true;
    }
  } else {
    const nowIso = new Date().toISOString();
    const nextAttempts = (bowler.paymentSyncAttempts ?? 0) + 1;
    if (bowler.paymentSyncPendingAt == null) {
      updates.paymentSyncPendingAt = nowIso;
      needsWrite = true;
    }
    updates.paymentSyncAttempts = nextAttempts;
    updates.paymentSyncLastAttemptAt = nowIso;
    needsWrite = true;
    if (nextAttempts >= PAYMENT_SYNC_MAX_ATTEMPTS) {
      log.error('Unclaimed bowler payment-sync gave up after max retry attempts', {
        bowlerId: bowler.id,
        locationId: resolvedSquareLocationId,
        attempts: nextAttempts,
        maxAttempts: PAYMENT_SYNC_MAX_ATTEMPTS,
        pendingSince: bowler.paymentSyncPendingAt ?? nowIso,
        stage: 'custom_attribute_upsert',
      });
    }
  }
  if (needsWrite) {
    try {
      await storage.updateBowler(bowler.id, { ...bowler, ...updates });
    } catch (e) {
      log.error('Failed to persist post-sync unclaimed bowler updates:', e);
      return 'pending_retry';
    }
  }
  return attrSyncOk ? 'synced' : 'pending_retry';
}
