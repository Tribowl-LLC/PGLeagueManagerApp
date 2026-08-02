import type { CreatePaymentRequest } from 'square';
import { createLogger } from '../logger';
import {
  ProviderNotConfiguredError,
  PaymentProviderError,
  sanitizeProviderErrorCode,
  type PaymentProviderFailureDisposition,
} from './payment-errors';
import { getSquareErrorCtor, type SquareProviderContext } from './square-client';
import type {
  PaymentResult,
  RefundResult,
  PaymentVerification,
  OrderLineItem,
  PaymentIdempotencyInput,
} from './payment-provider';

const log = createLogger("SquareService");
const SQUARE_IDEMPOTENCY_KEY_MAX_LENGTH = 45;
const HARD_CARD_CODES = new Set([
  'ADDRESS_VERIFICATION_FAILURE',
  'ALLOWABLE_PIN_TRIES_EXCEEDED',
  'BAD_EXPIRATION',
  'CARD_DECLINED',
  'CARD_DECLINED_CALL_ISSUER',
  'CARD_DECLINED_VERIFICATION_REQUIRED',
  'CARD_EXPIRED',
  'CARDHOLDER_INSUFFICIENT_PERMISSIONS',
  'CARD_NOT_SUPPORTED',
  'CVV_FAILURE',
  'EXPIRATION_FAILURE',
  'GENERIC_DECLINE',
  'INSUFFICIENT_FUNDS',
  'INVALID_ACCOUNT',
  'INVALID_CARD',
  'INVALID_CARD_DATA',
  'INVALID_EXPIRATION',
  'INVALID_EXPIRATION_DATE',
  'INVALID_EXPIRATION_YEAR',
  'INVALID_PIN',
  'INVALID_POSTAL_CODE',
  'MANUALLY_ENTERED_PAYMENT_NOT_SUPPORTED',
  'PAN_FAILURE',
  'PAYMENT_LIMIT_EXCEEDED',
  'TRANSACTION_LIMIT',
  'VERIFY_CVV_FAILURE',
  'VERIFY_AVS_FAILURE',
  'VOICE_FAILURE',
]);
const CONFIGURATION_CODES = new Set([
  'CARD_PROCESSING_NOT_ENABLED',
  'INSUFFICIENT_PERMISSIONS',
  'INVALID_LOCATION',
  'PAYMENT_SOURCE_NOT_ENABLED_FOR_TARGET',
]);
const DEFINITE_TRANSIENT_CODES = new Set(['TEMPORARY_ERROR']);

function assertSquareIdempotencyKey(value: string, label: string): string {
  if (value.length === 0 || value.length > SQUARE_IDEMPOTENCY_KEY_MAX_LENGTH || value.trim() !== value) {
    throw new PaymentProviderError(
      `${label} idempotency key is invalid`,
      'INVALID_IDEMPOTENCY_KEY',
      undefined,
      { disposition: 'invalid_request' },
    );
  }
  return value;
}

function paymentIdentity(input: PaymentIdempotencyInput | undefined): {
  paymentKey: string;
  orderKey?: string;
  providerLocationId?: string;
} {
  if (typeof input === 'object') {
    return {
      paymentKey: assertSquareIdempotencyKey(input.paymentKey, 'Payment'),
      orderKey: input.orderKey === undefined
        ? undefined
        : assertSquareIdempotencyKey(input.orderKey, 'Order'),
      providerLocationId: input.providerLocationId,
    };
  }
  return {
    paymentKey: input === undefined
      ? `${Date.now()}-${Math.random()}`
      : assertSquareIdempotencyKey(input, 'Payment'),
  };
}

function classifySquareFailure(error: unknown): {
  detail?: string;
  disposition: PaymentProviderFailureDisposition;
  providerCode: string;
  statusCode?: number;
} {
  const apiErr = error instanceof getSquareErrorCtor() ? error : null;
  const statusCode = apiErr?.statusCode;
  const detail = apiErr?.errors?.[0]?.detail;
  const providerCode = sanitizeProviderErrorCode(apiErr?.errors?.[0]?.code, 'SQUARE_TRANSPORT_UNKNOWN');
  if (statusCode === 401 || statusCode === 403) {
    return { detail, disposition: 'configuration', providerCode, statusCode };
  }
  if (statusCode === 429 || DEFINITE_TRANSIENT_CODES.has(providerCode)) {
    return { detail, disposition: 'transient', providerCode, statusCode };
  }
  if (statusCode === 402 || HARD_CARD_CODES.has(providerCode)) {
    return { detail, disposition: 'action_required', providerCode, statusCode };
  }
  if (CONFIGURATION_CODES.has(providerCode)) {
    return { detail, disposition: 'configuration', providerCode, statusCode };
  }
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    return { detail, disposition: 'invalid_request', providerCode, statusCode };
  }
  // A transport exception, timeout, or provider 5xx after dispatch may have
  // accepted the POST. Scheduled-operation callers must reconcile it with the
  // same immutable request instead of guessing that it failed.
  return { detail, disposition: 'provider_unknown', providerCode, statusCode };
}

export async function processPayment(
  ctx: SquareProviderContext,
  sourceId: string,
  amount: number,
  storeCard?: boolean,
  customerId?: string,
  buyerEmail?: string,
  idempotencyKey?: PaymentIdempotencyInput,
): Promise<PaymentResult> {
  const client = await ctx.getClient();
  if (!client) {
    // Surface the structured "not configured" signal so the
    // /api/payments-provider/payments route maps it to 422
    // PROVIDER_NOT_CONFIGURED instead of 500. See task #332.
    throw new ProviderNotConfiguredError(
      'Square client not configured for this location',
      ctx.locationId,
    );
  }

  try {
    if (!sourceId || !amount) {
      throw new PaymentProviderError(
        'Missing required payment information',
        'INVALID_REQUEST',
        undefined,
        { disposition: 'invalid_request' },
      );
    }

    if (amount <= 0 || !Number.isInteger(amount)) {
      throw new PaymentProviderError(
        'Invalid payment amount',
        'INVALID_AMOUNT',
        undefined,
        { disposition: 'invalid_request' },
      );
    }

    const identity = paymentIdentity(idempotencyKey);
    const paymentRequest: CreatePaymentRequest = {
      sourceId,
      idempotencyKey: identity.paymentKey,
      amountMoney: {
        amount: BigInt(amount),
        currency: 'USD'
      },
      autocomplete: true
    };

    if (identity.providerLocationId) {
      paymentRequest.locationId = identity.providerLocationId;
    }

    if (customerId) {
      paymentRequest.customerId = customerId;
    }

    if (buyerEmail) {
      paymentRequest.buyerEmailAddress = buyerEmail;
    }

    const response = await client.payments.create(paymentRequest);

    if (!response?.payment) {
      throw new PaymentProviderError(
        'Unable to process payment',
        'INVALID_RESPONSE',
        undefined,
        { disposition: 'provider_unknown', providerCode: 'INVALID_RESPONSE' },
      );
    }

    const payment = response.payment;
    const cardDetails = payment.cardDetails?.card;

    return {
      id: payment.id,
      status: payment.status,
      card: {
        last4: cardDetails?.last4 ?? '****',
        brand: cardDetails?.cardBrand ?? 'UNKNOWN'
      },
      // capture Square's hosted-receipt URL + short
      // receipt number off the CreatePayment response so the
      // route can persist them on the payments row.
      receiptUrl: payment.receiptUrl,
      receiptNumber: payment.receiptNumber,
    };
  } catch (error) {
    // PaymentProviderError throws above (or ProviderNotConfiguredError
    // from getSquareClient) are already user-safe — re-throw them
    // verbatim so the route's catch sees the original code/message
    // rather than the generic PAYMENT_FAILED below.
    if (
      error instanceof PaymentProviderError ||
      error instanceof ProviderNotConfiguredError
    ) {
      throw error;
    }
    // v40+ flat-client SDK exposes structured errors directly on the
    // SquareError instance (`.errors[]`, `.statusCode`, `.body`); the
    // legacy `.result.errors[]` wrapper is gone. We capture the first
    // `detail` for server-side logs only — never forwarded to the user.
    const failure = classifySquareFailure(error);
    // Preserve the established interactive API mapping by HTTP status. The
    // richer `disposition` metadata is additive for the future ledger worker.
    if (failure.statusCode === 400) {
      throw new PaymentProviderError(
        'Invalid payment information. Please check your card details.',
        'INVALID_REQUEST',
        failure.detail,
        failure,
      );
    }
    if (failure.statusCode === 401) {
      throw new PaymentProviderError(
        'Payment system is temporarily unavailable. Please try again later.',
        'SYSTEM_ERROR',
        failure.detail,
        failure,
      );
    }
    if (failure.statusCode === 402) {
      throw new PaymentProviderError(
        'Your payment was declined. Please try a different card.',
        'PAYMENT_DECLINED',
        failure.detail,
        failure,
      );
    }
    throw new PaymentProviderError(
      'Unable to process your payment. Please try again later.',
      // Keep the existing interactive-route API contract. The durable
      // scheduled executor will branch on `disposition`, not this legacy
      // user-facing code.
      'PAYMENT_FAILED',
      failure.detail,
      failure,
    );
  }
}

export async function createOrderWithPayment(
  ctx: SquareProviderContext,
  sourceId: string,
  amount: number,
  lineItems: OrderLineItem[],
  storeCard?: boolean,
  customerId?: string,
  buyerEmail?: string,
  idempotencyKey?: PaymentIdempotencyInput,
): Promise<PaymentResult> {
  const [client, squareLocationId] = await Promise.all([
    ctx.getClient(),
    ctx.getLocationId(),
  ]);

  if (!client) {
    // Same structured "not configured" contract as processPayment.
    throw new ProviderNotConfiguredError(
      'Square client not configured for this location',
      ctx.locationId,
    );
  }

  const identity = paymentIdentity(idempotencyKey);
  const immutableLocationId = identity.providerLocationId ?? squareLocationId;
  if (!immutableLocationId) {
    throw new PaymentProviderError(
      'Square location not configured for this location',
      'CONFIGURATION_ERROR',
      undefined,
      { disposition: 'configuration' },
    );
  }

  let providerOrderId: string | undefined;
  try {
    const locationId = immutableLocationId;
    const orderKey = typeof idempotencyKey === 'object'
      ? identity.orderKey
      : idempotencyKey
        ? assertSquareIdempotencyKey(`${idempotencyKey}-order`, 'Order')
        : `order-${Date.now()}-${Math.random()}`;
    if (!orderKey) {
      throw new PaymentProviderError(
        'Order idempotency key is required',
        'INVALID_IDEMPOTENCY_KEY',
        undefined,
        { disposition: 'invalid_request' },
      );
    }
    const orderResponse = await client.orders.create({
      order: {
        locationId,
        lineItems,
      },
      idempotencyKey: orderKey,
    });

    const order = orderResponse.order;
    if (!order?.id) {
      throw new PaymentProviderError(
        'Payment processing failed. Please try again.',
        'PAYMENT_FAILED',
        undefined,
        { disposition: 'provider_unknown', providerCode: 'INVALID_ORDER_RESPONSE' },
      );
    }
    providerOrderId = order.id;

    log.info('Order created:', order.id);

    const paymentRequest: CreatePaymentRequest = {
      sourceId,
      idempotencyKey: typeof idempotencyKey === 'object'
        ? identity.paymentKey
        : idempotencyKey
          ? assertSquareIdempotencyKey(`${idempotencyKey}-pay`, 'Payment')
          : `pay-${Date.now()}-${Math.random()}`,
      amountMoney: {
        amount: BigInt(amount),
        currency: 'USD',
      },
      orderId: order.id,
      locationId,
      autocomplete: true,
    };

    if (customerId) {
      paymentRequest.customerId = customerId;
    }

    if (buyerEmail) {
      paymentRequest.buyerEmailAddress = buyerEmail;
    }

    const paymentResponse = await client.payments.create(paymentRequest);

    if (!paymentResponse?.payment) {
      throw new PaymentProviderError(
        'Unable to process payment',
        'INVALID_RESPONSE',
        undefined,
        { disposition: 'provider_unknown', providerCode: 'INVALID_RESPONSE', providerOrderId },
      );
    }

    const payment = paymentResponse.payment;
    const cardDetails = payment.cardDetails?.card;

    return {
      id: payment.id,
      status: payment.status,
      orderId: order.id,
      card: {
        last4: cardDetails?.last4 ?? '****',
        brand: cardDetails?.cardBrand ?? 'UNKNOWN',
      },
      // same hosted-receipt capture as processPayment.
      receiptUrl: payment.receiptUrl,
      receiptNumber: payment.receiptNumber,
    };
  } catch (error) {
    log.error('Order+Payment failed', {
      name: error instanceof Error ? error.name : 'UnknownError',
      code: error instanceof PaymentProviderError ? error.code : undefined,
      disposition: error instanceof PaymentProviderError ? error.disposition : undefined,
      hasProviderOrderId: providerOrderId !== undefined,
    });
    // Re-throw already-typed errors verbatim so the route's catch
    // sees the original `userMessage`/`code` we set above (or the
    // PNCE from getSquareClient/getSquareLocationId).
    if (error instanceof PaymentProviderError) {
      if (!providerOrderId || error.providerOrderId === providerOrderId) throw error;
      throw new PaymentProviderError(error.userMessage, error.code, error.detail, {
        disposition: error.disposition,
        providerCode: error.providerCode,
        providerOrderId,
      });
    }
    if (error instanceof ProviderNotConfiguredError) {
      throw error;
    }
    const failure = classifySquareFailure(error);
    const metadata = { ...failure, providerOrderId };
    // Preserve the established interactive API mapping by HTTP status. The
    // future ledger worker consumes `metadata.disposition` directly.
    if (failure.statusCode === 402) {
      throw new PaymentProviderError(
        'Your payment was declined. Please try a different card.',
        'PAYMENT_DECLINED',
        failure.detail,
        metadata,
      );
    }
    if (failure.statusCode === 401) {
      // Same mapping as processPayment above: a Square auth failure
      // (revoked / expired access token, wrong app id, etc.) is a
      // server-side credential problem the admin can't action with
      // a card retry — surface SYSTEM_ERROR so the toast tells them
      // it's a temporary infra issue rather than a declined card.
      // Pinned by tests/unit/square-charge-failures.test.ts (#619).
      throw new PaymentProviderError(
        'Payment system is temporarily unavailable. Please try again later.',
        'SYSTEM_ERROR',
        failure.detail,
        metadata,
      );
    }
    if (failure.statusCode === 400) {
      // Raw `detail` is captured for logs only — the user gets the
      // hand-authored sentence regardless of what Square returned.
      throw new PaymentProviderError(
        'Payment could not be processed. Please check your details and try again.',
        'INVALID_REQUEST',
        failure.detail,
        metadata,
      );
    }
    throw new PaymentProviderError(
      'Payment processing failed. Please try again.',
      'PAYMENT_FAILED',
      failure.detail,
      metadata,
    );
  }
}

export async function refundPayment(
  ctx: SquareProviderContext,
  paymentId: string,
  amountInCents: number,
  reason?: string,
): Promise<RefundResult> {
  const client = await ctx.getClient();
  if (!client) {
    // /api/payments/:id/refund maps this to 422 PROVIDER_NOT_CONFIGURED
    // so admins can tell "Square isn't connected for this location"
    // apart from "Square rejected the refund". See task #332.
    throw new ProviderNotConfiguredError(
      'Square client not configured for this location',
      ctx.locationId,
    );
  }

  try {
    const idempotencyKey = `refund-${paymentId}-${Date.now()}`;

    const response = await client.refunds.refundPayment({
      idempotencyKey,
      paymentId,
      amountMoney: {
        amount: BigInt(amountInCents),
        currency: 'USD',
      },
      reason: reason || 'Refund processed via LeagueVault',
    });

    const refund = response.refund;
    if (!refund || !refund.id) {
      throw new Error('Refund response missing refund data');
    }

    log.info(`Refund processed: ${refund.id}, status: ${refund.status}`);
    return {
      refundId: refund.id,
      status: refund.status || 'PENDING',
    };
  } catch (error) {
    log.error('Refund error:', error);
    // Re-throw already-typed errors verbatim so the route's catch
    // sees the original `userMessage`/`code` (and the PNCE from
    // getSquareClient never gets re-wrapped into REFUND_FAILED).
    if (
      error instanceof PaymentProviderError ||
      error instanceof ProviderNotConfiguredError
    ) {
      throw error;
    }

    // Parity with processPayment / createOrderWithPayment above: collapse any Square
    // SDK error shape into a typed PaymentProviderError so the refund
    // route can show admins the actionable reason (declined card,
    // validation error, system error) instead of a generic wall.
    // v40+ flat-client SDK exposes structured errors directly on the
    // SquareError instance (`.errors[]`, `.statusCode`); the legacy
    // `.result.errors[]` wrapper is gone. Raw Square `detail` is
    // captured for logs only — never forwarded as the user-facing
    // `userMessage` (task #514).
    const apiErr = error instanceof getSquareErrorCtor() ? error : null;
    const detail = apiErr?.errors?.[0]?.detail;
    if (apiErr?.statusCode === 401 || apiErr?.statusCode === 403) {
      throw new PaymentProviderError(
        'Payment system is temporarily unavailable. Please try again later.',
        'SYSTEM_ERROR',
        detail,
      );
    }
    if (apiErr?.statusCode === 402) {
      throw new PaymentProviderError(
        'Your payment was declined. Please try a different card.',
        'PAYMENT_DECLINED',
        detail,
      );
    }
    if (typeof apiErr?.statusCode === 'number' && apiErr.statusCode >= 400 && apiErr.statusCode < 500) {
      throw new PaymentProviderError(
        'Invalid payment information. Please check your card details.',
        'INVALID_REQUEST',
        detail,
      );
    }
    throw new PaymentProviderError(
      'Refund could not be processed.',
      'REFUND_FAILED',
      detail,
    );
  }
}

export async function getPayment(
  ctx: SquareProviderContext,
  paymentId: string,
): Promise<PaymentVerification | null> {
  const client = await ctx.getClient();
  if (!client) {
    // Intentionally degraded: GET /payments/:id/verify is a
    // diagnostic read used by the admin reconciliation UI. It
    // wraps the call in a try/catch that already turns PNCE
    // (from the factory) and any thrown verification error
    // into a "providerPayment: null" response. Returning null
    // here keeps that contract stable. Task #332.
    log.warn('Cannot verify payment — no Square client for location:', ctx.locationId);
    return null;
  }

  try {
    const response = await client.payments.get({ paymentId });
    const payment = response.payment;
    if (!payment) return null;

    return {
      id: payment.id!,
      status: payment.status || 'UNKNOWN',
      amountMoney: {
        amount: String(payment.amountMoney?.amount ?? 0),
        currency: payment.amountMoney?.currency || 'USD',
      },
      createdAt: payment.createdAt || '',
      updatedAt: payment.updatedAt || '',
      sourceType: payment.sourceType || 'UNKNOWN',
      cardBrand: payment.cardDetails?.card?.cardBrand,
      last4: payment.cardDetails?.card?.last4,
      orderId: payment.orderId,
      // surface receipt fields off GetPayment so the
      // "View receipt" route can lazily backfill an older row.
      receiptUrl: payment.receiptUrl,
      receiptNumber: payment.receiptNumber,
    };
  } catch (error) {
    log.error('Failed to retrieve Square payment:', paymentId, error instanceof Error ? error.message : error);
    return null;
  }
}
