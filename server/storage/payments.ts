import { eq, and, desc, inArray, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  payments, paymentSchedules, leagues, bowlerLeagues,
  paymentDisputes, paymentOperations, paymentOccurrenceAllocations,
  financialActivations, occurrenceCollectionPlans, occurrenceCollectionPlanItems,
  type Payment, type InsertPayment, type UpdatePayment,
  type PaymentSchedule, type InsertPaymentSchedule, type UpdatePaymentSchedule,
  type PaginatedResult,
} from "@shared/schema";
import { createLogger } from '../logger';
import { lockLeagueSchedule } from './league-schedule-lock.js';
import {
  assertNoOccurrenceReferenceConflict,
  logOccurrenceCompatibility,
  occurrenceCompatibilityTransactionTime,
  resolveCanonicalOccurrenceCompatibility,
} from '../services/canonical-occurrence-compatibility.js';

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

export class CanonicalAllocationRequiredError extends Error {
  constructor() { super("canonical allocation is required"); this.name = "CanonicalAllocationRequiredError"; }
}

export class FinancialEvidenceIncompatibleError extends Error {
  constructor() { super("financial evidence is incompatible"); this.name = "FinancialEvidenceIncompatibleError"; }
}

interface PaymentFilters {
  bowlerId?: number;
  leagueId?: number;
  leagueIds?: number[];
  teamId?: number;
  weekOf?: Date;
  organizationId: number;
}

interface AllPaymentFilters {
  bowlerId?: number;
  leagueId?: number;
  teamId?: number;
  weekOf?: Date;
  organizationId?: number;
  leagueIds?: number[];
}

export function buildPaymentConditions(filters: AllPaymentFilters, options?: { excludeOrgLessLeagues?: boolean }) {
  const conditions = [];

  if (filters.organizationId !== undefined) {
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
  if (filters.weekOf !== undefined) {
    const startDate = new Date(filters.weekOf);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(filters.weekOf);
    endDate.setHours(23, 59, 59, 999);
    conditions.push(sql`${payments.weekOf} BETWEEN ${startDate} AND ${endDate}`);
  }

  return conditions;
}

export async function getPayments(filters: PaymentFilters): Promise<Payment[]> {
  const conditions = buildPaymentConditions(filters);

  const query = db.select().from(payments);

  if (conditions.length > 0) {
    query.where(and(...conditions));
  }

  query.orderBy(desc(payments.weekOf));

  return query;
}

export async function getAllPaymentsSystemAdmin(filters?: { bowlerId?: number; leagueId?: number; teamId?: number; weekOf?: Date }): Promise<Payment[]> {
  const conditions = buildPaymentConditions(filters ?? {}, { excludeOrgLessLeagues: true });
  const query = db.select().from(payments);
  if (conditions.length > 0) {
    query.where(and(...conditions));
  }
  query.orderBy(desc(payments.weekOf));
  return query;
}

export async function getAllPaymentsPaginatedSystemAdmin(
  filters: { bowlerId?: number; leagueId?: number; teamId?: number; weekOf?: Date },
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
  query.orderBy(desc(payments.weekOf));
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
  query.orderBy(desc(payments.weekOf));
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
    .where(eq(payments.id, id))
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

export async function createPayment(payment: InsertPayment): Promise<Payment> {
  return db.transaction(async (tx) => {
    const [league] = await tx.select({ organizationId: leagues.organizationId })
      .from(leagues).where(eq(leagues.id, payment.leagueId)).limit(1);
    if (!league) throw new Error("Payment league not found");
    if (league.organizationId !== null) {
      // This is the same org/league lock family used by F1/F2/F3/F4. The
      // evidence read and insert stay inside the lock-owning transaction.
      await lockLeagueSchedule(tx, league.organizationId, payment.leagueId);
      const [active] = await tx.select({ completenessMarker: financialActivations.completenessMarker })
        .from(financialActivations).where(and(
          eq(financialActivations.organizationId, league.organizationId),
          eq(financialActivations.leagueId, payment.leagueId),
          eq(financialActivations.state, "active"),
        )).limit(1);
      if (active?.completenessMarker === true) throw new CanonicalAllocationRequiredError();
      const partial = await tx.execute(sql`
        SELECT EXISTS (
          SELECT 1 FROM bowler_occurrence_obligations WHERE organization_id = ${league.organizationId} AND league_id = ${payment.leagueId}
          UNION ALL SELECT 1 FROM ${occurrenceCollectionPlans} WHERE organization_id = ${league.organizationId} AND league_id = ${payment.leagueId}
          UNION ALL SELECT 1 FROM ${occurrenceCollectionPlanItems} WHERE organization_id = ${league.organizationId} AND league_id = ${payment.leagueId}
          UNION ALL SELECT 1 FROM ${paymentOccurrenceAllocations} WHERE organization_id = ${league.organizationId} AND league_id = ${payment.leagueId}
        ) AS present
      `);
      if ((partial.rows[0] as { present?: boolean } | undefined)?.present) throw new FinancialEvidenceIncompatibleError();
    }
    const [result] = await tx.insert(payments).values(payment).returning();
    return result;
  });
}

/**
 * Task #706 — atomically insert N per-bowler payment rows that all share
 * a single combined card transaction. All rows commit or none do, so a
 * post-charge insert failure leaves zero phantom rows behind (caller
 * refunds the provider charge).
 */
export async function createCombinedPayments(
  rows: InsertPayment[],
): Promise<Array<{ id: number; bowlerId: number; amount: number }>> {
  if (rows.length === 0) return [];
  return await db.transaction(async (tx) => {
    const inserted = await tx.insert(payments).values(rows).returning({
      id: payments.id,
      bowlerId: payments.bowlerId,
      amount: payments.amount,
    });
    return inserted;
  });
}

export async function getPaymentsByCombinedGroupId(groupId: string): Promise<Payment[]> {
  return await db
    .select()
    .from(payments)
    .where(eq(payments.combinedChargeGroupId, groupId));
}

export async function updatePayment(id: number, payment: UpdatePayment): Promise<Payment> {
  const keys = Object.keys(payment);
  const result = await db.transaction(async (tx) => {
    const [current] = await tx.select({
      id: payments.id,
      paymentOperationId: payments.paymentOperationId,
    }).from(payments).where(eq(payments.id, id)).limit(1).for("update");
    if (!current) return undefined;
    const [allocation] = await tx.select({ id: paymentOccurrenceAllocations.id })
      .from(paymentOccurrenceAllocations)
      .where(eq(paymentOccurrenceAllocations.paymentId, id))
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
    const [current] = await tx.select({ payment: payments })
      .from(payments)
      .innerJoin(leagues, and(eq(leagues.id, payments.leagueId), eq(leagues.organizationId, organizationId)))
      .where(eq(payments.id, id)).limit(1).for("update");
    if (!current) return undefined;
    const [updated] = await tx.update(payments).set(fields).where(eq(payments.id, id)).returning();
    return updated;
  });
}

export async function refundPayment(id: number, providerRefundId?: string, reason?: string): Promise<Payment> {
  const [result] = await db
    .update(payments)
    .set({
      status: 'refunded',
      squareRefundId: providerRefundId || null,
      refundReason: reason || null,
      refundedAt: new Date().toISOString(),
    })
    .where(eq(payments.id, id))
    .returning();
  return result;
}

export async function openDispute(id: number, disputeId: string): Promise<Payment> {
  const [result] = await db
    .update(payments)
    .set({
      status: 'disputed',
      disputeId,
      disputedAt: new Date().toISOString(),
    })
    .where(eq(payments.id, id))
    .returning();
  return result;
}

export async function deletePayment(id: number): Promise<void> {
  await db.transaction(async (tx) => {
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

    const [occurrenceEvidence] = await tx.select({ id: paymentOccurrenceAllocations.id })
      .from(paymentOccurrenceAllocations)
      .where(eq(paymentOccurrenceAllocations.paymentId, id))
      .limit(1);
    if (occurrenceEvidence) throw new PaymentOccurrenceEvidenceExistsError();

    await tx.delete(payments).where(eq(payments.id, id));
  });
}

export async function createPaymentSchedule(schedule: InsertPaymentSchedule): Promise<PaymentSchedule> {
  const { result, comparison } = await db.transaction(async (tx) => {
    const [league] = await tx.select({ organizationId: leagues.organizationId })
      .from(leagues).where(eq(leagues.id, schedule.leagueId)).limit(1);
    if (!league) throw new Error('Payment schedule league not found');
    if (league.organizationId === null) {
      const [legacyResult] = await tx.insert(paymentSchedules).values(schedule).returning();
      return { result: legacyResult, comparison: null };
    }
    await lockLeagueSchedule(tx, league.organizationId, schedule.leagueId);
    const transactionTime = await occurrenceCompatibilityTransactionTime(tx);
    const compatibility = await resolveCanonicalOccurrenceCompatibility(tx, {
      subject: 'payment_schedule',
      organizationId: league.organizationId,
      leagueId: schedule.leagueId,
      legacyStartAt: String(schedule.nextPaymentDate),
      immediateUpfront: schedule.frequency === 'upfront',
      eligibilityNow: transactionTime,
      existingReferenceId: null,
    });
    assertNoOccurrenceReferenceConflict(compatibility);
    const [created] = await tx.insert(paymentSchedules).values({
      ...schedule,
      nextOccurrenceId: compatibility.classification === 'exact_match'
        ? compatibility.occurrenceId
        : null,
    }).returning();
    return { result: created, comparison: compatibility };
  });
  if (comparison) logOccurrenceCompatibility('payment_schedule_create', comparison);
  if (!result) throw new Error('Payment schedule was not created');
  return result;
}

export async function getPaymentSchedule(bowlerId: number, leagueId: number): Promise<PaymentSchedule | undefined> {
  const [result] = await db
    .select()
    .from(paymentSchedules)
    .where(
      and(
        eq(paymentSchedules.bowlerId, bowlerId),
        eq(paymentSchedules.leagueId, leagueId),
        eq(paymentSchedules.active, true)
      )
    );
  return result;
}

export async function getPaymentScheduleById(id: number): Promise<PaymentSchedule | undefined> {
  const [result] = await db
    .select()
    .from(paymentSchedules)
    .where(eq(paymentSchedules.id, id));
  return result;
}

export async function getActiveSchedulesByLeague(leagueId: number): Promise<PaymentSchedule[]> {
  return db
    .select()
    .from(paymentSchedules)
    .where(
      and(
        eq(paymentSchedules.leagueId, leagueId),
        eq(paymentSchedules.active, true)
      )
    );
}

export async function getActiveSchedulesByLocationId(locationId: number): Promise<PaymentSchedule[]> {
  const rows = await db
    .select({ schedule: paymentSchedules })
    .from(paymentSchedules)
    .innerJoin(leagues, eq(paymentSchedules.leagueId, leagues.id))
    .where(
      and(
        eq(leagues.locationId, locationId),
        eq(paymentSchedules.active, true)
      )
    );
  return rows.map(r => r.schedule);
}

export async function deactivatePaymentSchedule(id: number, reason?: string): Promise<void> {
  await db
    .update(paymentSchedules)
    .set({
      active: false,
      cancelledAt: new Date().toISOString(),
      cancelReason: reason ?? null,
    })
    .where(eq(paymentSchedules.id, id));
}

export async function updatePaymentScheduleFields(
  id: number,
  fields: UpdatePaymentSchedule
): Promise<PaymentSchedule> {
  const preliminary = await getPaymentScheduleById(id);
  if (!preliminary) throw new Error('Payment schedule not found');
  const [league] = await db.select({ organizationId: leagues.organizationId })
    .from(leagues).where(eq(leagues.id, preliminary.leagueId)).limit(1);
  if (!league) throw new Error('Payment schedule league not found');
  const { updated, comparison } = await db.transaction(async (tx) => {
    if (league.organizationId !== null) {
      await lockLeagueSchedule(tx, league.organizationId, preliminary.leagueId);
    }
    const [current] = await tx.select().from(paymentSchedules)
      .where(eq(paymentSchedules.id, id)).limit(1).for('update');
    if (!current) throw new Error('Payment schedule not found');
    const cursorChanged = fields.nextPaymentDate !== undefined
      || (fields.frequency !== undefined && fields.frequency !== current.frequency);
    if (!cursorChanged || league.organizationId === null) {
      const [result] = await tx.update(paymentSchedules).set(fields)
        .where(eq(paymentSchedules.id, id)).returning();
      return { updated: result, comparison: null };
    }
    const transactionTime = await occurrenceCompatibilityTransactionTime(tx);
    const compatibility = await resolveCanonicalOccurrenceCompatibility(tx, {
      subject: 'payment_schedule',
      organizationId: league.organizationId,
      leagueId: current.leagueId,
      legacyStartAt: String(fields.nextPaymentDate ?? current.nextPaymentDate),
      immediateUpfront: (fields.frequency ?? current.frequency) === 'upfront',
      eligibilityNow: transactionTime,
      existingReferenceId: current.nextOccurrenceId,
    });
    assertNoOccurrenceReferenceConflict(compatibility);
    const [result] = await tx.update(paymentSchedules).set({
      ...fields,
      nextOccurrenceId: compatibility.classification === 'exact_match'
        ? compatibility.occurrenceId
        : null,
    }).where(eq(paymentSchedules.id, id)).returning();
    return { updated: result, comparison: compatibility };
  });
  if (comparison) logOccurrenceCompatibility('payment_schedule_cursor_update', comparison);
  if (!updated) throw new Error('Payment schedule was not updated');
  return updated;
}

export async function updatePaymentScheduleCard(bowlerId: number, leagueId: number, cardId: string): Promise<void> {
  await db
    .update(paymentSchedules)
    .set({ paymentCardId: cardId })
    .where(
      and(
        eq(paymentSchedules.bowlerId, bowlerId),
        eq(paymentSchedules.leagueId, leagueId),
        eq(paymentSchedules.active, true)
      )
    );
}
