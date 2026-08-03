export interface PaymentResult {
  id?: string;
  status?: string;
  orderId?: string;
  card?: {
    last4: string;
    brand: string;
  };
  providerRef?: Record<string, string>;
  // Square hosted-receipt fields.
  receiptUrl?: string;
  receiptNumber?: string;
}

export interface RefundResult {
  refundId: string;
  status: string;
}

export interface SavedCard {
  id: string;
  last4: string;
  brand: string;
  expMonth?: number;
  expYear?: number;
}

export interface PaymentCustomer {
  id: string;
  name: string;
  email: string;
}

export interface PaymentVerification {
  id: string;
  status: string;
  amountMoney: { amount: string; currency: string };
  createdAt: string;
  updatedAt: string;
  sourceType: string;
  cardBrand?: string;
  last4?: string;
  orderId?: string;
  // Square hosted-receipt fields; populated by GetPayment for backfill.
  receiptUrl?: string;
  receiptNumber?: string;
}

export interface OrderLineItem {
  catalogObjectId: string;
  quantity: string;
}

export interface PaymentRequestIdentity {
  paymentKey: string;
  orderKey?: string;
  providerLocationId?: string;
}

export type PaymentIdempotencyInput = string | PaymentRequestIdentity;

export interface CatalogCategory {
  id: string;
  name: string;
}

export interface CatalogItem {
  id: string;
  name: string;
  description: string;
  variations: {
    id: string;
    name: string;
    price: number | null;
    currency: string;
  }[];
}

export interface PaymentProvider {
  readonly providerName: string;
  /**
   * The location whose credentials this provider instance was
   * resolved from. Exposed so callers that persist provider-derived
   * state on a row (e.g. `bowlers.paymentProviderLocationId`, see
   * task #346) can record which location's processor created the
   * record without a second DB lookup.
   */
  readonly locationId: number;

  processPayment(
    sourceId: string,
    amount: number,
    storeCard?: boolean,
    customerId?: string,
    buyerEmail?: string,
    idempotencyKey?: PaymentIdempotencyInput,
  ): Promise<PaymentResult>;

  createOrderWithPayment(
    sourceId: string,
    amount: number,
    lineItems: OrderLineItem[],
    storeCard?: boolean,
    customerId?: string,
    buyerEmail?: string,
    idempotencyKey?: PaymentIdempotencyInput,
  ): Promise<PaymentResult>;

  refundPayment(
    paymentId: string,
    amountInCents: number,
    reason?: string,
  ): Promise<RefundResult>;

  saveCardOnFile(
    sourceId: string,
    customerId: string,
    idempotencyKey?: string,
  ): Promise<SavedCard | null>;

  listCardsOnFile(
    customerId: string,
  ): Promise<SavedCard[]>;

  disableCard(
    cardId: string,
    customerId: string,
  ): Promise<void>;

  createOrUpdateCustomer(
    name: string,
    email: string,
    phone?: string | null,
    /**
     * Optional external reference for the customer record on the
     * processor side. Square stores this as the `referenceId` field
     * on the customer profile and exposes it in the dashboard so
     * sellers can look up "who is this in my source system" without
     * leaving Square. Task #429 sets this to `bowler:<id>` so admins
     * can drill from a Square Smart List back into LeagueVault. Other
     * processors that don't surface a referenceId may ignore it.
     */
    referenceId?: string | null,
  ): Promise<PaymentCustomer | null>;

  getPayment(
    paymentId: string,
  ): Promise<PaymentVerification | null>;

  validateCardId(cardId: string | null): boolean;
}

/**
 * Optional capability: catalog operations (e.g., Square catalog items/categories).
 * Split from PaymentProvider because not all processors support catalog management.
 * Use hasCatalogSupport() type guard to check at runtime.
 */
export interface CatalogProvider {
  /**
   * Returns categories alongside a `truncated` flag indicating whether
   * the underlying pagination cap (Task #613) fired before the cursor
   * was exhausted. Callers (e.g. the catalog API route) forward the
   * flag to the admin UI so admins know the visible list is incomplete
   * (Task #623). `truncated` is always `false` when no provider is
   * configured or when the cursor finished naturally.
   */
  listCatalogCategories(): Promise<{ categories: CatalogCategory[]; truncated: boolean }>;
  /**
   * Returns items alongside a `truncated` flag with the same contract
   * as `listCatalogCategories` above (Task #623).
   */
  listCatalogItems(categoryId?: string): Promise<{ items: CatalogItem[]; truncated: boolean }>;
}

/**
 * Optional capability: digital wallet operations (e.g., Apple Pay domain registration).
 * Split from PaymentProvider because not all processors support wallet payments.
 * Use hasWalletSupport() type guard to check at runtime.
 */
export interface WalletProvider {
  registerApplePayDomain(domain: string): Promise<{ success: boolean; message: string }>;
}

/**
 * Optional capability: delete a previously-created customer record at
 * the payment processor. Used by the automated account-data deletion
 * flow (see server/services/account-deletion.ts) when an admin executes
 * a deletion request. Implementations should treat "customer not found"
 * as a successful no-op so retries are idempotent.
 */
export interface CustomerCleanupProvider {
  deleteCustomer(customerId: string): Promise<void>;
}

export function hasCatalogSupport(provider: PaymentProvider): provider is PaymentProvider & CatalogProvider {
  return 'listCatalogCategories' in provider && 'listCatalogItems' in provider;
}

export function hasWalletSupport(provider: PaymentProvider): provider is PaymentProvider & WalletProvider {
  return 'registerApplePayDomain' in provider;
}

export function hasCustomerCleanupSupport(
  provider: PaymentProvider,
): provider is PaymentProvider & CustomerCleanupProvider {
  return 'deleteCustomer' in provider;
}
