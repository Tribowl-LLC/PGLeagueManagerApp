import { and, asc, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db.js";
import { env, isProdLike, isSingletonOrganizationMode } from "../config.js";
import type { AccountActionExecutor } from "./account-action-requests.js";
import {
  ACCOUNT_GUIDANCE_DELIVERY_CLEANUP_BATCH_SIZE,
  ACCOUNT_GUIDANCE_DELIVERY_COOLDOWN_MS,
  ACCOUNT_GUIDANCE_DELIVERY_LEASE_MS,
  ACCOUNT_GUIDANCE_DELIVERY_MAX_ATTEMPTS,
  ACCOUNT_GUIDANCE_DELIVERY_MAX_RETRY_DELAY_MS,
  ACCOUNT_GUIDANCE_DELIVERY_RETENTION_MS,
  ACCOUNT_GUIDANCE_DELIVERY_ROLLING_CAP,
  ACCOUNT_GUIDANCE_DELIVERY_ROLLING_WINDOW_MS,
  accountGuidanceDeliveryJobs,
  type AccountGuidanceDeliveryJob,
  type AccountGuidanceNoticeType,
} from "@shared/schema/account-guidance-delivery-jobs";

export type AccountGuidanceDeliveryExecutor = AccountActionExecutor;

export type AccountGuidanceEnqueueResult =
  | { kind: "enqueued"; job: AccountGuidanceDeliveryJob }
  | { kind: "suppressed"; reason: "cooldown" | "hourly_cap" | "active" };

export type AccountGuidanceDeliveryFinalization =
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
  : eq(accountGuidanceDeliveryJobs.organizationId, configuredOrganizationId);

function normalizeRecipientEmail(email: string): string {
  return email.trim().toLowerCase();
}

function assertRecipientEmail(email: string): string {
  const normalized = normalizeRecipientEmail(email);
  if (
    normalized.length === 0
    || normalized.length > 320
    || !/^[^\s@]+@[^\s@]+$/.test(normalized)
  ) {
    throw new Error("A valid recipient email is required for account guidance delivery");
  }
  return normalized;
}

/**
 * Enqueue one non-secret notice while holding a transaction advisory lock for
 * the normalized recipient. The lock makes the cooldown and rolling cap
 * atomic across app replicas and across both public endpoints.
 */
export async function enqueueAccountGuidanceNotice(input: {
  recipientEmail: string;
  noticeType: AccountGuidanceNoticeType;
  userId?: number | null;
  organizationId?: number | null;
  expiresAt?: Date;
}, executor?: AccountGuidanceDeliveryExecutor): Promise<AccountGuidanceEnqueueResult> {
  const recipientEmail = assertRecipientEmail(input.recipientEmail);
  const expiresAt = input.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    throw new Error("Account guidance notice expiry must be in the future");
  }
  if (
    (isProdLike && configuredOrganizationId === undefined)
    || (isSingletonOrganizationMode
    && input.organizationId !== undefined
    && input.organizationId !== null
    && input.organizationId !== configuredOrganizationId)
  ) {
    throw new Error("Account guidance job organization does not match the configured business");
  }

  const run = async (tx: AccountGuidanceDeliveryExecutor): Promise<AccountGuidanceEnqueueResult> => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`account-guidance:${recipientEmail}`}))`);

    const [latest] = await tx
      .select({ createdAt: accountGuidanceDeliveryJobs.createdAt })
      .from(accountGuidanceDeliveryJobs)
      .where(eq(accountGuidanceDeliveryJobs.recipientEmail, recipientEmail))
      .orderBy(desc(accountGuidanceDeliveryJobs.createdAt), desc(accountGuidanceDeliveryJobs.id))
      .limit(1);
    if (latest && Date.parse(latest.createdAt) > Date.now() - ACCOUNT_GUIDANCE_DELIVERY_COOLDOWN_MS) {
      return { kind: "suppressed", reason: "cooldown" };
    }

    const [rolling] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(accountGuidanceDeliveryJobs)
      .where(and(
        eq(accountGuidanceDeliveryJobs.recipientEmail, recipientEmail),
        gt(accountGuidanceDeliveryJobs.createdAt, new Date(Date.now() - ACCOUNT_GUIDANCE_DELIVERY_ROLLING_WINDOW_MS).toISOString()),
      ));
    if ((rolling?.count ?? 0) >= ACCOUNT_GUIDANCE_DELIVERY_ROLLING_CAP) {
      return { kind: "suppressed", reason: "hourly_cap" };
    }

    const [active] = await tx
      .select({ id: accountGuidanceDeliveryJobs.id })
      .from(accountGuidanceDeliveryJobs)
      .where(and(
        eq(accountGuidanceDeliveryJobs.recipientEmail, recipientEmail),
        inArray(accountGuidanceDeliveryJobs.status, [...ACTIVE_STATUSES]),
      ))
      .limit(1);
    if (active) return { kind: "suppressed", reason: "active" };

    const [job] = await tx
      .insert(accountGuidanceDeliveryJobs)
      .values({
        recipientEmail,
        noticeType: input.noticeType,
        userId: input.userId ?? null,
        organizationId: input.organizationId ?? null,
        expiresAt: expiresAt.toISOString(),
      })
      .returning();
    if (!job) throw new Error("Account guidance delivery job was not created");
    return { kind: "enqueued", job };
  };

  if (executor) {
    return "transaction" in executor ? executor.transaction(run) : run(executor);
  }
  return db.transaction(run);
}

/** Earliest guidance intent or lease recovery due time for the shared scheduler. */
export async function getNextAccountGuidanceDeliveryAt(): Promise<Date | null> {
  const [row] = await db
    .select({
      nextAttemptAt: sql<string>`CASE
        WHEN ${accountGuidanceDeliveryJobs.status} = 'processing'
          THEN ${accountGuidanceDeliveryJobs.leaseExpiresAt}
        ELSE ${accountGuidanceDeliveryJobs.nextAttemptAt}
      END`,
    })
    .from(accountGuidanceDeliveryJobs)
    .where(and(
      inArray(accountGuidanceDeliveryJobs.status, [...ACTIVE_STATUSES]),
      lte(accountGuidanceDeliveryJobs.attemptCount, ACCOUNT_GUIDANCE_DELIVERY_MAX_ATTEMPTS - 1),
      gt(accountGuidanceDeliveryJobs.expiresAt, sql`now()`),
      SINGLETON_ORGANIZATION_SCOPE,
    ))
    .orderBy(sql`CASE
      WHEN ${accountGuidanceDeliveryJobs.status} = 'processing'
        THEN ${accountGuidanceDeliveryJobs.leaseExpiresAt}
      ELSE ${accountGuidanceDeliveryJobs.nextAttemptAt}
    END`, asc(accountGuidanceDeliveryJobs.id))
    .limit(1);
  if (!row?.nextAttemptAt) return null;
  const result = new Date(row.nextAttemptAt);
  if (!Number.isFinite(result.getTime())) throw new Error("Invalid account guidance delivery due timestamp");
  return result;
}

export interface ClaimedAccountGuidanceDeliveryJob {
  job: AccountGuidanceDeliveryJob;
  leaseToken: string;
}

export async function claimNextAccountGuidanceDeliveryJob(
  options: { workerId?: string } = {},
): Promise<ClaimedAccountGuidanceDeliveryJob | undefined> {
  const workerId = options.workerId ?? `account-guidance-worker:${randomUUID()}`;
  if (workerId.length < 1 || workerId.length > 255) throw new Error("Invalid guidance delivery worker ID");

  return db.transaction(async (tx) => {
    const candidates = await tx.execute<{ id: number }>(sql`
      SELECT id
      FROM account_guidance_delivery_jobs
      WHERE (
        (status IN ('pending', 'retry_scheduled') AND next_attempt_at <= now())
        OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= now())
      )
        AND attempt_count < ${ACCOUNT_GUIDANCE_DELIVERY_MAX_ATTEMPTS}
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
      .update(accountGuidanceDeliveryJobs)
      .set({
        status: "processing",
        attemptCount: sql`${accountGuidanceDeliveryJobs.attemptCount} + 1`,
        lastAttemptAt: sql`now()`,
        leaseOwner: workerId,
        leaseToken,
        leaseExpiresAt: sql`now() + (${Math.ceil(ACCOUNT_GUIDANCE_DELIVERY_LEASE_MS / 1000)} || ' seconds')::interval`,
        updatedAt: sql`now()`,
      })
      .where(eq(accountGuidanceDeliveryJobs.id, id))
      .returning();
    return job ? { job, leaseToken } : undefined;
  });
}

/** Recover expired intents and cap terminal-row retention without deleting active work. */
export async function recoverAccountGuidanceDeliveryJobs(): Promise<number> {
  const result = await db.transaction(async (tx) => {
    const expired = await tx
      .update(accountGuidanceDeliveryJobs)
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
        inArray(accountGuidanceDeliveryJobs.status, [...ACTIVE_STATUSES]),
        lte(accountGuidanceDeliveryJobs.expiresAt, sql`now()`),
        sql`(${accountGuidanceDeliveryJobs.status} <> 'processing' OR ${accountGuidanceDeliveryJobs.leaseExpiresAt} <= now())`,
        SINGLETON_ORGANIZATION_SCOPE,
      ))
      .returning({ id: accountGuidanceDeliveryJobs.id });

    const exhausted = await tx
      .update(accountGuidanceDeliveryJobs)
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
        inArray(accountGuidanceDeliveryJobs.status, [...ACTIVE_STATUSES]),
        gteAttemptCount(),
        sql`(${accountGuidanceDeliveryJobs.status} <> 'processing' OR ${accountGuidanceDeliveryJobs.leaseExpiresAt} <= now())`,
        SINGLETON_ORGANIZATION_SCOPE,
      ))
      .returning({ id: accountGuidanceDeliveryJobs.id });

    const cleanup = await tx.execute(sql`
      DELETE FROM account_guidance_delivery_jobs
      WHERE id IN (
        SELECT id
        FROM account_guidance_delivery_jobs
        WHERE status IN ('succeeded', 'failed', 'suppressed')
          AND completed_at <= now() - (${Math.ceil(ACCOUNT_GUIDANCE_DELIVERY_RETENTION_MS / 1000)} || ' seconds')::interval
        ORDER BY completed_at ASC, id ASC
        LIMIT ${ACCOUNT_GUIDANCE_DELIVERY_CLEANUP_BATCH_SIZE}
      )
    `);
    return expired.length + exhausted.length + Number(cleanup.rowCount ?? 0);
  });
  return result;
}

function gteAttemptCount() {
  return sql`${accountGuidanceDeliveryJobs.attemptCount} >= ${ACCOUNT_GUIDANCE_DELIVERY_MAX_ATTEMPTS}`;
}

export async function finalizeAccountGuidanceDeliveryJob(input: {
  jobId: number;
  leaseToken: string;
  outcome: AccountGuidanceDeliveryFinalization;
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .select({
        id: accountGuidanceDeliveryJobs.id,
        attemptCount: accountGuidanceDeliveryJobs.attemptCount,
        expiresAt: accountGuidanceDeliveryJobs.expiresAt,
      })
      .from(accountGuidanceDeliveryJobs)
      .where(and(
        eq(accountGuidanceDeliveryJobs.id, input.jobId),
        eq(accountGuidanceDeliveryJobs.status, "processing"),
        eq(accountGuidanceDeliveryJobs.leaseToken, input.leaseToken),
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
        .update(accountGuidanceDeliveryJobs)
        .set({
          ...common,
          status: "succeeded",
          providerMessageId: input.outcome.providerMessageId ?? null,
          completedAt: sql`now()`,
        })
        .where(and(
          eq(accountGuidanceDeliveryJobs.id, input.jobId),
          eq(accountGuidanceDeliveryJobs.status, "processing"),
          eq(accountGuidanceDeliveryJobs.leaseToken, input.leaseToken),
        ))
        .returning({ id: accountGuidanceDeliveryJobs.id });
      return updated !== undefined;
    }

    if (input.outcome.status === "retry_scheduled") {
      const retryAllowed = claimed.attemptCount < ACCOUNT_GUIDANCE_DELIVERY_MAX_ATTEMPTS
        && Date.parse(claimed.expiresAt) > Date.now();
      if (retryAllowed) {
        const retryAfterMs = Math.min(
          Math.max(0, input.outcome.retryAfterMs),
          ACCOUNT_GUIDANCE_DELIVERY_MAX_RETRY_DELAY_MS,
        );
        const [updated] = await tx
          .update(accountGuidanceDeliveryJobs)
          .set({
            ...common,
            status: "retry_scheduled",
            lastErrorCode: input.outcome.errorCode,
            nextAttemptAt: sql`now() + (${Math.ceil(retryAfterMs / 1000)} || ' seconds')::interval`,
          })
          .where(and(
            eq(accountGuidanceDeliveryJobs.id, input.jobId),
            eq(accountGuidanceDeliveryJobs.status, "processing"),
            eq(accountGuidanceDeliveryJobs.leaseToken, input.leaseToken),
          ))
          .returning({ id: accountGuidanceDeliveryJobs.id });
        return updated !== undefined;
      }
    }

    const terminalStatus = input.outcome.status === "suppressed" ? "suppressed" : "failed";
    const lastErrorCode = input.outcome.status === "suppressed"
      ? input.outcome.reason
      : input.outcome.errorCode;
    const [updated] = await tx
      .update(accountGuidanceDeliveryJobs)
      .set({
        ...common,
        status: terminalStatus,
        lastErrorCode,
        completedAt: sql`now()`,
      })
      .where(and(
        eq(accountGuidanceDeliveryJobs.id, input.jobId),
        eq(accountGuidanceDeliveryJobs.status, "processing"),
        eq(accountGuidanceDeliveryJobs.leaseToken, input.leaseToken),
      ))
      .returning({ id: accountGuidanceDeliveryJobs.id });
    return updated !== undefined;
  });
}

export async function getAccountGuidanceDeliveryJob(jobId: number): Promise<AccountGuidanceDeliveryJob | undefined> {
  const [job] = await db
    .select()
    .from(accountGuidanceDeliveryJobs)
    .where(eq(accountGuidanceDeliveryJobs.id, jobId))
    .limit(1);
  return job;
}
