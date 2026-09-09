import { storage } from '../storage';
import { getPaymentProvider, ProviderNotConfiguredError } from './payment-provider-factory';
import { createLogger } from '../logger';
import { notifyPaymentSyncRetryChanged } from './payment-sync-retry-scheduler';
import { PAYMENT_SYNC_MAX_ATTEMPTS, type Bowler } from '@shared/schema';
import type { PaymentProvider } from './payment-provider';
import { syncBowlerLeagueAttributesToProvider } from './bowler-attributes';
import { decideBowlerPhoneSync } from './bowler-phone-sync';
import { linkUserToBowler } from './identity-link';
import { sendAccountReadyEmail } from './email';

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
      const normalizedBowlerEmail = bowlerEmail.trim().toLowerCase();
      const effectiveOrganizationId = organizationId ?? current.organizationId;
      const matchingUser = normalizedBowlerEmail.length > 0
        ? await storage.getUserByEmail(normalizedBowlerEmail)
        : undefined;
      // getBowlerByEmail applies the tenant-scoped LIMIT 2 unique-match
      // policy across all profiles, including already-claimed rows. A
      // duplicate same-email profile therefore remains pending rather than
      // allowing this newly-created row to win automatically.
      const matchingBowler = normalizedBowlerEmail.length > 0
        && matchingUser?.role === 'user'
        && matchingUser.organizationId === effectiveOrganizationId
        && matchingUser.bowlerId === null
        ? await storage.getBowlerByEmail(normalizedBowlerEmail, effectiveOrganizationId)
        : undefined;
      if (
        matchingUser &&
        matchingUser.role === 'user' &&
        matchingUser.organizationId === effectiveOrganizationId &&
        matchingUser.bowlerId === null &&
        matchingBowler?.id === current.id
      ) {
        await linkUserToBowler({
          organizationId: effectiveOrganizationId,
          userId: matchingUser.id,
          bowlerId: current.id,
          actorUserId: null,
          eventType: 'admin_assignment',
          source: 'bowler-post-create-email-auto-link',
          reason: 'email-match-after-bowler-create',
          // Re-check the exact normalized email while the identity service
          // holds both rows locked; the lookup above is only a candidate
          // optimization and not the ownership boundary.
          requireEmailMatch: true,
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
        const firstMembership = bowlerLeagues[0];
        const league = firstMembership
          ? await storage.getLeague(firstMembership.leagueId)
          : undefined;
        // The identity-link transaction has committed before this helper
        // runs. Account readiness is about access to leagues, not payment
        // provider/customer readiness, so provider failures below cannot
        // suppress or duplicate this one post-link notification. Send even
        // when the new bowler has not been rostered yet; the message still
        // establishes account access and directs the user to sign in.
        const organization = effectiveOrganizationId
          ? await storage.getOrganization(effectiveOrganizationId)
          : undefined;
        const team = firstMembership
          ? await storage.getTeam(firstMembership.teamId)
          : undefined;
        try {
          await sendAccountReadyEmail({
            toEmail: matchingUser.email,
            toName: matchingUser.name,
            bowlerName: current.name,
            leagueName: league?.organizationId === effectiveOrganizationId ? league.name : '',
            teamName: league?.organizationId === effectiveOrganizationId
              && team?.leagueId === league.id
              ? team.name
              : '',
            organization: organization ?? null,
          });
        } catch (emailError) {
          log.warn('Account-ready email failed after bowler auto-link:', emailError);
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
