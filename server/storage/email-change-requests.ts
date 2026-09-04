import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  emailChangeRequests,
  type EmailChangeRequest,
  type InsertEmailChangeRequest,
} from "@shared/schema";

// Accepts either the root `db` or a transaction handle from
// `db.transaction(...)`. Derived from the transaction callback's
// parameter type so we don't have to spell out the Drizzle generics
// (which require three `any`s to satisfy and would otherwise need an
// eslint suppression).
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function createEmailChangeRequest(
  data: InsertEmailChangeRequest,
): Promise<EmailChangeRequest> {
  const [row] = await db.insert(emailChangeRequests).values(data).returning();
  return row;
}

export async function getEmailChangeRequestByTokenHash(
  tokenHash: string,
): Promise<EmailChangeRequest | undefined> {
  const [row] = await db
    .select()
    .from(emailChangeRequests)
    .where(eq(emailChangeRequests.tokenHash, tokenHash))
    .limit(1);
  return row;
}

export async function consumeEmailChangeRequest(
  id: number,
  exec: Executor = db,
): Promise<void> {
  await exec
    .update(emailChangeRequests)
    .set({ consumedAt: sql`now()` })
    .where(and(eq(emailChangeRequests.id, id), isNull(emailChangeRequests.consumedAt)));
}

/**
 * Atomically claim an email-change request by token hash. Returns the row
 * only if it was eligible (not yet consumed AND not expired) at the moment
 * of the UPDATE. Subsequent calls — even racing in parallel — return undefined.
 *
 * Caller is responsible for performing the actual user.email update inside
 * the same transaction so the whole confirm step rolls back together if
 * anything later fails (e.g. unique-violation on the new email).
 */
export async function claimEmailChangeRequest(
  tokenHash: string,
  exec: Executor = db,
): Promise<EmailChangeRequest | undefined> {
  const [row] = await exec
    .update(emailChangeRequests)
    .set({ consumedAt: sql`now()` })
    .where(
      and(
        eq(emailChangeRequests.tokenHash, tokenHash),
        isNull(emailChangeRequests.consumedAt),
        gt(emailChangeRequests.expiresAt, sql`now()`),
      ),
    )
    .returning();
  return row;
}

/**
 * Mark every still-pending email-change request for a user as consumed.
 * Used when:
 *   - the user submits a new email-change request (supersedes the previous one)
 *   - the user changes their password (any in-flight token might be a hijacker
 *     trying to swap the email out from under them)
 */
export async function invalidatePendingEmailChangeRequestsForUser(
  userId: number,
  exec: Executor = db,
): Promise<number> {
  const rows = await exec
    .update(emailChangeRequests)
    .set({ consumedAt: sql`now()` })
    .where(
      and(
        eq(emailChangeRequests.userId, userId),
        isNull(emailChangeRequests.consumedAt),
      ),
    )
    .returning({ id: emailChangeRequests.id });
  return rows.length;
}
