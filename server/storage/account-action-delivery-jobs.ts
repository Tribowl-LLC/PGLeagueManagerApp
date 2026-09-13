import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { AccountActionDeliveryJob } from "@shared/schema/account-action-delivery-jobs";
import {
  accountActionDeliveryJobs,
  ACCOUNT_ACTION_DELIVERY_LEASE_MS,
  ACCOUNT_ACTION_DELIVERY_MAX_ATTEMPTS,
  ACCOUNT_ACTION_DELIVERY_MAX_RETRY_DELAY_MS,
  type AccountActionDeliveryJobStatus,
} from "@shared/schema/account-action-delivery-jobs";
import { accountActionRequests } from "@shared/schema/account-action-requests";
import { users } from "@shared/schema/users";
import { db } from "../db.js";
import {
  getAccountActionPendingState,
  lockAccountCredential,
  ACCOUNT_REGISTRATION_PENDING_CAP,
  PASSWORD_RESET_PENDING_CAP,
  type AccountActionExecutor,
} from "./account-action-requests.js";

export type AccountActionDeliveryJobExecutor = AccountActionExecutor;

export type AccountActionDeliveryAction = "password_reset" | "account_registration";

const ACTIVE_JOB_STATUSES = ["pending", "processing", "retry_scheduled"] as const;

export type PasswordResetDeliveryEnqueueSuppressionReason =
  | "user_missing"
  | "stale_credential"
  | "at_capacity"
  | "recently_delivered"
  | "active_job"
  | "account_not_pending";
export type AccountRegistrationDeliveryEnqueueSuppressionReason =
  | PasswordResetDeliveryEnqueueSuppressionReason;

export type PasswordResetDeliveryEnqueueResult =
  | { kind: "enqueued"; job: AccountActionDeliveryJob }
  | { kind: "suppressed"; reason: PasswordResetDeliveryEnqueueSuppressionReason };

export interface EnqueuePasswordResetDeliveryInput {
  userId: number;
  organizationId?: number | null;
  /** Snapshot of the credential generation at public-request time. */
  credentialGeneration?: number;
  /** The intent deadline, normally the same one-hour window as the action. */
  expiresAt: Date;
  /** Optional action kind; omitted callers retain password-reset behavior. */
  action?: AccountActionDeliveryAction;
}

function assertPositiveUserId(userId: number): void {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error("A positive user ID is required for password-reset delivery");
  }
}

function assertFutureDate(value: Date, label: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()) || value.getTime() <= Date.now()) {
    throw new Error(`${label} must be a valid future timestamp`);
  }
}

async function runInTransaction<T>(
  executor: AccountActionDeliveryJobExecutor | undefined,
  callback: (tx: AccountActionDeliveryJobExecutor) => Promise<T>,
): Promise<T> {
  if (executor) {
    return "transaction" in executor
      ? executor.transaction(callback)
      : callback(executor);
  }
  return db.transaction(callback);
}

/**
 * Persist a non-secret password-reset intent. The credential lock protects
 * coalescing, lazy expiry, and the three-link cap across application replicas.
 */
export async function enqueuePasswordResetDelivery(
  input: EnqueuePasswordResetDeliveryInput,
  executor?: AccountActionDeliveryJobExecutor,
): Promise<PasswordResetDeliveryEnqueueResult> {
  const action = input.action ?? "password_reset";
  assertPositiveUserId(input.userId);
  assertFutureDate(input.expiresAt, "Password-reset delivery expiry");
  if (
    input.credentialGeneration !== undefined
    && (!Number.isSafeInteger(input.credentialGeneration) || input.credentialGeneration < 0)
  ) {
    throw new Error("Credential generation must be a non-negative safe integer");
  }

  return runInTransaction(executor, async (tx) => {
    await lockAccountCredential(tx, input.userId);
    // Hold the authoritative user row lock before mutating any action rows.
    // Credential updates run a BEFORE UPDATE trigger that revokes those rows;
    // using the same user -> action order here avoids a cross-transaction
    // lock inversion and lets an omitted snapshot use the current generation.
    const [lockedUser] = await tx
      .select({
        id: users.id,
        role: users.role,
        organizationId: users.organizationId,
        bowlerId: users.bowlerId,
        credentialGeneration: users.credentialGeneration,
      })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1)
      .for("update");
    if (!lockedUser) return { kind: "suppressed", reason: "user_missing" };
    const effectiveCredentialGeneration = input.credentialGeneration ?? lockedUser.credentialGeneration;
    if (effectiveCredentialGeneration !== lockedUser.credentialGeneration) {
      return { kind: "suppressed", reason: "stale_credential" };
    }
    if (
      action === "account_registration"
      && (
        lockedUser.role !== "user"
        || lockedUser.organizationId !== (input.organizationId ?? null)
      )
    ) {
      return { kind: "suppressed", reason: "account_not_pending" };
    }

    // A credential trigger revokes the action rows, but the durable intent is
    // intentionally a separate table. Retire an old-generation active intent
    // before checking coalescing, otherwise a later request could be hidden
    // behind work that can never safely mint a token.
    await tx
      .update(accountActionDeliveryJobs)
      .set({
        status: "suppressed",
        lastErrorCode: "stale_credential",
        completedAt: sql`now()`,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: sql`now()`,
      })
      .where(and(
        eq(accountActionDeliveryJobs.userId, input.userId),
        eq(accountActionDeliveryJobs.action, action),
        inArray(accountActionDeliveryJobs.status, ACTIVE_JOB_STATUSES),
        ne(accountActionDeliveryJobs.credentialGeneration, lockedUser.credentialGeneration),
      ));

    const pendingState = await getAccountActionPendingState({
      userId: input.userId,
      action,
    }, tx);
    if (pendingState.pendingCount >= (action === "account_registration"
      ? ACCOUNT_REGISTRATION_PENDING_CAP
      : PASSWORD_RESET_PENDING_CAP)) {
      return { kind: "suppressed", reason: "at_capacity" };
    }
    if (pendingState.recentlyDelivered) {
      return { kind: "suppressed", reason: "recently_delivered" };
    }

    // The active-job uniqueness predicate intentionally covers all active
    // states, including rows whose deadline has passed. Retire those rows
    // under the same account lock before inserting so a stale intent cannot
    // block a fresh request with a unique-index conflict.
    await tx
      .update(accountActionDeliveryJobs)
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
        eq(accountActionDeliveryJobs.userId, input.userId),
        eq(accountActionDeliveryJobs.action, action),
        inArray(accountActionDeliveryJobs.status, ACTIVE_JOB_STATUSES),
        lte(accountActionDeliveryJobs.expiresAt, sql`now()`),
      ));

    const [active] = await tx
      .select({ id: accountActionDeliveryJobs.id })
      .from(accountActionDeliveryJobs)
      .where(and(
        eq(accountActionDeliveryJobs.userId, input.userId),
        eq(accountActionDeliveryJobs.action, action),
        inArray(accountActionDeliveryJobs.status, ACTIVE_JOB_STATUSES),
        gt(accountActionDeliveryJobs.expiresAt, sql`now()`),
      ))
      .orderBy(asc(accountActionDeliveryJobs.createdAt), asc(accountActionDeliveryJobs.id))
      .limit(1);
    if (active) return { kind: "suppressed", reason: "active_job" };

    const [job] = await tx
      .insert(accountActionDeliveryJobs)
      .values({
        userId: input.userId,
        organizationId: input.organizationId ?? null,
        action,
        credentialGeneration: effectiveCredentialGeneration,
        expiresAt: input.expiresAt.toISOString(),
        status: "pending",
        attemptCount: 0,
        nextAttemptAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .returning();
    if (!job) throw new Error(`${action} delivery job was not created`);
    return { kind: "enqueued", job };
  });
}

export interface EnqueueAccountRegistrationDeliveryInput {
  userId: number;
  organizationId: number;
  credentialGeneration: number;
  expiresAt: Date;
}

export type AccountRegistrationDeliveryEnqueueResult =
  | { kind: "enqueued"; job: AccountActionDeliveryJob }
  | { kind: "suppressed"; reason: AccountRegistrationDeliveryEnqueueSuppressionReason };

export function enqueueAccountRegistrationDelivery(
  input: EnqueueAccountRegistrationDeliveryInput,
  executor?: AccountActionDeliveryJobExecutor,
): Promise<AccountRegistrationDeliveryEnqueueResult> {
  return enqueuePasswordResetDelivery({ ...input, action: "account_registration" }, executor);
}

export interface ResumePendingAccountRegistrationInput {
  email: string;
  organizationId: number;
  expiresAt: Date;
}

export interface ResumedPendingAccountRegistration {
  user: typeof users.$inferSelect;
  delivery: AccountRegistrationDeliveryEnqueueResult;
}

/**
 * Recover the narrow anonymous capability for a pending registration after a
 * browser loses its session. The established credential advisory lock is
 * acquired before the authoritative user-row lock, and the durable-origin,
 * generation, and enqueue checks share that transaction so an administrator
 * role/org change cannot race a resend.
 *
 * This intentionally does not inspect or update the submitted name, phone,
 * email, password, or bowler link. Legacy accounts and completed actions have
 * no current-generation registration origin and therefore return undefined.
 */
export async function resumePendingAccountRegistration(
  input: ResumePendingAccountRegistrationInput,
): Promise<ResumedPendingAccountRegistration | undefined> {
  const email = input.email.trim().toLowerCase();
  if (!email || !Number.isSafeInteger(input.organizationId) || input.organizationId <= 0) {
    throw new Error("A valid registration email and organization are required");
  }
  assertFutureDate(input.expiresAt, "Account-registration delivery expiry");

  return db.transaction(async (tx) => {
    // Read only the scoped candidate ID first. All credential-sensitive paths
    // acquire the advisory lock before the user row lock; the authoritative
    // re-read below closes the role/org/email race without inverting the
    // established user -> action lock order.
    const [candidateId] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(
        eq(users.organizationId, input.organizationId),
        eq(users.role, "user"),
        sql`lower(btrim(${users.email})) = ${email}`,
      ))
      .limit(1);
    if (!candidateId) return undefined;

    await lockAccountCredential(tx, candidateId.id);
    const [candidate] = await tx
      .select()
      .from(users)
      .where(and(
        eq(users.id, candidateId.id),
        eq(users.organizationId, input.organizationId),
        eq(users.role, "user"),
        sql`lower(btrim(${users.email})) = ${email}`,
      ))
      .limit(1)
      .for("update");
    if (!candidate) return undefined;

    const [origin] = await tx
      .select({
        credentialGeneration: accountActionDeliveryJobs.credentialGeneration,
      })
      .from(accountActionDeliveryJobs)
      .where(and(
        eq(accountActionDeliveryJobs.userId, candidate.id),
        eq(accountActionDeliveryJobs.organizationId, input.organizationId),
        eq(accountActionDeliveryJobs.action, "account_registration"),
        eq(accountActionDeliveryJobs.credentialGeneration, candidate.credentialGeneration),
      ))
      .orderBy(desc(accountActionDeliveryJobs.createdAt), desc(accountActionDeliveryJobs.id))
      .limit(1);
    if (!origin || origin.credentialGeneration !== candidate.credentialGeneration) return undefined;

    // The generation trigger normally makes this redundant, but keeping the
    // completed-action check local makes the resume contract explicit even if
    // an old fixture or a future migration bypasses that trigger.
    const [completedAction] = await tx
      .select({ id: accountActionRequests.id })
      .from(accountActionRequests)
      .where(and(
        eq(accountActionRequests.userId, candidate.id),
        eq(accountActionRequests.action, "account_registration"),
        eq(accountActionRequests.status, "consumed"),
      ))
      .limit(1);
    if (completedAction) return undefined;

    const delivery = await enqueueAccountRegistrationDelivery({
      userId: candidate.id,
      organizationId: input.organizationId,
      credentialGeneration: candidate.credentialGeneration,
      expiresAt: input.expiresAt,
    }, tx);
    return { user: candidate, delivery };
  });
}

/** Earliest due intent for the one-shot process-local scheduler. */
export async function getNextPasswordResetDeliveryAt(): Promise<Date | null> {
  const [row] = await db
    .select({
      nextAttemptAt: sql<string>`CASE
        WHEN ${accountActionDeliveryJobs.status} = 'processing'
          THEN ${accountActionDeliveryJobs.leaseExpiresAt}
        ELSE ${accountActionDeliveryJobs.nextAttemptAt}
      END`,
    })
    .from(accountActionDeliveryJobs)
    .where(or(
      and(
        inArray(accountActionDeliveryJobs.status, ["pending", "retry_scheduled"]),
        gt(accountActionDeliveryJobs.expiresAt, sql`now()`),
        lte(accountActionDeliveryJobs.attemptCount, ACCOUNT_ACTION_DELIVERY_MAX_ATTEMPTS - 1),
      ),
      and(
        eq(accountActionDeliveryJobs.status, "processing"),
        gt(accountActionDeliveryJobs.expiresAt, sql`now()`),
        sql`${accountActionDeliveryJobs.leaseExpiresAt} IS NOT NULL`,
      ),
    ))
    .orderBy(sql`CASE
      WHEN ${accountActionDeliveryJobs.status} = 'processing'
        THEN ${accountActionDeliveryJobs.leaseExpiresAt}
      ELSE ${accountActionDeliveryJobs.nextAttemptAt}
    END`, asc(accountActionDeliveryJobs.id))
    .limit(1);
  if (!row?.nextAttemptAt) return null;
  const result = new Date(row.nextAttemptAt);
  if (!Number.isFinite(result.getTime())) throw new Error("Invalid password-reset delivery due timestamp");
  return result;
}

export interface ClaimedPasswordResetDeliveryJob {
  job: AccountActionDeliveryJob;
  leaseToken: string;
}

/**
 * Claim one due intent with a transaction-bound row lock. The lease token
 * fences every completion write so a recovered worker cannot overwrite a
 * newer worker's result.
 */
export async function claimNextPasswordResetDeliveryJob(
  options: { workerId?: string } = {},
): Promise<ClaimedPasswordResetDeliveryJob | undefined> {
  const workerId = options.workerId ?? `password-reset-worker:${randomUUID()}`;
  if (workerId.length < 1 || workerId.length > 255) throw new Error("Invalid delivery worker ID");

  return db.transaction(async (tx) => {
    const candidates = await tx.execute<{ id: number }>(sql`
      SELECT id
      FROM account_action_delivery_jobs
      WHERE (
        (
          status IN ('pending', 'retry_scheduled')
          AND next_attempt_at <= now()
        ) OR (
          status = 'processing'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= now()
        )
      )
        AND expires_at > now()
        AND attempt_count < ${ACCOUNT_ACTION_DELIVERY_MAX_ATTEMPTS}
      ORDER BY next_attempt_at ASC, created_at ASC, id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);
    const id = candidates.rows[0]?.id;
    if (!id) return undefined;

    const leaseToken = randomUUID();
    const [job] = await tx
      .update(accountActionDeliveryJobs)
      .set({
        status: "processing",
        attemptCount: sql`${accountActionDeliveryJobs.attemptCount} + 1`,
        lastAttemptAt: sql`now()`,
        leaseOwner: workerId,
        leaseToken,
        leaseExpiresAt: sql`now() + (${Math.ceil(ACCOUNT_ACTION_DELIVERY_LEASE_MS / 1000)} || ' seconds')::interval`,
        updatedAt: sql`now()`,
      })
      .where(eq(accountActionDeliveryJobs.id, id))
      .returning();
    if (!job) return undefined;
    return { job, leaseToken };
  });
}

/** Recover only expired leases; live sibling workers remain untouched. */
export async function recoverPasswordResetDeliveryJobs(): Promise<number> {
  const rows = await db.transaction(async (tx) => {
    const expired = await tx
      .update(accountActionDeliveryJobs)
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
        inArray(accountActionDeliveryJobs.status, ["pending", "retry_scheduled", "processing"]),
        lte(accountActionDeliveryJobs.expiresAt, sql`now()`),
      ))
      .returning({ id: accountActionDeliveryJobs.id });

    const exhausted = await tx
      .update(accountActionDeliveryJobs)
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
        inArray(accountActionDeliveryJobs.status, ["pending", "retry_scheduled", "processing"]),
        lte(accountActionDeliveryJobs.attemptCount, ACCOUNT_ACTION_DELIVERY_MAX_ATTEMPTS),
        sql`${accountActionDeliveryJobs.attemptCount} >= ${ACCOUNT_ACTION_DELIVERY_MAX_ATTEMPTS}`,
        sql`(${accountActionDeliveryJobs.status} <> 'processing' OR ${accountActionDeliveryJobs.leaseExpiresAt} <= now())`,
      ))
      .returning({ id: accountActionDeliveryJobs.id });
    return expired.length + exhausted.length;
  });
  return rows;
}

/** Fence the action pointer before provider dispatch. */
export async function attachPasswordResetActionToDeliveryJob(input: {
  jobId: number;
  leaseToken: string;
  actionRequestId: number;
}): Promise<boolean> {
  const rows = await db
    .update(accountActionDeliveryJobs)
    .set({ actionRequestId: input.actionRequestId, updatedAt: sql`now()` })
    .where(and(
      eq(accountActionDeliveryJobs.id, input.jobId),
      eq(accountActionDeliveryJobs.status, "processing"),
      eq(accountActionDeliveryJobs.leaseToken, input.leaseToken),
      sql`EXISTS (
        SELECT 1
        FROM account_action_requests AS action_request
        WHERE action_request.id = ${input.actionRequestId}
          AND action_request.delivery_job_id = ${accountActionDeliveryJobs.id}
          AND action_request.user_id = ${accountActionDeliveryJobs.userId}
          AND action_request.action = ${accountActionDeliveryJobs.action}
      )`,
    ))
    .returning({ id: accountActionDeliveryJobs.id });
  return rows.length === 1;
}

export type PasswordResetDeliveryFinalization =
  | { status: "succeeded"; actionRequestId: number; providerMessageId?: string | null }
  | {
    status: "retry_scheduled";
    actionRequestId: number;
    errorCode: string;
    retryAfterMs: number;
    /** Known-unsent retries revoke this exact action before the next attempt. */
    deliveryDisposition: "known_unsent";
  }
  | {
    status: "retry_scheduled";
    actionRequestId?: number | null;
    errorCode: string;
    retryAfterMs: number;
    /** Omitted legacy outcomes are conservatively treated as uncertain. */
    deliveryDisposition?: "uncertain";
  }
  | {
    status: "failed";
    actionRequestId: number;
    errorCode: string;
    /** A known-unsent action must always identify the exact action row. */
    deliveryDisposition: "known_unsent";
  }
  | {
    status: "failed";
    actionRequestId?: number | null;
    errorCode: string;
    /** Unknown outcomes retain any possibly delivered action. */
    deliveryDisposition: "uncertain";
  }
  | { status: "suppressed"; reason: string };

/**
 * Persist a provider outcome and action delivery state atomically, fenced by
 * the claimed lease. A late worker whose lease was recovered cannot mutate an
 * action or job belonging to the replacement worker.
 */
export async function finalizePasswordResetDeliveryJob(input: {
  jobId: number;
  leaseToken: string;
  outcome: PasswordResetDeliveryFinalization;
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .select({
        id: accountActionDeliveryJobs.id,
        userId: accountActionDeliveryJobs.userId,
        actionRequestId: accountActionDeliveryJobs.actionRequestId,
        action: accountActionDeliveryJobs.action,
        attemptCount: accountActionDeliveryJobs.attemptCount,
        expiresAt: accountActionDeliveryJobs.expiresAt,
      })
      .from(accountActionDeliveryJobs)
      .where(and(
        eq(accountActionDeliveryJobs.id, input.jobId),
        eq(accountActionDeliveryJobs.status, "processing"),
        eq(accountActionDeliveryJobs.leaseToken, input.leaseToken),
      ))
      .for("update");
    if (!claimed) return false;

    const actionRequestId = "actionRequestId" in input.outcome
      ? input.outcome.actionRequestId
      // Suppression records may refer to the most recent action for
      // diagnostics, but a failure must never fall back to an older action:
      // an intent-expiry failure can race a prior uncertain provider attempt.
      : input.outcome.status === "suppressed"
        ? claimed.actionRequestId
        : undefined;
    if (
      input.outcome.status === "retry_scheduled"
      && input.outcome.deliveryDisposition === "known_unsent"
      && !Number.isSafeInteger(actionRequestId)
    ) {
      throw new Error("Known-unsent retry requires its exact action request ID");
    }
    if (actionRequestId) {
      const [linkedAction] = await tx
        .select({ id: accountActionRequests.id })
        .from(accountActionRequests)
        .where(and(
          eq(accountActionRequests.id, actionRequestId),
          eq(accountActionRequests.deliveryJobId, input.jobId),
          eq(accountActionRequests.userId, claimed.userId),
          eq(accountActionRequests.action, claimed.action),
        ))
        .limit(1);
      if (!linkedAction) return false;

      if (input.outcome.status === "succeeded" || input.outcome.status === "retry_scheduled" || input.outcome.status === "failed") {
        await tx
          .update(accountActionRequests)
          .set({
            deliveryStatus: input.outcome.status === "succeeded" ? "sent" : "failed",
            deliveryAttemptedAt: sql`now()`,
            deliveredAt: input.outcome.status === "succeeded" ? sql`now()` : null,
          })
          .where(and(
            eq(accountActionRequests.id, actionRequestId),
            eq(accountActionRequests.deliveryJobId, input.jobId),
          ));

        if (
          (input.outcome.status === "failed" || input.outcome.status === "retry_scheduled")
          && input.outcome.deliveryDisposition === "known_unsent"
        ) {
          // This branch is reserved for deterministic failures that occurred
          // before provider submission (for example missing configuration).
          // Unknown provider outcomes deliberately leave the action pending
          // because the link may already have been sent. A known-unsent retry
          // revokes before the next attempt, so a later issuance cannot leave
          // an older definitely-undelivered bearer active at the cap.
          await tx
            .update(accountActionRequests)
            .set({ status: "revoked", revokedAt: sql`now()` })
            .where(and(
              eq(accountActionRequests.id, actionRequestId),
              eq(accountActionRequests.deliveryJobId, input.jobId),
              eq(accountActionRequests.status, "pending"),
            ));
        }
      }
    }

    const common = {
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: sql`now()`,
    } as const;
    if (input.outcome.status === "succeeded") {
      const [updated] = await tx
        .update(accountActionDeliveryJobs)
        .set({
          ...common,
          status: "succeeded",
          actionRequestId,
          providerMessageId: input.outcome.providerMessageId ?? null,
          completedAt: sql`now()`,
        })
        .where(and(
          eq(accountActionDeliveryJobs.id, input.jobId),
          eq(accountActionDeliveryJobs.status, "processing"),
          eq(accountActionDeliveryJobs.leaseToken, input.leaseToken),
        ))
        .returning({ id: accountActionDeliveryJobs.id });
      return updated !== undefined;
    }

    if (input.outcome.status === "retry_scheduled") {
      const retryAllowed =
        claimed.attemptCount < ACCOUNT_ACTION_DELIVERY_MAX_ATTEMPTS
        && new Date(claimed.expiresAt).getTime() > Date.now();
      if (!retryAllowed) {
        const [updated] = await tx
          .update(accountActionDeliveryJobs)
          .set({
            ...common,
            status: "failed",
            actionRequestId,
            lastErrorCode: input.outcome.errorCode,
            completedAt: sql`now()`,
          })
          .where(and(
            eq(accountActionDeliveryJobs.id, input.jobId),
            eq(accountActionDeliveryJobs.status, "processing"),
            eq(accountActionDeliveryJobs.leaseToken, input.leaseToken),
          ))
          .returning({ id: accountActionDeliveryJobs.id });
        return updated !== undefined;
      }
      const retryAfterMs = Math.min(
        Math.max(0, input.outcome.retryAfterMs),
        ACCOUNT_ACTION_DELIVERY_MAX_RETRY_DELAY_MS,
      );
      const [updated] = await tx
        .update(accountActionDeliveryJobs)
        .set({
          ...common,
          status: "retry_scheduled",
          actionRequestId,
          lastErrorCode: input.outcome.errorCode,
          nextAttemptAt: sql`now() + (${Math.ceil(retryAfterMs / 1000)} || ' seconds')::interval`,
        })
        .where(and(
          eq(accountActionDeliveryJobs.id, input.jobId),
          eq(accountActionDeliveryJobs.status, "processing"),
          eq(accountActionDeliveryJobs.leaseToken, input.leaseToken),
        ))
        .returning({ id: accountActionDeliveryJobs.id });
      return updated !== undefined;
    }

    const [updated] = await tx
      .update(accountActionDeliveryJobs)
      .set({
        ...common,
        status: input.outcome.status,
        actionRequestId: actionRequestId ?? null,
        lastErrorCode: input.outcome.status === "failed" ? input.outcome.errorCode : input.outcome.reason,
        completedAt: sql`now()`,
      })
      .where(and(
        eq(accountActionDeliveryJobs.id, input.jobId),
        eq(accountActionDeliveryJobs.status, "processing"),
        eq(accountActionDeliveryJobs.leaseToken, input.leaseToken),
      ))
      .returning({ id: accountActionDeliveryJobs.id });
    return updated !== undefined;
  });
}

/** Read one job for diagnostics/tests without exposing secret material. */
export async function getPasswordResetDeliveryJob(jobId: number): Promise<AccountActionDeliveryJob | undefined> {
  const [job] = await db
    .select()
    .from(accountActionDeliveryJobs)
    .where(eq(accountActionDeliveryJobs.id, jobId))
    .limit(1);
  return job;
}

export type { AccountActionDeliveryJob, AccountActionDeliveryJobStatus };
