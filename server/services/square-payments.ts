import type { CreatePaymentRequest } from 'square';
import { createLogger } from '../logger';
import {
  ProviderNotConfiguredError,
  PaymentProviderError,
} from './payment-errors';
import { getSquareErrorCtor, type SquareProviderContext } from './square-client';
import type {
  PaymentResult,
  RefundResult,
  PaymentVerification,
  OrderLineItem,
} from './payment-provider';

const log = createLogger("SquareService");

export async function processPayment(
  ctx: SquareProviderContext,
  sourceId: string,
  amount: number,
  storeCard?: boolean,
  customerId?: string,
  buyerEmail?: string,
  idempotencyKey?: string,
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
      );
    }

    if (amount <= 0 || !Number.isInteger(amount)) {
      throw new PaymentProviderError(
        'Invalid payment amount',
        'INVALID_AMOUNT',
      );
    }

    const paymentRequest: CreatePaymentRequest = {
      sourceId,
      idempotencyKey: idempotencyKey || `${Date.now()}-${Math.random()}`,
      amountMoney: {
        amount: BigInt(amount),
        currency: 'USD'
      },
      autocomplete: true
    };

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
    const apiErr = error instanceof getSquareErrorCtor() ? error : null;
    const detail = apiErr?.errors?.[0]?.detail;
    if (apiErr?.statusCode === 400) {
      throw new PaymentProviderError(
        'Invalid payment information. Please check your card details.',
        'INVALID_REQUEST',
        detail,
      );
    }
    if (apiErr?.statusCode === 401) {
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
    throw new PaymentProviderError(
      'Unable to process your payment. Please try again later.',
      'PAYMENT_FAILED',
      detail,
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
  idempotencyKey?: string,
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

  if (!squareLocationId) {
    throw new PaymentProviderError(
      'Square location not configured for this location',
      'CONFIGURATION_ERROR',
    );
  }

  try {
    const locationId = squareLocationId;
    const orderResponse = await client.orders.create({
      order: {
        locationId,
        lineItems,
      },
      idempotencyKey: idempotencyKey ? `${idempotencyKey}-order` : `order-${Date.now()}-${Math.random()}`,
    });

    const order = orderResponse.order;
    if (!order?.id) {
      throw new Error('Failed to create order');
    }

    log.info('Order created:', order.id);

    const paymentRequest: CreatePaymentRequest = {
      sourceId,
      idempotencyKey: idempotencyKey ? `${idempotencyKey}-pay` : `pay-${Date.now()}-${Math.random()}`,
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
    log.error('Order+Payment error:', error);
    // Re-throw already-typed errors verbatim so the route's catch
    // sees the original `userMessage`/`code` we set above (or the
    // PNCE from getSquareClient/getSquareLocationId).
    if (
      error instanceof PaymentProviderError ||
      error instanceof ProviderNotConfiguredError
    ) {
      throw error;
    }
    const apiErr = error instanceof getSquareErrorCtor() ? error : null;
    const detail = apiErr?.errors?.[0]?.detail;
    if (apiErr?.statusCode === 402) {
      throw new PaymentProviderError(
        'Your payment was declined. Please try a different card.',
        'PAYMENT_DECLINED',
        detail,
      );
    }
    if (apiErr?.statusCode === 401) {
      // Same mapping as processPayment above: a Square auth failure
      // (revoked / expired access token, wrong app id, etc.) is a
      // server-side credential problem the admin can't action with
      // a card retry — surface SYSTEM_ERROR so the toast tells them
      // it's a temporary infra issue rather than a declined card.
      // Pinned by tests/unit/square-charge-failures.test.ts (#619).
      throw new PaymentProviderError(
        'Payment system is temporarily unavailable. Please try again later.',
        'SYSTEM_ERROR',
        detail,
      );
    }
    if (apiErr?.statusCode === 400) {
      // Raw `detail` is captured for logs only — the user gets the
      // hand-authored sentence regardless of what Square returned.
      throw new PaymentProviderError(
        'Payment could not be processed. Please check your details and try again.',
        'INVALID_REQUEST',
        detail,
      );
    }
    throw new PaymentProviderError(
      'Payment processing failed. Please try again.',
      'PAYMENT_FAILED',
      detail,
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
