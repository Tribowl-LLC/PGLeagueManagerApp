import type { SquareClient } from 'square';
import { storage } from '../storage';
import { createLogger } from '../logger';
import {
  buildSquareClient,
  verifySquareSdkVersion,
  SQUARE_EXPECTED_VERSION,
  type SquareProviderContext,
} from './square-client';
import {
  processPayment,
  createOrderWithPayment,
  refundPayment,
  getRefund,
  getPayment,
} from './square-payments';
import {
  saveCardOnFile,
  listCardsOnFile,
  hasCardOnFile,
  disableCard,
  createOrUpdateCustomer,
  deleteCustomer,
  validateCardId,
} from './square-vault';
import {
  ensureCustomAttributeDefinitions,
  syncCustomerLeagueAttributes,
  repairCustomerAttributeDefinitions,
  clearDefinitionsBootstrapCacheForTests,
} from './square-attributes';
import {
  listCatalogCategories,
  listCatalogItems,
  registerApplePayDomain,
} from './square-catalog';
import type {
  PaymentProvider,
  CatalogProvider,
  WalletProvider,
  PaymentResult,
  RefundResult,
  SavedCard,
  PaymentCustomer,
  PaymentVerification,
  OrderLineItem,
  PaymentIdempotencyInput,
  CatalogCategory,
  CatalogItem,
} from './payment-provider';

const log = createLogger("SquareService");

// Re-export the SDK client / version-guard / idempotency infrastructure
// so every existing importer of `square-provider` keeps working
// unchanged (move-only split — task #765). Importing this module also
// triggers `square-client`'s side-effect registration of Square against
// the third-party pin verifier.
export {
  buildSquareIdempotencyKey,
  SQUARE_IDEMPOTENCY_MAX_LENGTH,
  SQUARE_EXPECTED_VERSION,
  buildSquareClient,
  verifySquareSdkVersion,
  _resetSquareSdkVersionVerificationForTests,
  _setSquareSdkVersionProbeForTests,
} from './square-client';

/**
 * Square payment provider.
 *
 * This class is intentionally thin: each capability lives in a focused
 * module (`square-payments`, `square-vault`, `square-attributes`,
 * `square-catalog`) and the class composes them by handing each module
 * function a `SquareProviderContext` built in the constructor. The
 * split is move-only — every public method keeps its original
 * signature and behavior (task #765).
 */
export class SquarePaymentProvider implements PaymentProvider, CatalogProvider, WalletProvider {
  readonly providerName = 'square';
  readonly locationId: number;
  private readonly ctx: SquareProviderContext;

  constructor(locationId: number) {
    this.locationId = locationId;
    this.ctx = {
      locationId,
      getClient: () => this.getSquareClient(),
      getLocationId: () => this.getSquareLocationId(),
    };
  }

  /**
   * Diagnostic-only accessor: returns the underlying Square SDK
   * client so one-off scripts (e.g. `scripts/list-square-attr-defs.ts`)
   * can inspect seller state without laundering the private through
   * a `as unknown as` double-cast (which the lint config bans).
   * Production code paths must continue to use the typed methods on
   * this provider.
   */
  async getSquareClientForDiagnostics(): Promise<SquareClient | null> {
    return this.getSquareClient();
  }

  private async getSquareClient(): Promise<SquareClient | null> {
    // Runtime Square-Version header guard (task #627). The probe is
    // memoized per process so this is a single fast resolution after
    // the first call (or after `server/index.ts`'s eager call at
    // boot, whichever happens first). Drift causes us to refuse to
    // hand back a client at all — same null contract that "no
    // credentials" already uses, so route layers fall back to
    // PROVIDER_NOT_CONFIGURED instead of letting a drifted SDK
    // exchange responses against an unaudited wire version.
    const verification = await verifySquareSdkVersion();
    if (!verification.ok) {
      log.error(
        `Refusing Square client for location ${this.locationId}: Square-Version header drift (expected ${SQUARE_EXPECTED_VERSION}, got ${verification.version ?? 'unknown'}). See docs/square-api-version-audit.md §6.`,
      );
      return null;
    }
    try {
      const creds = await storage.getLocationSquareConfig(this.locationId);
      if (creds?.accessToken && creds.accessToken.trim().length > 0) {
        return await buildSquareClient(creds.accessToken, creds.appId);
      }
      log.warn(`No Square credentials configured for location ${this.locationId}`);
      return null;
    } catch (err) {
      log.warn(`Error fetching credentials for location ${this.locationId}:`, err);
      return null;
    }
  }

  private async getSquareLocationId(): Promise<string> {
    try {
      const creds = await storage.getLocationSquareConfig(this.locationId);
      if (creds?.locationId && creds.locationId.trim().length > 0) {
        return creds.locationId.trim();
      }
    } catch {
      // no-op
    }
    return '';
  }

  async getProviderLocationId(): Promise<string> {
    return this.getSquareLocationId();
  }

  /**
   * Test-only: clear the per-process bootstrap cache so unit tests
   * can verify the lazy-bootstrap path runs again.
   */
  static __clearDefinitionsBootstrapCacheForTests(): void {
    clearDefinitionsBootstrapCacheForTests();
  }

  processPayment(
    sourceId: string,
    amount: number,
    storeCard?: boolean,
    customerId?: string,
    buyerEmail?: string,
    idempotencyKey?: PaymentIdempotencyInput,
  ): Promise<PaymentResult> {
    return processPayment(
      this.ctx,
      sourceId,
      amount,
      storeCard,
      customerId,
      buyerEmail,
      idempotencyKey,
    );
  }

  createOrderWithPayment(
    sourceId: string,
    amount: number,
    lineItems: OrderLineItem[],
    storeCard?: boolean,
    customerId?: string,
    buyerEmail?: string,
    idempotencyKey?: PaymentIdempotencyInput,
  ): Promise<PaymentResult> {
    return createOrderWithPayment(
      this.ctx,
      sourceId,
      amount,
      lineItems,
      storeCard,
      customerId,
      buyerEmail,
      idempotencyKey,
    );
  }

  refundPayment(
    paymentId: string,
    amountInCents: number,
    reason?: string,
    idempotencyKey?: string,
  ): Promise<RefundResult> {
    return refundPayment(this.ctx, paymentId, amountInCents, reason, idempotencyKey);
  }

  getRefund(refundId: string): Promise<RefundResult> {
    return getRefund(this.ctx, refundId);
  }

  saveCardOnFile(sourceId: string, customerId: string, idempotencyKey?: string): Promise<SavedCard | null> {
    return saveCardOnFile(this.ctx, sourceId, customerId, idempotencyKey);
  }

  listCardsOnFile(customerId: string): Promise<SavedCard[]> {
    return listCardsOnFile(this.ctx, customerId);
  }

  hasCardOnFile(customerId: string, cardId: string): Promise<boolean> {
    return hasCardOnFile(this.ctx, customerId, cardId);
  }

  disableCard(cardId: string, customerId: string): Promise<void> {
    return disableCard(this.ctx, cardId, customerId);
  }

  createOrUpdateCustomer(
    name: string,
    email: string,
    phone?: string | null,
    referenceId?: string | null,
  ): Promise<PaymentCustomer | null> {
    return createOrUpdateCustomer(this.ctx, name, email, phone, referenceId);
  }

  ensureCustomAttributeDefinitions(): Promise<boolean> {
    return ensureCustomAttributeDefinitions(this.ctx);
  }

  syncCustomerLeagueAttributes(
    customerId: string,
    bowlerId: number,
    attributes: { leagueName: string; leagueSeason: string },
  ): Promise<{ ok: boolean }> {
    return syncCustomerLeagueAttributes(this.ctx, customerId, bowlerId, attributes);
  }

  repairCustomerAttributeDefinitions(): Promise<Record<string, boolean>> {
    return repairCustomerAttributeDefinitions(this.ctx);
  }

  deleteCustomer(customerId: string): Promise<void> {
    return deleteCustomer(this.ctx, customerId);
  }

  getPayment(paymentId: string): Promise<PaymentVerification | null> {
    return getPayment(this.ctx, paymentId);
  }

  validateCardId(cardId: string | null): boolean {
    return validateCardId(cardId);
  }

  listCatalogCategories(): Promise<{ categories: CatalogCategory[]; truncated: boolean }> {
    return listCatalogCategories(this.ctx);
  }

  listCatalogItems(categoryId?: string): Promise<{ items: CatalogItem[]; truncated: boolean }> {
    return listCatalogItems(this.ctx, categoryId);
  }

  registerApplePayDomain(domain: string): Promise<{ success: boolean; message: string }> {
    return registerApplePayDomain(this.ctx, domain);
  }
}
