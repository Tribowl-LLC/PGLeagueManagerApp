import { eq, and, desc, inArray, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  payments, leagues, bowlerLeagues,
  paymentDisputes, paymentOperations, paymentAllocations,
  type Payment, type UpdatePayment,
  type PaginatedResult,
} from "@shared/schema";
import { createLogger } from '../logger';
import { lockLeagueSchedule } from './league-schedule-lock.js';

const log = createLogger("StoragePayments");

export class PaymentDisputeEvidenceExistsError extends Error {
  constructor() {
    super("Payment cannot be deleted while retained dispute evidence exists");
    this.name = "PaymentDisputeEvidenceExistsError";
  }
}

export class PaymentOccurrenceEvidenceExistsError extends Error {
  constructor() {
    super("Payment cannot be deleted while occurrence allocation evidence exists");
    this.name = "PaymentOccurrenceEvidenceExistsError";
  }
}

export class PaymentEvidenceImmutableError extends Error {
  constructor() {
    super("Payment evidence is immutable");
    this.name = "PaymentEvidenceImmutableError";
  }
}

interface PaymentFilters {
  bowlerId?: number;
  leagueId?: number;
  leagueIds?: number[];
  teamId?: number;
  createdAt?: Date;
  organizationId: number;
}

interface AllPaymentFilters {
  bowlerId?: number;
  leagueId?: number;
  teamId?: number;
  createdAt?: Date;
  organizationId?: number;
  leagueIds?: number[];
}

export function buildPaymentConditions(filters: AllPaymentFilters, options?: { excludeOrgLessLeagues?: boolean }) {
  const conditions = [];

  if (filters.organizationId !== undefined) {
    conditions.push(eq(payments.organizationId, filters.organizationId));
    conditions.push(sql`${payments.leagueId} IN (SELECT "id" FROM ${leagues} WHERE ${leagues.organizationId} = ${filters.organizationId})`);
  } else if (options?.excludeOrgLessLeagues) {
    // Org-less resource policy (see server/utils/access-control.ts):
    // exclude payments whose parent league is missing or has organization_id IS NULL.
    conditions.push(
      sql`${payments.leagueId} IN (SELECT "id" FROM ${leagues} WHERE ${leagues.organizationId} IS NOT NULL)`,
    );
  }
  if (filters.bowlerId !== undefined) {
    conditions.push(eq(payments.bowlerId, filters.bowlerId));
  }
  if (filters.leagueId !== undefined) {
    conditions.push(eq(payments.leagueId, filters.leagueId));
  }
  if (filters.leagueIds !== undefined) {
    conditions.push(filters.leagueIds.length > 0
      ? inArray(payments.leagueId, filters.leagueIds)
      : sql`FALSE`);
  }
  if (filters.teamId !== undefined) {
    // A team membership is league-specific. Correlate both halves of that
    // identity so a bowler on the requested team in league A cannot make the
    // same bowler's payment in league B appear in a team-scoped report.
    conditions.push(sql`EXISTS (
      SELECT 1
      FROM ${bowlerLeagues}
      WHERE ${bowlerLeagues.bowlerId} = ${payments.bowlerId}
        AND ${bowlerLeagues.teamId} = ${filters.teamId}
        AND ${bowlerLeagues.leagueId} = ${payments.leagueId}
    )`);
  }
  if (filters.createdAt !== undefined) {
    const businessDate = filters.createdAt.toISOString().slice(0, 10);
    // Compare the immutable tender timestamp in each league's business
    // timezone; the server timezone must not affect a calendar-day filter.
    conditions.push(sql`(${payments.createdAt} AT TIME ZONE COALESCE((SELECT ${leagues.timezone} FROM ${leagues} WHERE ${leagues.id} = ${payments.leagueId}), 'UTC'))::date = ${businessDate}::date`);
  }

  return conditions;
}

export async function getPayments(filters: PaymentFilters): Promise<Payment[]> {
  const conditions = buildPaymentConditions(filters);

  const query = db.select().from(payments);

  if (conditions.length > 0) {
    query.where(and(...conditions));
  }

  query.orderBy(desc(payments.createdAt));

  return query;
}

export async function getAllPaymentsSystemAdmin(filters?: { bowlerId?: number; leagueId?: number; teamId?: number; createdAt?: Date }): Promise<Payment[]> {
  const conditions = buildPaymentConditions(filters ?? {}, { excludeOrgLessLeagues: true });
  const query = db.select().from(payments);
  if (conditions.length > 0) {
    query.where(and(...conditions));
  }
  query.orderBy(desc(payments.createdAt));
  return query;
}

export async function getAllPaymentsPaginatedSystemAdmin(
  filters: { bowlerId?: number; leagueId?: number; teamId?: number; createdAt?: Date },
  page: number,
  limit: number
): Promise<PaginatedResult<Payment>> {
  const conditions = buildPaymentConditions(filters, { excludeOrgLessLeagues: true });
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [countResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(payments)
    .where(whereClause);
  const total = Number(countResult?.count ?? 0);

  const offset = (page - 1) * limit;
  const query = db.select().from(payments);
  if (whereClause) {
    query.where(whereClause);
  }
  query.orderBy(desc(payments.createdAt));
  query.limit(limit);
  query.offset(offset);

  const items = await query;

  return {
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

export async function getPaymentsPaginated(
  filters: PaymentFilters,
  page: number,
  limit: number
): Promise<PaginatedResult<Payment>> {
  const conditions = buildPaymentConditions(filters);

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [countResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(payments)
    .where(whereClause);
  const total = Number(countResult?.count ?? 0);

  const offset = (page - 1) * limit;
  const query = db.select().from(payments);
  if (whereClause) {
    query.where(whereClause);
  }
  query.orderBy(desc(payments.createdAt));
  query.limit(limit);
  query.offset(offset);

  const items = await query;

  return {
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

export async function getPaymentById(id: number): Promise<Payment | undefined> {
  const [result] = await db.select().from(payments).where(eq(payments.id, id));
  return result;
}

/**
 * Tenant-scoped payment lookup for reporting, receipt, and mutation guards.
 * A payment without a league in the requested organization is intentionally
 * indistinguishable from a missing row.
 */
export async function getPaymentByIdForOrganization(id: number, organizationId: number): Promise<Payment | undefined> {
  const [result] = await db.select({ payment: payments })
    .from(payments)
    .innerJoin(leagues, and(eq(leagues.id, payments.leagueId), eq(leagues.organizationId, organizationId)))
    .where(and(eq(payments.id, id), eq(payments.organizationId, organizationId)))
    .limit(1);
  return result?.payment;
}

export async function getPaymentByIdempotencyKey(key: string): Promise<Payment | undefined> {
  const [result] = await db.select().from(payments).where(eq(payments.idempotencyKey, key)).limit(1);
  return result;
}

export async function getPaymentsByPaymentOperationId(
  organizationId: number,
  operationId: string,
): Promise<Payment[]> {
  return db
    .select({ payment: payments })
    .from(payments)
    .innerJoin(
      paymentOperations,
      eq(paymentOperations.id, payments.paymentOperationId),
    )
    .where(and(
      eq(paymentOperations.organizationId, organizationId),
      eq(paymentOperations.id, operationId),
      eq(payments.organizationId, organizationId),
    ))
    .then((rows) => rows.map(({ payment }) => payment));
}

export async function getPaymentByDisputeId(disputeId: string): Promise<Payment | undefined> {
  const [result] = await db.select().from(payments).where(eq(payments.disputeId, disputeId)).limit(1);
  return result;
}

export async function getPaymentByProviderPaymentId(providerPaymentId: string): Promise<Payment | undefined> {
  const [result] = await db.select().from(payments).where(eq(payments.providerPaymentId, providerPaymentId)).limit(1);
  return result;
}

export async function updatePayment(id: number, payment: UpdatePayment): Promise<Payment> {
  const keys = Object.keys(payment);
  const result = await db.transaction(async (tx) => {
    const [scope] = await tx.select({ leagueId: payments.leagueId, organizationId: leagues.organizationId })
      .from(payments)
      .innerJoin(leagues, eq(leagues.id, payments.leagueId))
      .where(eq(payments.id, id)).limit(1);
    if (!scope) return undefined;
    if (scope.organizationId !== null) await lockLeagueSchedule(tx, scope.organizationId, scope.leagueId);
    const [current] = await tx.select({
      id: payments.id,
      paymentOperationId: payments.paymentOperationId,
    }).from(payments).where(eq(payments.id, id)).limit(1).for("update");
    if (!current) return undefined;
    const [allocation] = await tx.select({ id: paymentAllocations.id })
      .from(paymentAllocations)
      .where(eq(paymentAllocations.paymentId, id))
      .limit(1);
    if (current.paymentOperationId !== null || allocation) {
      throw new PaymentEvidenceImmutableError();
    }
    const [updated] = await tx.update(payments).set(payment).where(eq(payments.id, id)).returning();
    return updated;
  });
  return result as Payment;
}

/**
 * Internal provider-cache path. Public payment PATCH must never be able to
 * mutate retained operation/allocation evidence, including receipt fields.
 * The organization join is part of the locked transaction so a cache write
 * cannot cross a tenant boundary.
 */
export async function updatePaymentReceiptCacheForOrganization(
  id: number,
  organizationId: number,
  fields: Pick<UpdatePayment, "receiptUrl" | "receiptNumber">,
): Promise<Payment | undefined> {
  return db.transaction(async (tx) => {
    // Receipt projection is an internal, tenant-scoped cache write. It is
    // deliberately narrower than the public payment mutation API: provider
    // and canonical allocation facts remain immutable, while a provider
    // receipt URL/number may be filled in lazily after the payment is read.
    const [scope] = await tx.select({ leagueId: payments.leagueId })
      .from(payments)
      .innerJoin(leagues, and(eq(leagues.id, payments.leagueId), eq(leagues.organizationId, organizationId)))
      .where(eq(payments.id, id)).limit(1);
    if (!scope) return undefined;
    await lockLeagueSchedule(tx, organizationId, scope.leagueId);
    const [updated] = await tx.update(payments).set(fields).where(and(
      eq(payments.id, id),
      eq(payments.leagueId, scope.leagueId),
    )).returning();
    return updated;
  });
}

export async function refundPayment(id: number, providerRefundId?: string, reason?: string): Promise<Payment> {
  return db.transaction(async (tx) => {
    const [scope] = await tx.select({ leagueId: payments.leagueId, organizationId: leagues.organizationId })
      .from(payments).innerJoin(leagues, eq(leagues.id, payments.leagueId)).where(eq(payments.id, id)).limit(1).for("update");
    if (!scope) throw new Error("Payment not found");
    if (scope.organizationId !== null) await lockLeagueSchedule(tx, scope.organizationId, scope.leagueId);
    const [result] = await tx.update(payments).set({
      status: 'refunded', squareRefundId: providerRefundId || null, refundReason: reason || null, refundedAt: new Date().toISOString(),
    }).where(eq(payments.id, id)).returning();
    if (scope.organizationId !== null) {
      await tx.update(paymentAllocations).set({ reviewRequired: true, reviewReason: reason || "provider_refund" })
        .where(and(eq(paymentAllocations.paymentId, id), eq(paymentAllocations.organizationId, scope.organizationId), eq(paymentAllocations.leagueId, scope.leagueId)));
    }
    return result;
  });
}

export async function openDispute(id: number, disputeId: string): Promise<Payment> {
  return db.transaction(async (tx) => {
    const [scope] = await tx.select({ leagueId: payments.leagueId, organizationId: leagues.organizationId })
      .from(payments).innerJoin(leagues, eq(leagues.id, payments.leagueId)).where(eq(payments.id, id)).limit(1).for("update");
    if (!scope) throw new Error("Payment not found");
    if (scope.organizationId !== null) await lockLeagueSchedule(tx, scope.organizationId, scope.leagueId);
    const [result] = await tx.update(payments).set({ status: 'disputed', disputeId, disputedAt: new Date().toISOString() }).where(eq(payments.id, id)).returning();
    if (scope.organizationId !== null) {
      await tx.update(paymentAllocations).set({ reviewRequired: true, reviewReason: "provider_dispute" })
        .where(and(eq(paymentAllocations.paymentId, id), eq(paymentAllocations.organizationId, scope.organizationId), eq(paymentAllocations.leagueId, scope.leagueId)));
    }
    return result;
  });
}

export async function deletePayment(id: number): Promise<void> {
  await db.transaction(async (tx) => {
    const [scope] = await tx.select({ leagueId: payments.leagueId, organizationId: leagues.organizationId })
      .from(payments)
      .innerJoin(leagues, eq(leagues.id, payments.leagueId))
      .where(eq(payments.id, id)).limit(1);
    if (!scope) return;
    if (scope.organizationId !== null) await lockLeagueSchedule(tx, scope.organizationId, scope.leagueId);
    const [payment] = await tx.select({
      id: payments.id,
      paymentOperationId: payments.paymentOperationId,
    }).from(payments).where(eq(payments.id, id)).limit(1).for("update");
    if (!payment) return;

    if (payment.paymentOperationId !== null) {
      // Preserve the existing dispute serialization/error contract while
      // still retaining every operation-linked row. A dispute that wins the
      // operation lock is the most specific retained-evidence reason.
      await tx.select({ id: paymentOperations.id })
        .from(paymentOperations)
        .where(eq(paymentOperations.id, payment.paymentOperationId))
        .limit(1)
        .for("update");
      const [retainedDispute] = await tx.select({ id: paymentDisputes.id })
        .from(paymentDisputes)
        .where(eq(paymentDisputes.paymentOperationId, payment.paymentOperationId))
        .limit(1);
      if (retainedDispute) throw new PaymentDisputeEvidenceExistsError();
      throw new PaymentOccurrenceEvidenceExistsError();
    }

    const [occurrenceEvidence] = await tx.select({ id: paymentAllocations.id })
      .from(paymentAllocations)
      .where(eq(paymentAllocations.paymentId, id))
      .limit(1);
    if (occurrenceEvidence) throw new PaymentOccurrenceEvidenceExistsError();

    await tx.delete(payments).where(eq(payments.id, id));
  });
}
