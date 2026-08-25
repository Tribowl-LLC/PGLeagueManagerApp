/**
 * Charge execution + verification for the payments-provider router.
 *
 * Routes:
 *  - POST /payments
 *  - GET  /payments/:paymentId/verify
 */
import { Router, type Request, type Response } from 'express';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { getEffectiveBowlingWeeks } from '@shared/schedule-utils';
import { DEFAULT_TIMEZONE, type InteractivePaymentSourceKind, type PaymentOperation } from '@shared/schema';
import { storage } from '../../storage';
import { sendError } from '../../utils/api.js';
import { hasAccessToLeague, hasAccessToBowler, hasAccessToPayment, isOrgOrHigher } from '../../utils/access-control.js';
import { canUserPayForBowler } from '../../utils/bowler-payment-authz.js';
import { paymentLimiter } from '../../middleware/rate-limit.js';
import { createLogger } from '../../logger';
import {
  getPaymentProvider,
  ProviderNotConfiguredError,
  PaymentProviderError,
  GENERIC_PAYMENT_USER_MESSAGE,
} from '../../services/payment-provider-factory';
import { buildPaymentErrorResponse } from '../../utils/payment-error-response.js';
import { computePaymentSplit, buildLineItems } from '../../services/payment-execution';
import { getProviderCustomerId, ensureProviderCustomer } from '../../services/payment-utils';
import { isDev } from '../../config';
import { getProviderForLeague } from './shared.js';
import {
  getGeneralInteractiveTargetKey,
  PaymentOperationImmutableMismatchError,
  PaymentOperationValidationError,
  getInteractiveCardSaveResponse,
} from '../../storage/payment-operations.js';
import {
  bindInteractiveOccurrenceRequestFingerprint,
  buildPaymentOperationIdentity,
  fingerprintInteractiveOccurrenceIntent,
  normalizeInteractiveOccurrenceSelections,
  validateInteractiveRequestKey,
} from '../../services/payment-operation-idempotency.js';
import { prepareInteractivePaymentOperation } from '../../services/interactive-payment-operation-preparation.js';
import { interactivePaymentOperationExecutor } from '../../services/interactive-payment-operation-executor.js';
import { notifyScheduledPaymentMutation } from '../../services/scheduled-payment-runtime.js';
import {
  getInteractiveOccurrenceActivation,
  InteractiveOccurrenceAllocationError,
  quoteInteractiveOccurrenceAllocations,
  validateInteractiveOccurrenceReplay,
  validateInteractiveOccurrenceBaseAllocations,
  type InteractiveOccurrenceSelection,
} from '../../services/interactive-occurrence-allocation.js';

const log = createLogger('Payments');

const router = Router();

/** PR1's provider charge path is exact-obligation-only. The older charge
 * endpoints infer a season/occurrence from amount and roster state, so they
 * must fail closed for a configured roster-driven league. */
async function rejectLegacyRosterCharge(req: Request, res: Response): Promise<boolean> {
  const leagueId = Number(req.body?.leagueId);
  if (!Number.isSafeInteger(leagueId) || leagueId <= 0) return false;
  const league = await storage.getLeague(leagueId);
  if (league?.organizationId !== null && league?.organizationId !== undefined) {
    sendError(res, 'Select exact payment obligations before charging this league', 409, 'CANONICAL_OBLIGATION_SELECTION_REQUIRED');
    return true;
  }
  return false;
}

function parseOccurrenceSelections(value: unknown): InteractiveOccurrenceSelection[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw new InteractiveOccurrenceAllocationError('INVALID_SELECTION');
  const selections: InteractiveOccurrenceSelection[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') throw new InteractiveOccurrenceAllocationError('INVALID_SELECTION');
    const row = raw as { obligationId?: unknown; amountMinor?: unknown };
    if (typeof row.obligationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.obligationId)
      || !Number.isSafeInteger(row.amountMinor) || Number(row.amountMinor) <= 0 || seen.has(row.obligationId)) {
      throw new InteractiveOccurrenceAllocationError('INVALID_SELECTION');
    }
    seen.add(row.obligationId);
    selections.push({ obligationId: row.obligationId, amountMinor: Number(row.amountMinor) });
  }
  return normalizeInteractiveOccurrenceSelections(selections);
}

function occurrenceAllocationRouteError(error: unknown): { message: string; code: string } | undefined {
  if (!(error instanceof InteractiveOccurrenceAllocationError)) return undefined;
  switch (error.code) {
    case 'IMMUTABLE_SELECTION_MISMATCH':
    case 'PRE_F2_OPERATION':
      return { message: 'This payment operation cannot be changed to use occurrence allocations.', code: 'OCCURRENCE_IDEMPOTENCY_CONFLICT' };
    case 'STALE_QUOTE':
      return { message: 'The payment allocation quote is stale. Refresh and select the obligations again.', code: 'OCCURRENCE_QUOTE_STALE' };
    case 'CANONICAL_EVIDENCE_INCOMPATIBLE':
      return { message: 'Payment allocation is unavailable for this league.', code: 'OCCURRENCE_ALLOCATION_CONFLICT' };
    default:
      return { message: 'Payment allocation could not be validated.', code: 'OCCURRENCE_ALLOCATION_CONFLICT' };
  }
}

export function validateInteractiveQuotePayees(
  quote: { rows: Array<{ obligationId: string; bowlerId: number }>; selections: InteractiveOccurrenceSelection[] },
  payees: Array<{ bowlerId: number; amount: number }>,
): void {
  validateInteractiveOccurrenceBaseAllocations(
    quote.selections.map((selection) => {
      const row = quote.rows.find((candidate) => candidate.obligationId === selection.obligationId);
      if (!row) throw new InteractiveOccurrenceAllocationError('INVALID_SELECTION');
      return { bowlerId: row.bowlerId, amountMinor: selection.amountMinor };
    }),
    payees.map((payee) => ({ bowlerId: payee.bowlerId, amountMinor: payee.amount })),
  );
}

function interactiveReplaySnapshotMatches(input: {
  snapshot: Awaited<ReturnType<typeof storage.getInteractivePaymentOperationSnapshotForOrganization>>;
  leagueId: number;
  sourceId: string;
  sourceKind: InteractivePaymentSourceKind;
  storeCard: boolean;
  buyerEmail: string | null;
  payerBowlerId: number;
  allocations: Array<{ bowlerId: number; amountMinor: number }>;
}): boolean {
  const snapshot = input.snapshot;
  if (!snapshot
    || snapshot.leagueId !== input.leagueId
    || snapshot.sourceKind !== input.sourceKind
    || snapshot.storeCard !== input.storeCard
    || snapshot.buyerEmail !== input.buyerEmail
    || snapshot.payerBowlerId !== input.payerBowlerId) {
    return false;
  }
  if (snapshot.sourceId !== input.sourceId || snapshot.allocations.length !== input.allocations.length) return false;
  if (snapshot.allocations.some((row, index) => row.allocationIndex !== index
    || row.bowlerId !== input.allocations[index]?.bowlerId
    || row.amountMinor !== input.allocations[index]?.amountMinor)) return false;
  return true;
}

function interactiveReplayRequestFingerprint(operation: PaymentOperation, selections: InteractiveOccurrenceSelection[] | undefined, quoteFingerprint: string | undefined): string {
  const base = buildPaymentOperationIdentity({
    organizationId: operation.organizationId,
    operationType: "interactive_charge",
    targetKey: operation.targetKey,
    amountMinor: operation.amountMinor,
    currency: operation.currency,
    providerName: operation.providerName,
  });
  const intent = selections !== undefined && quoteFingerprint
    ? fingerprintInteractiveOccurrenceIntent({ selections, quoteFingerprint })
    : undefined;
  return bindInteractiveOccurrenceRequestFingerprint(base.requestFingerprint, intent);
}

async function occurrenceQuote(req: Request, res: Response): Promise<void> {
  if (await rejectLegacyRosterCharge(req, res)) return;
  const leagueId = Number(req.body?.leagueId);
  const amountMinor = Number(req.body?.amountMinor ?? req.body?.amount);
  const explicitOrganizationId = Number(req.body?.organizationId);
  const organizationId = req.organizationFilter
    ?? (req.user?.role === 'system_admin' && Number.isSafeInteger(explicitOrganizationId) && explicitOrganizationId > 0
      ? explicitOrganizationId
      : req.user?.organizationId);
  if (!organizationId || !Number.isSafeInteger(leagueId) || leagueId <= 0 || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    sendError(res, 'Invalid payment quote request', 400, 'VALIDATION_ERROR');
    return;
  }
  if (!await hasAccessToLeague(req, leagueId)) {
    sendError(res, 'You do not have access to this league', 403, 'FORBIDDEN');
    return;
  }
  const league = await storage.getLeague(leagueId);
  if (!league || league.organizationId !== organizationId) {
    sendError(res, 'Payment quote is unavailable', 404, 'NOT_FOUND');
    return;
  }
  const requestedBowlers: number[] = Array.isArray(req.body?.payees)
    ? req.body.payees.map((row: { bowlerId?: unknown }) => Number(row?.bowlerId))
    : [Number(req.body?.bowlerId ?? req.body?.payerBowlerId)];
  if (requestedBowlers.length === 0 || requestedBowlers.some((id: number) => !Number.isSafeInteger(id) || id <= 0)) {
    sendError(res, 'A payment bowler is required for this quote', 400, 'VALIDATION_ERROR');
    return;
  }
  for (const bowlerId of [...new Set(requestedBowlers)]) {
    const authz = await canUserPayForBowler(req, bowlerId);
    const adminScoped = !!req.user && isOrgOrHigher(req.user) && await hasAccessToBowler(req, bowlerId);
    if (!authz.allowed && !adminScoped) {
      sendError(res, 'Payment quote is unavailable', 404, 'NOT_FOUND');
      return;
    }
  }
  try {
    if (!await getInteractiveOccurrenceActivation({ organizationId, leagueId })) {
      sendError(res, 'Occurrence allocation is unavailable for this league', 409, 'OCCURRENCE_ALLOCATION_UNAVAILABLE');
      return;
    }
    const selections = parseOccurrenceSelections(req.body?.occurrenceAllocations);
    const quote = await quoteInteractiveOccurrenceAllocations({ organizationId, leagueId, amountMinor, currency: 'USD', selections, allowedBowlerIds: [...new Set(requestedBowlers)] });
    res.json(quote);
  } catch (error) {
    if (error instanceof InteractiveOccurrenceAllocationError) {
      sendError(res, 'Payment allocation could not be validated', 409, 'OCCURRENCE_ALLOCATION_CONFLICT');
      return;
    }
    sendError(res, 'Payment quote is unavailable', 500, 'INTERNAL_ERROR');
  }
}

router.post('/payments/quote', paymentLimiter, occurrenceQuote);
router.post('/combined-payments/quote', paymentLimiter, occurrenceQuote);

type InteractiveChargeResponse = {
  status: 'COMPLETED';
  id: string;
  orderId?: string;
  dbPaymentId?: number;
  combinedChargeGroupId?: string;
  rows?: Array<{ id: number; bowlerId: number; amount: number }>;
  receiptUrl?: string | null;
  receiptNumber?: string | null;
  savedCardId?: string | null;
  cardSaveStatus?: 'not_requested' | 'saved' | 'failed' | 'not_available';
};

function requireInteractiveRequestKey(
  req: Request,
  res: Response,
): string | undefined {
  const raw = req.get('Idempotency-Key');
  if (raw === undefined) {
    sendError(
      res,
      'This payment app is out of date. Update it before submitting a payment.',
      428,
      'IDEMPOTENCY_KEY_REQUIRED',
      { upgradeRequired: true },
    );
    return undefined;
  }
  try {
    return validateInteractiveRequestKey(raw);
  } catch (error) {
    sendError(
      res,
      error instanceof Error ? error.message : 'Idempotency-Key is invalid',
      400,
      'INVALID_IDEMPOTENCY_KEY',
    );
    return undefined;
  }
}

function requireInteractiveSourceKind(
  req: Request,
  res: Response,
): InteractivePaymentSourceKind | undefined {
  const sourceKind = req.body?.sourceKind;
  if (sourceKind !== 'new_card' && sourceKind !== 'saved_card' && sourceKind !== 'wallet') {
    sendError(
      res,
      'This payment app is out of date. Update it before submitting a payment.',
      428,
      'PAYMENT_APP_UPGRADE_REQUIRED',
      { upgradeRequired: true },
    );
    return undefined;
  }
  if (req.body?.storeCard === true && sourceKind === 'wallet') {
    sendError(
      res,
      'Wallet payment methods cannot be saved for future payments.',
      400,
      'CARD_SAVE_UNSUPPORTED',
    );
    return undefined;
  }
  return sourceKind;
}

function leagueDayStart(league: { timezone?: string | null }, now = new Date()): string {
  const timezone = league.timezone ?? DEFAULT_TIMEZONE;
  const local = toZonedTime(now, timezone);
  local.setHours(0, 0, 0, 0);
  return fromZonedTime(local, timezone).toISOString();
}

function operationIsDue(operation: PaymentOperation, now = new Date()): boolean {
  return operation.status === 'pending'
    || (operation.nextAttemptAt !== null && new Date(operation.nextAttemptAt).getTime() <= now.getTime())
    || (
      operation.status === 'leased'
      && operation.leaseExpiresAt !== null
      && new Date(operation.leaseExpiresAt).getTime() <= now.getTime()
    );
}

function operationStatusResponse(operation: PaymentOperation): Record<string, unknown> {
  return {
    operationId: operation.id,
    status: operation.status,
    attemptCount: operation.attemptCount,
    retryAt: operation.nextAttemptAt,
    providerPaymentId: operation.providerObjectId,
    providerOrderId: operation.providerOrderId,
  };
}

async function reconstructInteractiveChargeResponse(
  organizationId: number,
  operation: PaymentOperation,
): Promise<InteractiveChargeResponse> {
  if (operation.status !== 'succeeded' || !operation.providerObjectId) {
    throw new Error('interactive payment operation is not successful');
  }
  const rows = await storage.getPaymentsByPaymentOperationId(organizationId, operation.id);
  const snapshot = await storage.getInteractivePaymentOperationSnapshotForOrganization(organizationId, operation.id);
  const first = rows[0];
  const cardSave = getInteractiveCardSaveResponse(operation);
  // v1 snapshots predate durable card-save state. They must never trigger a
  // replay of the old post-charge vault call; report the result as unavailable
  // rather than claiming that a card was saved.
  const legacyCardSave = snapshot?.storeCard && snapshot.sourceKind === 'legacy'
    ? { savedCardId: null, cardSaveStatus: 'not_available' as const }
    : cardSave;
  return {
    status: 'COMPLETED',
    id: operation.providerObjectId,
    ...(operation.providerOrderId ? { orderId: operation.providerOrderId } : {}),
    ...(first ? {
      dbPaymentId: first.id,
      receiptUrl: first.receiptUrl,
      receiptNumber: first.receiptNumber,
    } : {}),
    ...(first?.combinedChargeGroupId ? {
      combinedChargeGroupId: first.combinedChargeGroupId,
      rows: rows.map((row) => ({ id: row.id, bowlerId: row.bowlerId, amount: row.amount })),
    } : {}),
    savedCardId: legacyCardSave.savedCardId,
    cardSaveStatus: legacyCardSave.cardSaveStatus,
  };
}

async function canRecoverInteractiveOperation(req: Request, operation: PaymentOperation): Promise<boolean> {
  const user = req.user;
  if (!user) return false;
  if (user.role === 'system_admin') return true;
  if (user.role === 'org_admin' && user.organizationId === operation.organizationId) return true;
  if (operation.authorizingUserId !== null) return operation.authorizingUserId === user.id;
  const snapshot = await storage.getInteractivePaymentOperationSnapshotForOrganization(operation.organizationId, operation.id);
  if (!snapshot) return false;
  if (user.organizationId !== operation.organizationId) return false;
  if (snapshot.payerBowlerId === user.bowlerId) return true;
  return (await canUserPayForBowler(req, snapshot.payerBowlerId)).allowed;
}

function interactiveOrganizationScope(req: Request): number | undefined {
  if (req.organizationFilter != null) return req.organizationFilter;
  if (req.user?.role === 'system_admin') {
    const requested = Number(req.query.organizationId ?? req.body?.organizationId);
    return Number.isSafeInteger(requested) && requested > 0 ? requested : undefined;
  }
  return req.user?.organizationId ?? undefined;
}

function terminalOperationError(operation: PaymentOperation): {
  status: number;
  message: string;
  code: string;
} {
  if (operation.errorClassification === 'configuration') {
    return {
      status: 422,
      message: 'Payment provider is not configured for this location',
      code: 'PROVIDER_NOT_CONFIGURED',
    };
  }
  if (operation.errorClassification === 'hard_decline' || operation.status === 'action_required') {
    return { status: 500, message: 'Your payment was declined. Please try a different payment method.', code: 'PAYMENT_DECLINED' };
  }
  if (operation.errorClassification === 'invalid_request') {
    return { status: 400, message: 'The payment information is invalid. Please review it and try again.', code: 'INVALID_REQUEST' };
  }
  return { status: 500, message: GENERIC_PAYMENT_USER_MESSAGE, code: operation.errorCode ?? 'PAYMENT_ERROR' };
}

async function respondWithInteractiveOperation(
  res: Response,
  organizationId: number,
  operation: PaymentOperation,
  allowDueRecovery: boolean,
): Promise<void> {
  let current = operation;
  // Arm the durable one-shot wake before any provider call. This ordering
  // covers a worker crash or a hung provider after preparation commits.
  await notifyScheduledPaymentMutation();
  if (allowDueRecovery && operationIsDue(current)) {
    current = await interactivePaymentOperationExecutor.execute({
      organizationId,
      operationId: current.id,
    }) ?? current;
  }
  // The operation and its immutable snapshots are committed before this
  // response. Re-query the one-shot durable wake after every interactive
  // create/recovery transition so a pending/unknown operation cannot strand.
  await notifyScheduledPaymentMutation();
  if (current.status === 'succeeded') {
    const response = await reconstructInteractiveChargeResponse(organizationId, current);
    if (response.cardSaveStatus === 'saved' && response.savedCardId) {
      const snapshot = await storage.getInteractivePaymentOperationSnapshotForOrganization(organizationId, current.id);
      if (snapshot) {
        try {
          await storage.updatePaymentScheduleCard(
            snapshot.payerBowlerId,
            snapshot.leagueId,
            response.savedCardId,
          );
        } catch {
          // Card vaulting and payment success are durable. A one-time charge
          // may not have a schedule, and this optional update is retryable.
        }
      }
    }
    res.json(response);
    return;
  }
  if (current.status === 'action_required' || current.status === 'failed_terminal') {
    const failure = terminalOperationError(current);
    sendError(res, failure.message, failure.status, failure.code, operationStatusResponse(current));
    return;
  }
  // provider_unknown and reconciliation_required are deliberately reported as
  // unresolved. Neither is a confirmed payment failure.
  res.status(202).json({ success: true, ...operationStatusResponse(current) });
}

router.get('/payment-operations/status', async (req, res) => {
  try {
    const requestKey = requireInteractiveRequestKey(req, res);
    if (!requestKey) return;
    const organizationId = interactiveOrganizationScope(req);
    if (!organizationId) {
      return sendError(res, 'Organization context is required for payment recovery', 403, 'FORBIDDEN');
    }
    const operation = await storage.getGeneralInteractivePaymentOperationForOrganization(
      organizationId,
      requestKey,
    );
    if (!operation) return sendError(res, 'Payment operation not found', 404, 'NOT_FOUND');
    if (operation.targetKey !== getGeneralInteractiveTargetKey(requestKey)) {
      return sendError(res, 'Payment operation not found', 404, 'NOT_FOUND');
    }
    if (!await canRecoverInteractiveOperation(req, operation)) {
      return sendError(res, 'Payment operation not found', 404, 'NOT_FOUND');
    }
    if (operation.status === 'succeeded') {
      return res.json(await reconstructInteractiveChargeResponse(organizationId, operation));
    }
    if (operation.status === 'action_required' || operation.status === 'failed_terminal') {
      const failure = terminalOperationError(operation);
      return sendError(res, failure.message, failure.status, failure.code, operationStatusResponse(operation));
    }
    return res.status(202).json({ success: true, ...operationStatusResponse(operation) });
  } catch (error) {
    log.error('Interactive payment status lookup failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    return sendError(res, GENERIC_PAYMENT_USER_MESSAGE, 500, 'PAYMENT_ERROR');
  }
});

router.post('/payment-operations/recover', paymentLimiter, async (req, res) => {
  try {
    const requestKey = requireInteractiveRequestKey(req, res);
    if (!requestKey) return;
    const organizationId = interactiveOrganizationScope(req);
    if (!organizationId) {
      return sendError(res, 'Organization context is required for payment recovery', 403, 'FORBIDDEN');
    }
    const operation = await storage.getGeneralInteractivePaymentOperationForOrganization(
      organizationId,
      requestKey,
    );
    if (!operation) return sendError(res, 'Payment operation not found', 404, 'NOT_FOUND');
    if (!await canRecoverInteractiveOperation(req, operation)) {
      return sendError(res, 'Payment operation not found', 404, 'NOT_FOUND');
    }
    return respondWithInteractiveOperation(res, organizationId, operation, true);
  } catch (error) {
    log.error('Interactive payment recovery failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    return sendError(res, GENERIC_PAYMENT_USER_MESSAGE, 500, 'PAYMENT_ERROR');
  }
});

router.get('/payments/:paymentId/verify', async (req, res) => {
  try {
    const userRole = req.user?.role;
    if (userRole !== 'system_admin' && userRole !== 'org_admin') {
      return sendError(res, 'Admin access required', 403, 'FORBIDDEN');
    }

    const dbPayment = await storage.getPaymentById(parseInt(req.params.paymentId));
    if (!dbPayment) {
      return sendError(res, 'Payment not found', 404, 'NOT_FOUND');
    }

    if (userRole !== 'system_admin' && !await hasAccessToPayment(req, dbPayment.id)) {
      return sendError(res, 'Payment not found', 404, 'NOT_FOUND');
    }

    if (!dbPayment.providerPaymentId) {
      return res.json({
        dbPayment: { id: dbPayment.id, amount: dbPayment.amount, status: dbPayment.status, type: dbPayment.type, createdAt: dbPayment.createdAt },
        providerPayment: null,
        message: 'No payment ID associated with this payment (cash/check payment)',
      });
    }

    const provider = await getProviderForLeague(dbPayment.leagueId);
    let providerPayment = null;
    try {
      providerPayment = await provider.getPayment(dbPayment.providerPaymentId);
    } catch (e) {
      if (e instanceof ProviderNotConfiguredError) {
        log.warn('Payment verification: provider not configured', { leagueId: dbPayment.leagueId, paymentId: dbPayment.id });
      } else {
        throw e;
      }
    }

    if (isDev) log.info('Payment verification:', {
      dbPaymentId: dbPayment.id,
      providerPaymentId: dbPayment.providerPaymentId,
      providerFound: !!providerPayment,
      providerStatus: providerPayment?.status,
      dbStatus: dbPayment.status,
    });

    res.json({
      dbPayment: {
        id: dbPayment.id,
        amount: dbPayment.amount,
        status: dbPayment.status,
        type: dbPayment.type,
        providerPaymentId: dbPayment.providerPaymentId,
        createdAt: dbPayment.createdAt,
        bowlerId: dbPayment.bowlerId,
        leagueId: dbPayment.leagueId,
      },
      providerPayment: providerPayment,
      match: providerPayment ? {
        statusMatch: (dbPayment.status === 'paid' && providerPayment.status === 'COMPLETED') ||
                     (dbPayment.status !== 'paid' && providerPayment.status !== 'COMPLETED'),
        amountMatch: String(dbPayment.amount) === providerPayment.amountMoney.amount,
      } : null,
      message: providerPayment
        ? `Payment found: ${providerPayment.status}, $${(parseInt(providerPayment.amountMoney.amount) / 100).toFixed(2)}`
        : 'Payment NOT found — payment may have failed or been processed under different credentials',
    });
  } catch (error) {
    log.error('Payment verification error:', error);
    sendError(res, 'Failed to verify payment', 500);
  }
});

/**
 * Task #706 — Combined partner pay (one-time, all card modes).
 *
 * Accepts ONE provider charge for the full sum, then writes N
 * per-bowler payment rows (self + accepted-link partners) inside a
 * single DB transaction with a shared `combinedChargeGroupId`. Each
 * payee is independently authorized via canUserPayForBowler at
 * execution time so a since-revoked link can't keep being charged.
 *
 * Request body:
 *   {
 *     sourceId: string,                      // card token / saved card id / wallet token
 *     sourceKind: 'new_card' | 'saved_card' | 'wallet',
 *     leagueId: number,
 *     payees: [{ bowlerId: number, amount: number }, ...],   // sum must equal `amount`
 *     amount: number,                        // total charged
 *     storeCard?: boolean,
 *     buyerEmail?: string,
 *   }
 */
router.post('/combined-payments', paymentLimiter, async (req, res) => {
  try {
    if (await rejectLegacyRosterCharge(req, res)) return;
    const requestKey = requireInteractiveRequestKey(req, res);
    if (!requestKey) return;
    const sourceKind = requireInteractiveSourceKind(req, res);
    if (!sourceKind) return;
    const occurrenceSelections = parseOccurrenceSelections(req.body?.occurrenceAllocations);
    const occurrenceQuoteFingerprint = typeof req.body?.occurrenceQuoteFingerprint === 'string'
      ? req.body.occurrenceQuoteFingerprint : undefined;
    const { sourceId, amount, leagueId, payees } = req.body as {
      sourceId?: string;
      amount?: number;
      leagueId?: number;
      payees?: Array<{ bowlerId?: number; amount?: number }>;
      storeCard?: boolean;
      buyerEmail?: string;
    };

    if (!sourceId || !leagueId) {
      return sendError(res, 'Missing required payment fields', 400, 'VALIDATION_ERROR');
    }
    if (typeof amount !== 'number' || amount <= 0 || !Number.isInteger(amount)) {
      return sendError(res, 'Amount must be a positive integer', 400, 'VALIDATION_ERROR');
    }
    if (!Array.isArray(payees) || payees.length === 0) {
      return sendError(res, 'payees must be a non-empty array', 400, 'VALIDATION_ERROR');
    }
    if (payees.length > 25) {
      return sendError(res, 'Too many payees in a single combined charge', 400, 'VALIDATION_ERROR');
    }

    // Normalize + dedupe.
    const seen = new Set<number>();
    const cleanPayees: Array<{ bowlerId: number; amount: number }> = [];
    for (const p of payees) {
      const bowlerId = Number(p?.bowlerId);
      const payeeAmount = Number(p?.amount);
      if (!Number.isInteger(bowlerId) || bowlerId <= 0) {
        return sendError(res, 'Each payee must have a positive integer bowlerId', 400, 'VALIDATION_ERROR');
      }
      if (!Number.isInteger(payeeAmount) || payeeAmount <= 0) {
        return sendError(res, 'Each payee amount must be a positive integer', 400, 'VALIDATION_ERROR');
      }
      if (seen.has(bowlerId)) {
        return sendError(res, 'Duplicate bowlerId in payees', 400, 'VALIDATION_ERROR');
      }
      seen.add(bowlerId);
      cleanPayees.push({ bowlerId, amount: payeeAmount });
    }

    const summed = cleanPayees.reduce((s, p) => s + p.amount, 0);
    if (summed !== amount) {
      return sendError(
        res,
        `payees amount sum (${summed}) must equal total amount (${amount})`,
        400,
        'VALIDATION_ERROR',
      );
    }

    if (!await hasAccessToLeague(req, leagueId)) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }

    const league = await storage.getLeague(leagueId);
    if (!league) {
      return sendError(res, 'League not found', 404, 'NOT_FOUND');
    }
    if (league.organizationId == null) {
      return sendError(res, 'League is not assigned to an organization', 400, 'LEAGUE_NOT_CONFIGURED');
    }
    let canonicalOccurrenceActive: boolean;
    // Look up the exact operation before current roster/link authorization.
    // Once an intent was accepted, a later partner/roster revocation must not
    // strand a provider-unknown or pending operation; canRecoverInteractiveOperation
    // still enforces the immutable authorizing actor/admin boundary.
    const existingOperationBeforeAuthorization = await storage.getGeneralInteractivePaymentOperationForOrganization(league.organizationId, requestKey);
    if (existingOperationBeforeAuthorization) {
      if (!await canRecoverInteractiveOperation(req, existingOperationBeforeAuthorization)) {
        return sendError(res, 'Payment operation not found', 404, 'NOT_FOUND');
      }
      const existingSnapshotBeforeCanonical = await storage.getInteractivePaymentOperationSnapshotForOrganization(league.organizationId, existingOperationBeforeAuthorization.id);
      const replayBuyerEmail = typeof req.body.buyerEmail === 'string'
        ? req.body.buyerEmail.trim() || null
        : existingSnapshotBeforeCanonical?.buyerEmail ?? null;
      const expectedRequestFingerprint = interactiveReplayRequestFingerprint(existingOperationBeforeAuthorization, occurrenceSelections, occurrenceQuoteFingerprint);
      const baseRequestFingerprint = interactiveReplayRequestFingerprint(existingOperationBeforeAuthorization, undefined, undefined);
      const replayMatches = interactiveReplaySnapshotMatches({
        snapshot: existingSnapshotBeforeCanonical,
        leagueId,
        sourceId,
        sourceKind,
        storeCard: req.body.storeCard === true,
        buyerEmail: replayBuyerEmail,
        payerBowlerId: existingSnapshotBeforeCanonical?.payerBowlerId ?? -1,
        allocations: cleanPayees.map((payee) => ({ bowlerId: payee.bowlerId, amountMinor: payee.amount })),
      });
      if (!replayMatches || existingOperationBeforeAuthorization.requestFingerprint !== expectedRequestFingerprint
        || (occurrenceSelections === undefined && existingOperationBeforeAuthorization.requestFingerprint !== baseRequestFingerprint)) {
        return sendError(res, 'This Idempotency-Key was already used for different payment details.', 409, 'IDEMPOTENCY_CONFLICT');
      }
      try {
        await validateInteractiveOccurrenceReplay({ operationId: existingOperationBeforeAuthorization.id, organizationId: league.organizationId, leagueId, amountMinor: amount, currency: 'USD', selections: occurrenceSelections });
      } catch (error) {
        const occurrenceError = occurrenceAllocationRouteError(error);
        if (occurrenceError) return sendError(res, occurrenceError.message, 409, occurrenceError.code);
        throw error;
      }
      return respondWithInteractiveOperation(res, league.organizationId, existingOperationBeforeAuthorization, existingOperationBeforeAuthorization.status === 'pending' && existingOperationBeforeAuthorization.attemptCount === 0);
    }
    // The exact-key branch above returns; a new preparation has no operation
    // to exclude from its first live quote.
    const existingOperationForQuoteId: string | undefined = undefined;
    // Authorize EACH payee independently. The actor must pass
    // canUserPayForBowler for every target — a since-revoked link or
    // cross-org payee aborts the whole batch (atomic).
    let payerBowlerId: number | undefined;
    for (const p of cleanPayees) {
      const authz = await canUserPayForBowler(req, p.bowlerId);
      if (!authz.allowed) {
        return sendError(res, `You don't have access to bowler ${p.bowlerId}`, 403, 'FORBIDDEN');
      }
      if (payerBowlerId === undefined) payerBowlerId = authz.payerBowlerId;
    }
    if (!league.weeklyFee) {
      return sendError(res, 'League has no weekly fee configured', 400, 'LEAGUE_NOT_CONFIGURED');
    }
    if (!league.seasonStart || !league.seasonEnd) {
      return sendError(res, 'League has no season dates configured', 400, 'LEAGUE_NOT_CONFIGURED');
    }
    try {
      canonicalOccurrenceActive = await getInteractiveOccurrenceActivation({ organizationId: league.organizationId, leagueId });
    } catch (error) {
      if (error instanceof InteractiveOccurrenceAllocationError) return sendError(res, 'Payment allocation is unavailable for this league', 409, 'OCCURRENCE_ALLOCATION_CONFLICT');
      throw error;
    }
    if (canonicalOccurrenceActive && occurrenceSelections === undefined) {
      return sendError(res, 'Select one or more obligations before paying', 409, 'OCCURRENCE_SELECTION_REQUIRED');
    }
    if (!canonicalOccurrenceActive && occurrenceSelections !== undefined) {
      return sendError(res, 'Occurrence allocation is unavailable for this league', 409, 'OCCURRENCE_ALLOCATION_UNAVAILABLE');
    }
    const fullSeasonAmount = canonicalOccurrenceActive ? null : league.weeklyFee * (
      league.totalBowlingWeeks != null
        ? getEffectiveBowlingWeeks(league.totalBowlingWeeks, league.cancelledDates ?? [])
        : Math.max(1, Math.ceil((new Date(league.seasonEnd).getTime() - new Date(league.seasonStart).getTime()) / (7 * 24 * 60 * 60 * 1000)))
    );
    if (canonicalOccurrenceActive && occurrenceSelections) {
      try {
        const quote = await quoteInteractiveOccurrenceAllocations({ organizationId: league.organizationId, leagueId, amountMinor: amount, currency: 'USD', selections: occurrenceSelections, allowedBowlerIds: cleanPayees.map((payee) => payee.bowlerId), excludeOperationId: existingOperationForQuoteId });
        validateInteractiveQuotePayees(quote, cleanPayees);
      } catch (error) {
        if (error instanceof InteractiveOccurrenceAllocationError) return sendError(res, 'Payment allocation could not be validated', 409, 'OCCURRENCE_ALLOCATION_CONFLICT');
        throw error;
      }
    }
    if (!payerBowlerId) {
      return sendError(res, 'Combined pay requires a payer bowler', 403, 'FORBIDDEN');
    }
    const payerBowler = await storage.getBowler(payerBowlerId);
    if (!payerBowler || payerBowler.organizationId !== league.organizationId) {
      return sendError(res, 'Payer bowler is not in the same org as this league', 403, 'FORBIDDEN');
    }

    // Per-payee remaining-balance check + verify each payee bowler
    // exists in the same org as the league.
    const payeeBowlers: Record<number, Awaited<ReturnType<typeof storage.getBowler>>> = {};
    for (const p of cleanPayees) {
      const b = await storage.getBowler(p.bowlerId);
      if (!b) return sendError(res, `Bowler ${p.bowlerId} not found`, 404, 'NOT_FOUND');
      if (b.organizationId !== league.organizationId) {
        return sendError(res, `Bowler ${p.bowlerId} is not in this league's organization`, 403, 'FORBIDDEN');
      }
      // P1 security: payee must be actively rostered in the selected
      // league, not merely in the same org. Otherwise an accepted payment
      // partner could push a charge onto a league the payee isn't in.
      if (!(await storage.isBowlerActiveInLeague(p.bowlerId, leagueId))) {
        return sendError(res, `Bowler ${p.bowlerId} is not rostered in this league`, 400, 'BOWLER_NOT_IN_LEAGUE');
      }
      payeeBowlers[p.bowlerId] = b;

      const existing = canonicalOccurrenceActive ? [] : await storage.getPayments({
        bowlerId: p.bowlerId,
        leagueId,
        organizationId: league.organizationId,
      });
      const totalPaid = existing
        .filter((row) => row.status === 'paid')
        .reduce((s, r) => s + (r.amount || 0), 0);
      const remaining = fullSeasonAmount === null ? null : Math.max(0, fullSeasonAmount - totalPaid);
      if (remaining !== null && p.amount > remaining) {
        return sendError(
          res,
          `Amount for bowler ${p.bowlerId} ($${(p.amount / 100).toFixed(2)}) exceeds remaining balance ($${(remaining / 100).toFixed(2)})`,
          400,
          'AMOUNT_EXCEEDS_BALANCE',
        );
      }
    }

    const provider = await getPaymentProvider(league.locationId ?? null);

    const trimmedBuyerEmail = typeof req.body.buyerEmail === 'string'
      ? req.body.buyerEmail.trim()
      : '';
    const buyerEmail = payerBowler.email || trimmedBuyerEmail || undefined;
    if (buyerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail)) {
      return sendError(res, 'Buyer email is invalid', 400, 'VALIDATION_ERROR');
    }
    if (provider.providerName === 'square' && !buyerEmail) {
      return sendError(
        res,
        'A buyer email is required for Square card payments so the receipt can be sent.',
        400,
        'BUYER_EMAIL_REQUIRED',
      );
    }

    // Vault belongs to the payer.
    let customerId = getProviderCustomerId(payerBowler, provider);
    if (req.body.storeCard && !customerId) {
      const bootstrapped = await ensureProviderCustomer(provider, payerBowler);
      if (bootstrapped) customerId = bootstrapped;
    }

    // ONE provider charge for the full total.
    const weeklyFee = league.weeklyFee || 0;
    const quantity = weeklyFee > 0 && amount % weeklyFee === 0 ? String(amount / weeklyFee) : '1';
    const lineItems = buildLineItems(league, quantity);
    const organizationId = league.organizationId;
    const paidByUserId = req.user?.organizationId === organizationId
      ? req.user.id
      : null;
    const existingOperation = await storage.getGeneralInteractivePaymentOperationForOrganization(
      organizationId,
      requestKey,
    );
    const existingSnapshot = existingOperation
      ? await storage.getInteractivePaymentOperationSnapshotForOrganization(organizationId, existingOperation.id)
      : undefined;
    const weekOf = existingSnapshot?.weekOf ?? leagueDayStart(league);
    const squareConfig = league.locationId === null
      ? null
      : await storage.getLocationSquareConfig(league.locationId);
    const operation = await prepareInteractivePaymentOperation({
      organizationId,
      authorizingUserId: req.user?.id ?? 0,
      requestKey,
      amountMinor: amount,
      currency: 'USD',
      providerName: provider.providerName,
      leagueId,
      locationId: league.locationId,
      providerLocationId: squareConfig?.locationId?.trim() || null,
      payerBowlerId,
      requestKind: lineItems.length > 0 ? 'order' : 'direct',
      sourceId,
      customerId: customerId ?? null,
      buyerEmail: buyerEmail ?? null,
      storeCard: req.body.storeCard === true,
      sourceKind,
      weekOf,
      combined: true,
      allocations: cleanPayees.map((p, idx) => {
        const { lineageAmount, prizeFundAmount } = computePaymentSplit(p.amount, league);
        return {
          allocationIndex: idx,
          bowlerId: p.bowlerId,
          amountMinor: p.amount,
          lineageAmountMinor: lineageAmount ?? null,
          prizeFundAmountMinor: prizeFundAmount ?? null,
          weekOf,
          paidByUserId,
          notes: p.bowlerId === payerBowlerId
            ? 'Combined payment (self + partners)'
            : 'Combined payment (paid by partner)',
        };
      }),
      lineItems: lineItems.map((item, index) => ({
        lineItemIndex: index,
        catalogObjectId: item.catalogObjectId,
        quantity: item.quantity,
      })),
      occurrenceSelections,
      occurrenceQuoteFingerprint,
    });
    return respondWithInteractiveOperation(
      res,
      organizationId,
      operation,
      operation.status === 'pending' && operation.attemptCount === 0,
    );
  } catch (error) {
    const occurrenceError = occurrenceAllocationRouteError(error);
    if (occurrenceError) return sendError(res, occurrenceError.message, 409, occurrenceError.code);
    if (error instanceof PaymentOperationImmutableMismatchError) {
      return sendError(res, 'This Idempotency-Key was already used for different payment details.', 409, 'IDEMPOTENCY_CONFLICT');
    }
    if (error instanceof PaymentOperationValidationError) {
      return sendError(res, 'The payment request could not be prepared.', 400, 'VALIDATION_ERROR');
    }
    const errDetail = error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack?.split('\n').slice(0, 5).join('\n') }
      : error;
    log.error('combined-pay: processing error', { error: errDetail });
    const { status, userMessage, code } = buildPaymentErrorResponse(
      error,
      GENERIC_PAYMENT_USER_MESSAGE,
      'PAYMENT_ERROR',
    );
    return sendError(res, userMessage, status, code);
  }
});

router.post('/payments', paymentLimiter, async (req, res) => {
  try {
    if (await rejectLegacyRosterCharge(req, res)) return;
    const requestKey = requireInteractiveRequestKey(req, res);
    if (!requestKey) return;
    const sourceKind = requireInteractiveSourceKind(req, res);
    if (!sourceKind) return;
    const occurrenceSelections = parseOccurrenceSelections(req.body?.occurrenceAllocations);
    const occurrenceQuoteFingerprint = typeof req.body?.occurrenceQuoteFingerprint === 'string'
      ? req.body.occurrenceQuoteFingerprint : undefined;
    const { sourceId, amount, bowlerId, leagueId } = req.body;

    if (isDev) log.info('Payment request received:', {
      bowlerId,
      leagueId,
      amount,
      hasSourceId: !!sourceId,
      userId: req.user?.id,
    });

    if (!sourceId || !bowlerId || !leagueId) {
      return sendError(res, 'Missing required payment fields', 400, 'VALIDATION_ERROR');
    }

    if (typeof amount !== 'number' || amount <= 0 || !Number.isInteger(amount)) {
      return sendError(res, 'Amount must be a positive integer', 400, 'VALIDATION_ERROR');
    }

    if (!await hasAccessToLeague(req, leagueId)) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }

    const league = await storage.getLeague(leagueId);
    if (!league) {
      return sendError(res, 'League not found', 404, 'NOT_FOUND');
    }
    const replayOrganizationId = league.organizationId ?? 0;
    const existingOperationBeforeCanonical = await storage.getGeneralInteractivePaymentOperationForOrganization(replayOrganizationId, requestKey);
    if (existingOperationBeforeCanonical) {
      if (!await canRecoverInteractiveOperation(req, existingOperationBeforeCanonical)) {
        return sendError(res, 'Payment operation not found', 404, 'NOT_FOUND');
      }
      const existingSnapshotBeforeCanonical = await storage.getInteractivePaymentOperationSnapshotForOrganization(replayOrganizationId, existingOperationBeforeCanonical.id);
      const replayBuyerEmail = typeof req.body.buyerEmail === 'string'
        ? req.body.buyerEmail.trim() || null
        : existingSnapshotBeforeCanonical?.buyerEmail ?? null;
      const expectedRequestFingerprint = interactiveReplayRequestFingerprint(existingOperationBeforeCanonical, occurrenceSelections, occurrenceQuoteFingerprint);
      const baseRequestFingerprint = interactiveReplayRequestFingerprint(existingOperationBeforeCanonical, undefined, undefined);
      const replayMatches = interactiveReplaySnapshotMatches({
        snapshot: existingSnapshotBeforeCanonical,
        leagueId,
        sourceId,
        sourceKind,
        storeCard: req.body.storeCard === true,
        buyerEmail: replayBuyerEmail,
        payerBowlerId: existingSnapshotBeforeCanonical?.payerBowlerId ?? -1,
        allocations: [{ bowlerId, amountMinor: amount }],
      });
      if (!replayMatches || existingOperationBeforeCanonical.requestFingerprint !== expectedRequestFingerprint
        || (occurrenceSelections === undefined && existingOperationBeforeCanonical.requestFingerprint !== baseRequestFingerprint)) {
        return sendError(res, 'This Idempotency-Key was already used for different payment details.', 409, 'IDEMPOTENCY_CONFLICT');
      }
      try {
        await validateInteractiveOccurrenceReplay({ operationId: existingOperationBeforeCanonical.id, organizationId: replayOrganizationId, leagueId, amountMinor: amount, currency: 'USD', selections: occurrenceSelections });
      } catch (error) {
        const occurrenceError = occurrenceAllocationRouteError(error);
        if (occurrenceError) return sendError(res, occurrenceError.message, 409, occurrenceError.code);
        throw error;
      }
      return respondWithInteractiveOperation(res, replayOrganizationId, existingOperationBeforeCanonical, existingOperationBeforeCanonical.status === 'pending' && existingOperationBeforeCanonical.attemptCount === 0);
    }

    // Authorize: self OR accepted-link partner OR org/system admin.
    // Non-admin bowlers must pass canUserPayForBowler — same-league
    // alone is NOT a valid pay path. This check runs only for a new intent;
    // exact recovery above uses the immutable actor authorization.
    const payAuthz = await canUserPayForBowler(req, bowlerId);
    let isAdminFallback = false;
    if (!payAuthz.allowed) {
      if (!req.user || !isOrgOrHigher(req.user)) {
        return sendError(res, "You don't have access to this bowler", 403, 'FORBIDDEN');
      }
      if (!await hasAccessToBowler(req, bowlerId)) {
        return sendError(res, "You don't have access to this bowler", 403, 'FORBIDDEN');
      }
      isAdminFallback = true;
    }
    // when the payer is a *different* bowler from the target
    // (partner pay), the saved-card / wallet customer id MUST come from
    // the PAYER's vault, not the target's — the card on file lives with
    // the payer. We resolve `payerBowler` here and use it below to
    // derive `customerId` instead of the target bowler.
    const isPartnerPay =
      !isAdminFallback &&
      payAuthz.payerBowlerId !== undefined &&
      payAuthz.payerBowlerId !== bowlerId;
    const payerBowler =
      isPartnerPay && payAuthz.payerBowlerId !== undefined
        ? await storage.getBowler(payAuthz.payerBowlerId)
        : null;
    if (isPartnerPay && !payerBowler) {
      return sendError(res, "Payer bowler not found", 404, 'NOT_FOUND');
    }
    const bowler = await storage.getBowler(bowlerId);
    if (!bowler) {
      return sendError(res, 'Bowler not found', 404, 'NOT_FOUND');
    }

    if (!league.weeklyFee) {
      return sendError(res, 'League has no weekly fee configured — cannot process payment', 400, 'LEAGUE_NOT_CONFIGURED');
    }

    if (!league.seasonStart || !league.seasonEnd) {
      return sendError(res, 'League has no season dates configured — cannot process payment', 400, 'LEAGUE_NOT_CONFIGURED');
    }

    if (league.organizationId == null) {
      return sendError(res, 'League is not assigned to an organization', 400, 'LEAGUE_NOT_CONFIGURED');
    }
    let canonicalOccurrenceActive: boolean;
    try {
      canonicalOccurrenceActive = await getInteractiveOccurrenceActivation({ organizationId: league.organizationId, leagueId });
    } catch (error) {
      if (error instanceof InteractiveOccurrenceAllocationError) return sendError(res, 'Payment allocation is unavailable for this league', 409, 'OCCURRENCE_ALLOCATION_CONFLICT');
      throw error;
    }
    if (canonicalOccurrenceActive && occurrenceSelections === undefined) {
      return sendError(res, 'Select one or more obligations before paying', 409, 'OCCURRENCE_SELECTION_REQUIRED');
    }
    if (!canonicalOccurrenceActive && occurrenceSelections !== undefined) {
      return sendError(res, 'Occurrence allocation is unavailable for this league', 409, 'OCCURRENCE_ALLOCATION_UNAVAILABLE');
    }
    if (canonicalOccurrenceActive && occurrenceSelections) {
      try {
        const existingOperationForQuote = await storage.getGeneralInteractivePaymentOperationForOrganization(league.organizationId, requestKey);
        await quoteInteractiveOccurrenceAllocations({ organizationId: league.organizationId, leagueId, amountMinor: amount, currency: 'USD', selections: occurrenceSelections, allowedBowlerIds: [bowlerId], excludeOperationId: existingOperationForQuote?.id });
      } catch (error) {
        if (error instanceof InteractiveOccurrenceAllocationError) return sendError(res, 'Payment allocation could not be validated', 409, 'OCCURRENCE_ALLOCATION_CONFLICT');
        throw error;
      }
    }

    let totalWeeks = 0;
    if (!canonicalOccurrenceActive) {
      const seasonStart = new Date(league.seasonStart);
      const seasonEnd = new Date(league.seasonEnd);
      totalWeeks = league.totalBowlingWeeks != null
        ? getEffectiveBowlingWeeks(league.totalBowlingWeeks, league.cancelledDates ?? [])
        : Math.max(1, Math.ceil((seasonEnd.getTime() - seasonStart.getTime()) / (7 * 24 * 60 * 60 * 1000)));
    }
    const fullSeasonAmount = canonicalOccurrenceActive ? null : league.weeklyFee * totalWeeks;
    // P1 security: the recipient bowler must belong to the league's org
    // AND be actively rostered in this league before we charge a card and
    // write a payment row for the (bowler, league) pair.
    if (bowler.organizationId !== league.organizationId) {
      return sendError(res, "Bowler is not in this league's organization", 403, 'FORBIDDEN');
    }
    if (!(await storage.isBowlerActiveInLeague(bowlerId, leagueId))) {
      return sendError(res, 'Bowler is not rostered in this league', 400, 'BOWLER_NOT_IN_LEAGUE');
    }
    const existingPayments = canonicalOccurrenceActive ? [] : await storage.getPayments({ bowlerId, leagueId, organizationId: league.organizationId });
    const totalPaid = existingPayments
      .filter((p) => p.status === 'paid')
      .reduce((sum, p) => sum + (p.amount || 0), 0);

    const remainingBalance = fullSeasonAmount === null ? null : Math.max(0, fullSeasonAmount - totalPaid);

    if (remainingBalance !== null && amount > remainingBalance) {
      return sendError(res, `Amount ($${(amount / 100).toFixed(2)}) exceeds remaining balance ($${(remainingBalance / 100).toFixed(2)})`, 400, 'AMOUNT_EXCEEDS_BALANCE');
    }

    const provider = await getPaymentProvider(league.locationId ?? null);

    // For partner-pay the saved-card / wallet customer id comes from
    // the payer's vault. Admin-fallback never carries a payer vault and
    // must not write into the recipient's vault.
    if (isAdminFallback && req.body.storeCard) {
      return sendError(
        res,
        "Admins cannot save a card to a bowler's vault from this checkout. Use the bowler's own dashboard or the admin manual-payment path.",
        403,
        'ADMIN_VAULT_WRITE_FORBIDDEN',
      );
    }
    const vaultBowler = isPartnerPay && payerBowler ? payerBowler : bowler;
    let customerId = isAdminFallback
      ? undefined
      : getProviderCustomerId(vaultBowler, provider);
    if (req.body.storeCard && !customerId) {
      const bootstrapped = await ensureProviderCustomer(provider, vaultBowler);
      if (bootstrapped) {
        customerId = bootstrapped;
      } else {
        log.warn('Cannot store card — bowler has no customer ID and bootstrap failed:', vaultBowler.id);
      }
    }

    const weeklyFee = league.weeklyFee || 0;
    const quantity = weeklyFee > 0 && amount % weeklyFee === 0
      ? String(amount / weeklyFee)
      : '1';
    const lineItems = buildLineItems(league, quantity);

    // bowler.email is the default; the checkout UI may
    // also pass an explicit `buyerEmail` in the body so a bowler with
    // no email on file can still capture one inline at payment time
    // and trigger Square's hosted receipt.
    const requestBuyerEmail = typeof req.body.buyerEmail === 'string'
      ? req.body.buyerEmail.trim()
      : '';
    const buyerEmail = bowler.email || requestBuyerEmail || undefined;
    if (buyerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail)) {
      return sendError(res, 'Buyer email is invalid', 400, 'VALIDATION_ERROR');
    }

    // HARD-ENFORCE buyer email for interactive Square charges.
    // This route only handles user-driven checkouts (a sourceId from a card
    // form / Apple Pay / Google Pay), so we have a human who can supply an
    // email. Autopay (server/services/payment-execution.ts) is the only
    // unattended Square path and is allowed to warn+flag without an email.
    // The matching frontend forms make the inline "Email for receipt" field
    // required when bowler.email is missing; this is the server-side guard.
    if (provider.providerName === 'square' && !buyerEmail) {
      return sendError(
        res,
        "A buyer email is required for Square card payments so the receipt can be sent. Add an email to the bowler's profile or enter one at checkout.",
        400,
        'BUYER_EMAIL_REQUIRED',
      );
    }

    // when a bowler self-checks-out (their own user account
    // is linked to this bowler row) and supplies a brand-new email at
    // checkout, persist it to their profile. This means the very next
    // charge will already have an email on file — no inline prompt and
    // no need to use the admin Resend flow.
    const isSelfCheckout = !!req.user?.bowlerId && req.user.bowlerId === bowlerId;
    if (isSelfCheckout && !bowler.email && requestBuyerEmail) {
      try {
        await storage.updateBowler(bowlerId, { email: requestBuyerEmail });
      } catch (err) {
        // Non-fatal: payment must still proceed even if profile save
        // fails (validation, race, etc.). Log for ops visibility.
        log.warn('Failed to backfill bowler email at self-checkout', {
          bowlerId, error: err instanceof Error ? err.message : err,
        });
      }
    }

    if (isDev) log.info('Processing payment:', {
      bowlerId, leagueId, amount,
      locationId: league.locationId,
      provider: provider.providerName,
      hasLineItems: lineItems.length > 0,
      hasCustomerId: !!customerId,
    });

    const { lineageAmount, prizeFundAmount } = computePaymentSplit(amount, league);
    const organizationId = league.organizationId;
    const paidByUserId = req.user?.organizationId === organizationId
      ? req.user.id
      : null;
    const existingOperation = await storage.getGeneralInteractivePaymentOperationForOrganization(
      organizationId,
      requestKey,
    );
    const existingSnapshot = existingOperation
      ? await storage.getInteractivePaymentOperationSnapshotForOrganization(organizationId, existingOperation.id)
      : undefined;
    const weekOf = existingSnapshot?.weekOf ?? leagueDayStart(league);
    const squareConfig = league.locationId === null
      ? null
      : await storage.getLocationSquareConfig(league.locationId);
    const operation = await prepareInteractivePaymentOperation({
      organizationId,
      authorizingUserId: req.user?.id ?? 0,
      requestKey,
      amountMinor: amount,
      currency: 'USD',
      providerName: provider.providerName,
      leagueId,
      locationId: league.locationId,
      providerLocationId: squareConfig?.locationId?.trim() || null,
      payerBowlerId: isPartnerPay && payerBowler ? payerBowler.id : bowlerId,
      requestKind: lineItems.length > 0 ? 'order' : 'direct',
      sourceId,
      customerId: customerId ?? null,
      buyerEmail: buyerEmail ?? null,
      storeCard: req.body.storeCard === true,
      sourceKind,
      weekOf,
      combined: false,
      allocations: [{
        allocationIndex: 0,
        bowlerId,
        amountMinor: amount,
        lineageAmountMinor: lineageAmount ?? null,
        prizeFundAmountMinor: prizeFundAmount ?? null,
        weekOf,
        paidByUserId:
          isPartnerPay || (isAdminFallback && req.user?.bowlerId !== bowlerId)
            ? paidByUserId
            : null,
        notes: null,
      }],
      lineItems: lineItems.map((item, index) => ({
        lineItemIndex: index,
        catalogObjectId: item.catalogObjectId,
        quantity: item.quantity,
      })),
      occurrenceSelections,
      occurrenceQuoteFingerprint,
    });
    return respondWithInteractiveOperation(
      res,
      organizationId,
      operation,
      operation.status === 'pending' && operation.attemptCount === 0,
    );
  } catch (error) {
    const occurrenceError = occurrenceAllocationRouteError(error);
    if (occurrenceError) return sendError(res, occurrenceError.message, 409, occurrenceError.code);
    if (error instanceof PaymentOperationImmutableMismatchError) {
      return sendError(res, 'This Idempotency-Key was already used for different payment details.', 409, 'IDEMPOTENCY_CONFLICT');
    }
    if (error instanceof PaymentOperationValidationError) {
      return sendError(res, 'The payment request could not be prepared.', 400, 'VALIDATION_ERROR');
    }
    // Always log the full technical detail server-side, regardless of
    // which user-facing branch we take below. Includes the typed
    // `detail` (Square's raw `errors[0].detail`) when present, plus
    // any structured `errors[]` fields we can pull off a raw ApiError
    // that escaped the provider's own catch.
    const errDetail = error instanceof Error ? {
      name: error.name,
      message: error.message,
      stack: error.stack?.split('\n').slice(0, 5).join('\n'),
    } : error;
    type ProviderErrorDetail = { detail?: string };
    const providerErrors: ProviderErrorDetail[] | undefined = (() => {
      if (!error || typeof error !== 'object') return undefined;
      const e = error as { errors?: unknown; body?: { errors?: unknown } };
      const found = e.errors ?? e.body?.errors;
      return Array.isArray(found) ? (found as ProviderErrorDetail[]) : undefined;
    })();
    log.error('Payment processing error:', {
      error: errDetail,
      providerErrors,
      typedCode: error instanceof PaymentProviderError ? error.code : undefined,
      typedDetail: error instanceof PaymentProviderError ? error.detail : undefined,
    });

    // task #514 / #605: only the typed `userMessage` is allowed
    // through to the client — Square's raw `providerErrors[0].detail`
    // is NOT forwarded as a user message anymore (it can contain
    // provider jargon like "Card was declined by the issuing bank for
    // reason CARD_DECLINED_VERIFICATION_REQUIRED"). The unrecognized
    // fallback is a single, friendly sentence. Mapping is delegated
    // to the shared helper so the refund / cards / autopay paths
    // can't drift from this contract.
    const { status, userMessage, code } = buildPaymentErrorResponse(
      error,
      GENERIC_PAYMENT_USER_MESSAGE,
      'PAYMENT_ERROR',
    );
    return sendError(res, userMessage, status, code);
  }
});

export default router;
