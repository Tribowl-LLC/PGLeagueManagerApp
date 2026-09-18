import { and, asc, eq, gte, gt, inArray, lte, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db.js";
import { env, isProdLike, isSingletonOrganizationMode } from "../config.js";
import type { AccountActionExecutor } from "./account-action-requests.js";
import {
  ACCOUNT_READY_DELIVERY_CLEANUP_BATCH_SIZE,
  ACCOUNT_READY_DELIVERY_LEASE_MS,
  ACCOUNT_READY_DELIVERY_MAX_ATTEMPTS,
  ACCOUNT_READY_DELIVERY_MAX_RETRY_DELAY_MS,
  ACCOUNT_READY_DELIVERY_RETENTION_MS,
  accountReadyDeliveryJobs,
  type AccountReadyDeliveryJob,
} from "@shared/schema/account-ready-delivery-jobs";

export type AccountReadyDeliveryExecutor = AccountActionExecutor;

export class AccountReadyDeliveryInProgressError extends Error {
  constructor() {
    super("Account-ready delivery is already in progress");
    this.name = "AccountReadyDeliveryInProgressError";
  }
}

export type AccountReadyEnqueueResult =
  | { kind: "enqueued"; job: AccountReadyDeliveryJob }
  | { kind: "existing"; job: AccountReadyDeliveryJob };

export type AccountReadyDeliveryFinalization =
  | { status: "succeeded"; providerMessageId?: string | null }
  | { status: "retry_scheduled"; errorCode: string; retryAfterMs: number }
  | { status: "failed"; errorCode: string }
  | { status: "suppressed"; reason: string };

const ACTIVE_STATUSES = ["pending", "processing", "retry_scheduled"] as const;
const configuredOrganizationId = env.APP_ORGANIZATION_ID;
const SINGLETON_ORGANIZATION_SCOPE = isProdLike && configuredOrganizationId === undefined
  ? sql`false`
  : configuredOrganizationId === undefined
  ? undefined
  : eq(accountReadyDeliveryJobs.organizationId, configuredOrganizationId);

export async function queueAccountReadyDeliveryJob(input: {
  identityLinkEventId: number;
  userId: number;
  bowlerId: number;
  organizationId: number;
  expiresAt?: Date;
  standaloneDeliveryRequested?: boolean;
}, executor?: AccountReadyDeliveryExecutor): Promise<AccountReadyEnqueueResult> {
  const expiresAt = input.expiresAt ?? new Date(Date.now() + ACCOUNT_READY_DELIVERY_RETENTION_MS);
  if (
    !Number.isSafeInteger(input.identityLinkEventId) || input.identityLinkEventId <= 0
    || !Number.isSafeInteger(input.userId) || input.userId <= 0
    || !Number.isSafeInteger(input.bowlerId) || input.bowlerId <= 0
    || !Number.isSafeInteger(input.organizationId) || input.organizationId <= 0
    || !Number.isFinite(expiresAt.getTime())
    || expiresAt.getTime() <= Date.now()
  ) {
    throw new Error("Invalid account-ready delivery job input");
  }
  if (
    (isProdLike && configuredOrganizationId === undefined)
    || (isSingletonOrganizationMode && input.organizationId !== configuredOrganizationId)
  ) {
    throw new Error("Account-ready delivery job organization does not match the configured business");
  }

  const run = async (tx: AccountReadyDeliveryExecutor): Promise<AccountReadyEnqueueResult> => {
    const [inserted] = await tx
      .insert(accountReadyDeliveryJobs)
      .values({
        identityLinkEventId: input.identityLinkEventId,
        userId: input.userId,
        bowlerId: input.bowlerId,
        organizationId: input.organizationId,
        standaloneDeliveryRequested: input.standaloneDeliveryRequested ?? false,
        expiresAt: expiresAt.toISOString(),
      })
      .onConflictDoNothing({ target: accountReadyDeliveryJobs.identityLinkEventId })
      .returning();
    if (inserted) return { kind: "enqueued", job: inserted };

    const [existing] = await tx
      .select()
      .from(accountReadyDeliveryJobs)
      .where(eq(accountReadyDeliveryJobs.identityLinkEventId, input.identityLinkEventId))
      .limit(1);
    if (!existing) throw new Error("Account-ready delivery job was not created");
    return { kind: "existing", job: existing };
  };

  if (executor) {
    return "transaction" in executor ? executor.transaction(run) : run(executor);
  }
  return db.transaction(run);
}

/**
 * Re-open the latest account-ready intent for an explicit administrator
 * resend. This preserves the immutable identity-link event while resetting
 * only the delivery lifecycle; the worker still revalidates that the event
 * remains the user's current link before sending.
 */
export async function requeueAccountReadyDeliveryJob(input: {
  identityLinkEventId: number;
}): Promise<AccountReadyDeliveryJob | undefined> {
  if (!Number.isSafeInteger(input.identityLinkEventId) || input.identityLinkEventId <= 0) {
    throw new Error("Invalid account-ready identity-link event ID");
  }
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(accountReadyDeliveryJobs)
      .where(eq(accountReadyDeliveryJobs.identityLinkEventId, input.identityLinkEventId))
      .limit(1)
      .for("update");
    if (!existing) return undefined;
    if (
      existing.status === "processing"
      && existing.leaseExpiresAt
      && Date.parse(existing.leaseExpiresAt) > Date.now()
    ) {
      throw new AccountReadyDeliveryInProgressError();
    }
    const [requeued] = await tx
      .update(accountReadyDeliveryJobs)
      .set({
        status: "pending",
        standaloneDeliveryRequested: true,
        attemptCount: 0,
        nextAttemptAt: new Date().toISOString(),
        lastAttemptAt: null,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        providerMessageId: null,
        lastErrorCode: null,
        expiresAt: new Date(Date.now() + ACCOUNT_READY_DELIVERY_RETENTION_MS).toISOString(),
        completedAt: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(accountReadyDeliveryJobs.id, existing.id))
      .returning();
    return requeued;
  });
}

/** Earliest account-ready intent or lease-recovery due time for the scheduler. */
export async function getNextAccountReadyDeliveryAt(): Promise<Date | null> {
  const [row] = await db
    .select({
      nextAttemptAt: sql<string>`CASE
        WHEN ${accountReadyDeliveryJobs.status} = 'processing'
          THEN ${accountReadyDeliveryJobs.leaseExpiresAt}
        ELSE ${accountReadyDeliveryJobs.nextAttemptAt}
      END`,
    })
    .from(accountReadyDeliveryJobs)
    .where(and(
      inArray(accountReadyDeliveryJobs.status, [...ACTIVE_STATUSES]),
      sql`(${accountReadyDeliveryJobs.status} = 'processing' OR ${accountReadyDeliveryJobs.attemptCount} < ${ACCOUNT_READY_DELIVERY_MAX_ATTEMPTS})`,
      gt(accountReadyDeliveryJobs.expiresAt, sql`now()`),
      SINGLETON_ORGANIZATION_SCOPE,
    ))
    .orderBy(sql`CASE
      WHEN ${accountReadyDeliveryJobs.status} = 'processing'
        THEN ${accountReadyDeliveryJobs.leaseExpiresAt}
      ELSE ${accountReadyDeliveryJobs.nextAttemptAt}
    END`, asc(accountReadyDeliveryJobs.id))
    .limit(1);
  if (!row?.nextAttemptAt) return null;
  const result = new Date(row.nextAttemptAt);
  if (!Number.isFinite(result.getTime())) {
    throw new Error("Invalid account-ready delivery due timestamp");
  }
  return result;
}

export interface ClaimedAccountReadyDeliveryJob {
  job: AccountReadyDeliveryJob;
  leaseToken: string;
}

export async function claimNextAccountReadyDeliveryJob(
  options: { workerId?: string } = {},
): Promise<ClaimedAccountReadyDeliveryJob | undefined> {
  const workerId = options.workerId ?? `account-ready-worker:${randomUUID()}`;
  if (workerId.length < 1 || workerId.length > 255) {
    throw new Error("Invalid account-ready delivery worker ID");
  }

  return db.transaction(async (tx) => {
    const candidates = await tx.execute<{ id: number }>(sql`
      SELECT id
      FROM account_ready_delivery_jobs
      WHERE (
        (status IN ('pending', 'retry_scheduled') AND next_attempt_at <= now())
        OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= now())
      )
        AND attempt_count < ${ACCOUNT_READY_DELIVERY_MAX_ATTEMPTS}
        ${isProdLike && configuredOrganizationId === undefined
          ? sql`AND false`
          : isSingletonOrganizationMode
          ? sql`AND organization_id = ${configuredOrganizationId}`
          : sql``}
      ORDER BY next_attempt_at ASC, created_at ASC, id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);
    const id = candidates.rows[0]?.id;
    if (!id) return undefined;
    const leaseToken = randomUUID();
    const [job] = await tx
      .update(accountReadyDeliveryJobs)
      .set({
        status: "processing",
        attemptCount: sql`${accountReadyDeliveryJobs.attemptCount} + 1`,
        lastAttemptAt: sql`now()`,
        leaseOwner: workerId,
        leaseToken,
        leaseExpiresAt: sql`now() + (${Math.ceil(ACCOUNT_READY_DELIVERY_LEASE_MS / 1000)} || ' seconds')::interval`,
        updatedAt: sql`now()`,
      })
      .where(eq(accountReadyDeliveryJobs.id, id))
      .returning();
    return job ? { job, leaseToken } : undefined;
  });
}

/** Recover expired work and bound terminal-row retention. */
export async function recoverAccountReadyDeliveryJobs(): Promise<number> {
  return db.transaction(async (tx) => {
    const expired = await tx
      .update(accountReadyDeliveryJobs)
      .set({
        status: "failed",
        lastErrorCode: "intent_expired",
        completedAt: sql`now()`,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: sql`now()`,
      })
      .where(and(
        inArray(accountReadyDeliveryJobs.status, [...ACTIVE_STATUSES]),
        lte(accountReadyDeliveryJobs.expiresAt, sql`now()`),
        sql`(${accountReadyDeliveryJobs.status} <> 'processing' OR ${accountReadyDeliveryJobs.leaseExpiresAt} <= now())`,
        SINGLETON_ORGANIZATION_SCOPE,
      ))
      .returning({ id: accountReadyDeliveryJobs.id });

    const exhausted = await tx
      .update(accountReadyDeliveryJobs)
      .set({
        status: "failed",
        lastErrorCode: "max_attempts_exhausted",
        completedAt: sql`now()`,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: sql`now()`,
      })
      .where(and(
        inArray(accountReadyDeliveryJobs.status, [...ACTIVE_STATUSES]),
        gte(accountReadyDeliveryJobs.attemptCount, ACCOUNT_READY_DELIVERY_MAX_ATTEMPTS),
        sql`(${accountReadyDeliveryJobs.status} <> 'processing' OR ${accountReadyDeliveryJobs.leaseExpiresAt} <= now())`,
        SINGLETON_ORGANIZATION_SCOPE,
      ))
      .returning({ id: accountReadyDeliveryJobs.id });

    const cleanup = await tx.execute(sql`
      DELETE FROM account_ready_delivery_jobs
      WHERE id IN (
        SELECT id
        FROM account_ready_delivery_jobs
        WHERE status IN ('succeeded', 'failed', 'suppressed')
          AND completed_at <= now() - (${Math.ceil(ACCOUNT_READY_DELIVERY_RETENTION_MS / 1000)} || ' seconds')::interval
        ORDER BY completed_at ASC, id ASC
        LIMIT ${ACCOUNT_READY_DELIVERY_CLEANUP_BATCH_SIZE}
      )
    `);
    return expired.length + exhausted.length + Number(cleanup.rowCount ?? 0);
  });
}

export async function finalizeAccountReadyDeliveryJob(input: {
  jobId: number;
  leaseToken: string;
  outcome: AccountReadyDeliveryFinalization;
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .select({
        id: accountReadyDeliveryJobs.id,
        attemptCount: accountReadyDeliveryJobs.attemptCount,
        expiresAt: accountReadyDeliveryJobs.expiresAt,
      })
      .from(accountReadyDeliveryJobs)
      .where(and(
        eq(accountReadyDeliveryJobs.id, input.jobId),
        eq(accountReadyDeliveryJobs.status, "processing"),
        eq(accountReadyDeliveryJobs.leaseToken, input.leaseToken),
      ))
      .for("update");
    if (!claimed) return false;

    const common = {
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: sql`now()`,
    } as const;
    if (input.outcome.status === "succeeded") {
      const [updated] = await tx
        .update(accountReadyDeliveryJobs)
        .set({
          ...common,
          status: "succeeded",
          providerMessageId: input.outcome.providerMessageId ?? null,
          completedAt: sql`now()`,
        })
        .where(and(
          eq(accountReadyDeliveryJobs.id, input.jobId),
          eq(accountReadyDeliveryJobs.status, "processing"),
          eq(accountReadyDeliveryJobs.leaseToken, input.leaseToken),
        ))
        .returning({ id: accountReadyDeliveryJobs.id });
      return updated !== undefined;
    }

    if (input.outcome.status === "retry_scheduled") {
      const retryAllowed = claimed.attemptCount < ACCOUNT_READY_DELIVERY_MAX_ATTEMPTS
        && Date.parse(claimed.expiresAt) > Date.now();
      if (retryAllowed) {
        const retryAfterMs = Math.min(
          Math.max(0, input.outcome.retryAfterMs),
          ACCOUNT_READY_DELIVERY_MAX_RETRY_DELAY_MS,
        );
        const [updated] = await tx
          .update(accountReadyDeliveryJobs)
          .set({
            ...common,
            status: "retry_scheduled",
            lastErrorCode: input.outcome.errorCode,
            nextAttemptAt: sql`now() + (${Math.ceil(retryAfterMs / 1000)} || ' seconds')::interval`,
          })
          .where(and(
            eq(accountReadyDeliveryJobs.id, input.jobId),
            eq(accountReadyDeliveryJobs.status, "processing"),
            eq(accountReadyDeliveryJobs.leaseToken, input.leaseToken),
          ))
          .returning({ id: accountReadyDeliveryJobs.id });
        return updated !== undefined;
      }
    }

    const terminalStatus = input.outcome.status === "suppressed" ? "suppressed" : "failed";
    const lastErrorCode = input.outcome.status === "suppressed"
      ? input.outcome.reason
      : input.outcome.errorCode;
    const [updated] = await tx
      .update(accountReadyDeliveryJobs)
      .set({
        ...common,
        status: terminalStatus,
        lastErrorCode,
        completedAt: sql`now()`,
      })
      .where(and(
        eq(accountReadyDeliveryJobs.id, input.jobId),
        eq(accountReadyDeliveryJobs.status, "processing"),
        eq(accountReadyDeliveryJobs.leaseToken, input.leaseToken),
      ))
      .returning({ id: accountReadyDeliveryJobs.id });
    return updated !== undefined;
  });
}

export async function getAccountReadyDeliveryJob(jobId: number): Promise<AccountReadyDeliveryJob | undefined> {
  const [job] = await db
    .select()
    .from(accountReadyDeliveryJobs)
    .where(eq(accountReadyDeliveryJobs.id, jobId))
    .limit(1);
  return job;
}
