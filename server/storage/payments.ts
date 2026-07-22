import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  payments, paymentSchedules, leagues, bowlerLeagues,
  type Payment, type InsertPayment, type UpdatePayment,
  type PaymentSchedule, type InsertPaymentSchedule, type UpdatePaymentSchedule,
  type PaginatedResult,
} from "@shared/schema";
import { createLogger } from '../logger';

const log = createLogger("StoragePayments");

interface PaymentFilters {
  bowlerId?: number;
  leagueId?: number;
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
  if (filters.teamId !== undefined) {
    const bowlerLeaguesSubquery = db
      .select({ bowler_id: bowlerLeagues.bowlerId })
      .from(bowlerLeagues)
      .where(and(
        eq(bowlerLeagues.teamId, filters.teamId),
        filters.leagueId !== undefined ? eq(bowlerLeagues.leagueId, filters.leagueId) : undefined
      ))
      .as('bl');

    conditions.push(sql`${payments.bowlerId} IN (SELECT "bowler_id" FROM ${bowlerLeaguesSubquery})`);
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

export async function getPaymentByIdempotencyKey(key: string): Promise<Payment | undefined> {
  const [result] = await db.select().from(payments).where(eq(payments.idempotencyKey, key)).limit(1);
  return result;
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
  const [result] = await db.insert(payments).values(payment).returning();
  return result;
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
  const [result] = await db
    .update(payments)
    .set(payment)
    .where(eq(payments.id, id))
    .returning();
  return result;
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
  await db.delete(payments).where(eq(payments.id, id));
}

export async function createPaymentSchedule(schedule: InsertPaymentSchedule): Promise<PaymentSchedule> {
  const [result] = await db.insert(paymentSchedules).values(schedule).returning();
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
  const [updated] = await db
    .update(paymentSchedules)
    .set(fields)
    .where(eq(paymentSchedules.id, id))
    .returning();
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
