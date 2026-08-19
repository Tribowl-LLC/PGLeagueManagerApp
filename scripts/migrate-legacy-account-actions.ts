import { pathToFileURL } from 'node:url';
import { isNotNull, or, eq, sql } from 'drizzle-orm';
import { organizations, users } from '@shared/schema';
import { db, pool } from '../server/db';
import { storage } from '../server/storage';
import { sendInviteEmail } from '../server/services/email';

interface LegacyAccountActionCandidate {
  userId: number;
  email: string;
  name: string;
  organizationId: number | null;
  organizationName: string | null;
  organizationSlug: string | null;
  inviteTokenExpiry: string | null;
  hasInviteToken: boolean;
}

async function getCandidates(): Promise<LegacyAccountActionCandidate[]> {
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      organizationId: users.organizationId,
      organizationName: organizations.name,
      organizationSlug: organizations.slug,
      organizationSubdomain: organizations.subdomain,
      hasInviteToken: sql<boolean>`${users.inviteToken} IS NOT NULL`,
      inviteTokenExpiry: users.inviteTokenExpiry,
    })
    .from(users)
    .leftJoin(organizations, eq(users.organizationId, organizations.id))
    .where(or(isNotNull(users.inviteToken), isNotNull(users.inviteTokenExpiry)));

  return rows.map((row) => ({
    userId: row.userId,
    email: row.email,
    name: row.name,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    organizationSlug: row.organizationSubdomain || row.organizationSlug,
    inviteTokenExpiry: row.inviteTokenExpiry,
    hasInviteToken: row.hasInviteToken,
  }));
}

export function isActiveLegacyAction(candidate: LegacyAccountActionCandidate, now: number): boolean {
  if (!candidate.hasInviteToken || candidate.inviteTokenExpiry === null) return false;
  const expiry = Date.parse(candidate.inviteTokenExpiry);
  return Number.isFinite(expiry) && expiry > now;
}

export function getActiveLegacyExpiry(
  candidate: LegacyAccountActionCandidate,
  now: number,
): Date | null {
  const expiryText = candidate.inviteTokenExpiry;
  if (!candidate.hasInviteToken || expiryText === null) return null;
  const expiry = new Date(expiryText);
  return Number.isFinite(expiry.getTime()) && expiry.getTime() > now ? expiry : null;
}

/**
 * One-release bridge for plaintext `users.invite_token` rows.
 *
 * New code never accepts those tokens. This operation creates a fresh hashed
 * action before clearing each legacy marker, then records delivery success or
 * failure so an administrator can safely resend a failed invitation.
 */
export async function migrateLegacyAccountActions(execute: boolean): Promise<{
  candidates: number;
  activeReissued: number;
  staleCleared: number;
  deliveryFailures: number;
}> {
  const candidates = await getCandidates();
  const now = Date.now();
  const active = candidates.filter((candidate) => isActiveLegacyAction(candidate, now));
  const stale = candidates.filter((candidate) => !isActiveLegacyAction(candidate, now));

  if (!execute) {
    return {
      candidates: candidates.length,
      activeReissued: active.length,
      staleCleared: stale.length,
      deliveryFailures: 0,
    };
  }

  let deliveryFailures = 0;
  let activeReissued = 0;
  let staleCleared = 0;
  for (const candidate of candidates) {
    // Recheck against the current clock: a token can expire while an earlier
    // candidate is being delivered. Never extend the legacy lifetime.
    const expiresAt = getActiveLegacyExpiry(candidate, Date.now());
    if (expiresAt) {
      const invitation = await storage.issueAccountAction({
        userId: candidate.userId,
        organizationId: candidate.organizationId,
        action: 'account_invite',
        expiresAt,
      });
      let sent = false;
      try {
        sent = await sendInviteEmail(
          candidate.email,
          candidate.name,
          invitation.token,
          candidate.organizationName ?? undefined,
          candidate.organizationId ?? undefined,
          candidate.organizationSlug,
        );
      } catch {
        // Delivery is intentionally outside the database transaction. A
        // provider/configuration exception must still become an observable
        // failed action, and must not abort cleanup of the legacy marker.
        sent = false;
      }
      await storage.updateAccountActionDeliveryStatus(
        invitation.request.id,
        sent ? 'sent' : 'failed',
      );
      if (!sent) deliveryFailures += 1;
      activeReissued += 1;
    } else {
      staleCleared += 1;
    }

    // Clear only after a replacement action has been committed (when active).
    // The application already ignores the old value, so stale markers can be
    // removed directly and failed delivery remains visible on the new row.
    await db
      .update(users)
      .set({ inviteToken: null, inviteTokenExpiry: null })
      .where(eq(users.id, candidate.userId));
  }

  return {
    candidates: candidates.length,
    activeReissued,
    staleCleared,
    deliveryFailures,
  };
}

async function main(): Promise<void> {
  const execute = process.argv.slice(2).includes('--execute');
  const unexpectedArgs = process.argv.slice(2).filter((argument) => argument !== '--execute');
  if (unexpectedArgs.length > 0) {
    throw new Error('Usage: tsx scripts/migrate-legacy-account-actions.ts [--execute]');
  }
  const report = await migrateLegacyAccountActions(execute);
  process.stdout.write(`${JSON.stringify({ mode: execute ? 'execute' : 'dry-run', ...report }, null, 2)}\n`);
  if (!execute) {
    process.stdout.write('[legacy-account-actions] Dry run only; pass --execute after backup and migration review.\n');
  } else if (report.deliveryFailures > 0) {
    process.stderr.write(
      `[legacy-account-actions] ${report.deliveryFailures} invitation delivery attempt(s) failed; use the admin resend workflow.\n`,
    );
    process.exitCode = 1;
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  main()
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[legacy-account-actions] failed: ${message}\n`);
      process.exitCode = 1;
    })
    .finally(() => pool.end().catch(() => undefined));
}
