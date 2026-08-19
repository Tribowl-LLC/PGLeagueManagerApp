import { storage } from '../storage';
import { getPaymentProvider, ProviderNotConfiguredError } from './payment-provider-factory';
import { createLogger } from '../logger';
import { notifyPaymentSyncRetryChanged } from './payment-sync-retry-scheduler';
import { isDev } from '../config';
import { PAYMENT_SYNC_MAX_ATTEMPTS, type Bowler } from '@shared/schema';
import type { PaymentProvider } from './payment-provider';
import { syncBowlerLeagueAttributesToProvider } from './bowler-attributes';
import { decideBowlerPhoneSync } from './bowler-phone-sync';
import { linkUserToBowler } from './identity-link';

const log = createLogger("BowlerSync");

export async function runBowlerPostCreateSync(
  bowler: Bowler,
  organizationId: number | undefined,
): Promise<Bowler> {
  let current = bowler;

  const bowlerEmail = current.email;
  // Track whether the post-create Square sync ended up with a linked
  // customer id. Every code path that today silently leaves the
  // bowler without a `paymentCustomerId` (no Square location
  // configured for the org, ProviderNotConfiguredError, generic
  // provider throw, provider returned no customer id) must now stamp
  // `paymentSyncPendingAt` so the background retry sweep
  // (`server/services/payment-sync-retry.ts`) picks the bowler up
  // and re-runs the customer sync. The `bowlerEmail` guard below is
  // intentionally kept — a bowler with no email genuinely has
  // nothing to sync, mirroring `syncBowlerForUser`'s `'skipped'`
  // contract. Task #682.
  let squareCustomerLinked = false;
  if (bowlerEmail) {
    try {
      const matchingUser = await storage.getUserByEmail(bowlerEmail.trim().toLowerCase());
      if (matchingUser && matchingUser.bowlerId === null) {
        await linkUserToBowler({
          organizationId: organizationId ?? current.organizationId,
          userId: matchingUser.id,
          bowlerId: current.id,
          actorUserId: null,
          eventType: 'admin_assignment',
          source: 'bowler-post-create-email-auto-link',
          reason: 'email-match-after-bowler-create',
        });
        log.info(`Auto-linked user ${matchingUser.id} to bowler ${current.id}`);

        // Task #677: user wins for `phone`. Apply the overwrite
        // BEFORE the Square branch below so the downstream customer
        // update sees the right value from `current.phone`.
        const phoneDecision = decideBowlerPhoneSync(matchingUser, current);
        if (phoneDecision.write) {
          try {
            current = await storage.updateBowler(current.id, { phone: phoneDecision.phone });
          } catch (phoneErr) {
            log.error('Bowler sync: failed to overwrite bowler.phone from linked user:', phoneErr);
          }
        }

        const bowlerLeagues = await storage.getBowlerLeagues({ bowlerId: current.id });
        if (bowlerLeagues.length > 0) {
          const league = await storage.getLeague(bowlerLeagues[0].leagueId);
          if (league?.organizationId && !matchingUser.organizationId) {
            await storage.setUserOrganization(matchingUser.id, league.organizationId);
            if (isDev) log.info(`Set user ${matchingUser.id} organization to ${league.organizationId}`);
          }
        }
      }
    } catch (linkError) {
      log.error('Error auto-linking user to bowler:', linkError);
    }

    try {
      const squareLocation = organizationId
        ? await storage.getFirstSquareConfiguredLocation(organizationId)
        : null;
      if (squareLocation?.id) {
        let providerCustomer = null;
        // Lifted out of the inner `try` so the post-customer attribute
        // sync (task #429) can reuse the same provider instance —
        // re-resolving here would either bill us for an extra Square
        // round trip or, worse, race against a credential rotation.
        let syncProvider: PaymentProvider | null = null;
        try {
          syncProvider = await getPaymentProvider(squareLocation.id);
          providerCustomer = await syncProvider.createOrUpdateCustomer(
            current.name,
            bowlerEmail,
            current.phone,
            // Bowler reference for the Square dashboard (task #429).
            `bowler:${current.id}`,
          );
        } catch (e) {
          if (e instanceof ProviderNotConfiguredError) {
            log.warn('Bowler sync: provider not configured, skipping customer sync', { locationId: squareLocation.id });
          } else {
            throw e;
          }
        }
        if (providerCustomer) {
          squareCustomerLinked = true;
          current = await storage.updateBowler(current.id, {
            ...current,
            paymentCustomerId: providerCustomer.id,
            // Stamp the originating location so account-deletion can
            // target exactly this processor for cleanup. See task #346.
            paymentProviderLocationId: squareLocation.id,
            active: true,
          });

          // Push the bowler's current league_name + league_season to
          // Square. NON-FATAL by contract: if the writes fail we flag
          // the bowler so `payment-sync-retry.ts` re-runs the whole
          // customer sync (which loops back through this helper) on
          // the next sweep. We never throw or roll back the customer
          // record over an attribute failure (task #429).
          if (syncProvider) {
            const attrResult = await syncBowlerLeagueAttributesToProvider(
              syncProvider,
              providerCustomer.id,
              current.id,
            );
            if (
              !attrResult.ok
              && current.paymentSyncNextRetryAt == null
              && current.paymentSyncAttempts < PAYMENT_SYNC_MAX_ATTEMPTS
            ) {
              try {
                const nowIso = new Date().toISOString();
                current = await storage.updateBowler(current.id, {
                  ...current,
                  paymentSyncPendingAt: current.paymentSyncPendingAt ?? nowIso,
                  paymentSyncNextRetryAt: nowIso,
                });
                notifyPaymentSyncRetryChanged();
              } catch (markErr) {
                log.error(
                  'Bowler sync: failed to flag bowler for attribute-sync retry',
                  markErr,
                );
              }
            }
          }
        }
      }
    } catch (syncError) {
      log.error('Payment provider error during bowler sync:', syncError);
    }

    // Task #682: if every code path above failed to link a Square
    // customer (no Square location configured for the org,
    // ProviderNotConfiguredError, generic provider throw, or provider
    // returned no customer id), flag the bowler so the background
    // retry sweep picks it up and re-runs the customer sync. Without
    // this flag the bowler stays in `paymentCustomerId IS NULL`
    // limbo forever — the sweep only walks rows whose
    // `paymentSyncPendingAt` is set, and no other code path was
    // restamping it after the silent failure.
    //
    // Queue the first durable retry immediately. A failed retry computes its
    // next due time from the shared bounded backoff policy.
    if (
      !squareCustomerLinked
      && current.paymentSyncNextRetryAt == null
      && current.paymentSyncAttempts < PAYMENT_SYNC_MAX_ATTEMPTS
    ) {
      try {
        const nowIso = new Date().toISOString();
        current = await storage.updateBowler(current.id, {
          ...current,
          paymentSyncPendingAt: current.paymentSyncPendingAt ?? nowIso,
          paymentSyncNextRetryAt: nowIso,
        });
        notifyPaymentSyncRetryChanged();
      } catch (markErr) {
        log.error(
          'Bowler sync: failed to flag bowler for post-create retry',
          markErr,
        );
      }
    }
  }

  return current;
}
