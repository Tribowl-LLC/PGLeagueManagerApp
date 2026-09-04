/**
 * Integration tests for the email-change confirmation flow (task #280).
 *
 * Verifies:
 *   - PATCH /api/account/profile/:id with a new email does NOT immediately
 *     change the login email, returns emailChangeRequested:true, and creates
 *     a pending request row.
 *   - Name/phone updates remain synchronous.
 *   - POST /api/account/confirm-email-change with a valid token swaps the
 *     login email and consumes the token.
 *   - Reusing a consumed token is rejected.
 *   - Expired tokens are rejected.
 *   - Two competing requests: the first is invalidated when the second is
 *     created.
 *   - Email-already-in-use at confirm time is rejected with 400.
 *   - Changing password invalidates pending email-change requests.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../server/db';
import { storage } from '../../server/storage';
import { users, emailChangeRequests, bowlers, adminEmailChangeAudits, adminProfileEditAudits } from '@shared/schema';
import { hashPassword } from '../../server/lib/password';
import { createHash } from 'crypto';
import {
  apiPatch,
  apiPost,
  login,
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_PASSWORD,
  TEST_ORG_A_EMAIL,
  TEST_ORG_PASSWORD,
  getBaselineOrgAId,
  type AuthSession,
  BASE_URL,
} from '../helpers';

// Mint an isolated rate-limit bucket id per test. The confirm-email-change
// limiter honors `x-test-rl-bucket` only when NODE_ENV !== 'production',
// giving each test its own counter so the suite doesn't have to depend on
// fragile X-Forwarded-For trickery through a hosted reverse proxy
// (req.ip may be rewritten to the loopback hop regardless of what we forge).
function newBucketId(): string {
  return `vitest-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function postWithBucket(
  path: string,
  body: unknown,
  bucket: string,
): Promise<{ status: number; body: { error?: { code?: string } } }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-test-rl-bucket': bucket,
    },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json()) as { error?: { code?: string } };
  return { status: res.status, body: parsed };
}

// Task #607: attach users to the seeded `vitest-org-a` baseline.
const createdUserIds: number[] = [];

const TEST_PASSWORD = 'EmailChangeTest!2026';

let testOrgId: number;

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function uniqEmail(prefix: string): string {
  return `${uniq(prefix)}@vitest.local`;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

beforeAll(async () => {
  testOrgId = await getBaselineOrgAId();
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    // admin_email_change_audits uses ON DELETE RESTRICT (we want the
    // audit trail to survive a user soft-delete in production), so the
    // test cleanup has to remove those rows first by either actor or
    // target before the users themselves can go.
    await db
      .delete(adminEmailChangeAudits)
      .where(inArray(adminEmailChangeAudits.targetUserId, createdUserIds));
    await db
      .delete(adminEmailChangeAudits)
      .where(inArray(adminEmailChangeAudits.actorUserId, createdUserIds));
    // admin_profile_edit_audits also uses ON DELETE RESTRICT (task #376)
    // so it has to be cleared by both target and actor before the user
    // rows can go.
    await db
      .delete(adminProfileEditAudits)
      .where(inArray(adminProfileEditAudits.targetUserId, createdUserIds));
    await db
      .delete(adminProfileEditAudits)
      .where(inArray(adminProfileEditAudits.actorUserId, createdUserIds));
    // email_change_requests rows cascade-delete with the user
    await db.delete(users).where(inArray(users.id, createdUserIds));
    createdUserIds.length = 0;
  }
});

async function createUserAndLogin(): Promise<{
  userId: number;
  oldEmail: string;
  session: AuthSession;
}> {
  const oldEmail = uniqEmail('old');
  const password = await hashPassword(TEST_PASSWORD);
  const [user] = await db
    .insert(users)
    .values({
      email: oldEmail,
      password,
      name: uniq('Test User'),
      role: 'user',
      organizationId: testOrgId,
    })
    .returning();
  createdUserIds.push(user.id);
  const session = await login(oldEmail, TEST_PASSWORD);
  return { userId: user.id, oldEmail, session };
}

describe('PATCH /api/account/profile/:id with email change', () => {
  it('does not change the login email immediately and creates a pending request', async () => {
    const { userId, oldEmail, session } = await createUserAndLogin();
    const newEmail = uniqEmail('new');

    const res = await apiPatch<{
      email: string;
      emailChangeRequested: boolean;
      paymentSyncStatus: string;
    }>(`/api/account/profile/${userId}`, { email: newEmail }, session);

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data?.emailChangeRequested).toBe(true);
    // Returned record still shows the OLD email — login has not changed.
    expect(res.data.data?.email).toBe(oldEmail);

    // DB user row still has the old email.
    const [reread] = await db.select().from(users).where(eq(users.id, userId));
    expect(reread.email).toBe(oldEmail);

    // Exactly one pending request row exists for this user.
    const pending = await db
      .select()
      .from(emailChangeRequests)
      .where(eq(emailChangeRequests.userId, userId));
    const open = pending.filter(r => r.consumedAt === null);
    expect(open.length).toBe(1);
    expect(open[0].newEmail).toBe(newEmail);
  });

  it('still updates name synchronously even when email is also changed', async () => {
    const { userId, session } = await createUserAndLogin();
    const newEmail = uniqEmail('new');
    const newName = `Renamed ${Date.now()}`;

    const res = await apiPatch<{ name: string; emailChangeRequested: boolean }>(
      `/api/account/profile/${userId}`,
      { email: newEmail, name: newName },
      session,
    );

    expect(res.status).toBe(200);
    expect(res.data.data?.emailChangeRequested).toBe(true);
    expect(res.data.data?.name).toBe(newName);

    const [reread] = await db.select().from(users).where(eq(users.id, userId));
    expect(reread.name).toBe(newName);
  });

  it('returns emailChangeRequested:false when the submitted email matches the current one', async () => {
    const { userId, oldEmail, session } = await createUserAndLogin();

    const res = await apiPatch<{ emailChangeRequested: boolean }>(
      `/api/account/profile/${userId}`,
      { email: oldEmail },
      session,
    );

    expect(res.status).toBe(200);
    expect(res.data.data?.emailChangeRequested).toBe(false);
  });

  it('rejects when the new email is already used by a different user', async () => {
    const { userId, session } = await createUserAndLogin();
    const taken = uniqEmail('taken');
    const password = await hashPassword(TEST_PASSWORD);
    const [other] = await db
      .insert(users)
      .values({
        email: taken,
        password,
        name: uniq('Other'),
        role: 'user',
        organizationId: testOrgId,
      })
      .returning();
    createdUserIds.push(other.id);

    const res = await apiPatch(`/api/account/profile/${userId}`, { email: taken }, session);
    expect(res.status).toBe(400);
    expect(res.data.error?.code).toBe('EMAIL_IN_USE');
  });

  it('two competing requests: creating a second invalidates the first', async () => {
    const { userId, session } = await createUserAndLogin();
    const firstEmail = uniqEmail('first');
    const secondEmail = uniqEmail('second');

    await apiPatch(`/api/account/profile/${userId}`, { email: firstEmail }, session);
    await apiPatch(`/api/account/profile/${userId}`, { email: secondEmail }, session);

    const rows = await db
      .select()
      .from(emailChangeRequests)
      .where(eq(emailChangeRequests.userId, userId));
    const open = rows.filter(r => r.consumedAt === null);
    expect(open.length).toBe(1);
    expect(open[0].newEmail).toBe(secondEmail);
  });
});

describe('POST /api/account/confirm-email-change', () => {
  it('happy path: a valid token swaps the email and consumes the token', async () => {
    const { userId, session } = await createUserAndLogin();
    const newEmail = uniqEmail('new');

    // Patch raw token directly into the DB so the test can read it back —
    // production tokens go out only by email, but here we synthesize one.
    const rawToken = `vitest-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    await db.insert(emailChangeRequests).values({
      userId,
      newEmail,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const res = await apiPost<{ email: string; paymentSyncStatus: string }>(
      `/api/account/confirm-email-change`,
      { token: rawToken },
      session,
    );
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data?.email).toBe(newEmail);

    const [reread] = await db.select().from(users).where(eq(users.id, userId));
    expect(reread.email).toBe(newEmail);

    // eslint-disable-next-line leaguevault/no-unscoped-table-query-in-test-assertion -- scoped by tokenHash (cryptographic hash, unique-by-construction) which is just as race-safe as filtering by .id.
    const [request] = await db
      .select()
      .from(emailChangeRequests)
      .where(eq(emailChangeRequests.tokenHash, hashToken(rawToken)));
    expect(request.consumedAt).not.toBeNull();
  });

  it('runs the bowler payment-customer sync at confirm time when the user is linked to a bowler', async () => {
    // Create a fresh user linked to a bowler in an org with no Square
    // config, so the sync helper takes the deterministic 'skipped' branch
    // (matches the assertion shape used by payment-sync-status.test.ts).
    const password = await hashPassword(TEST_PASSWORD);
    const oldEmail = uniqEmail('linked');
    const [bowler] = await db
      .insert(bowlers)
      .values({
        name: uniq('linked-bowler'),
        email: oldEmail,
        phone: null,
        active: true,
        order: 0,
        organizationId: testOrgId,
        paymentCustomerId: null,
        paymentSyncPendingAt: null,
      })
      .returning();
    const [user] = await db
      .insert(users)
      .values({
        email: oldEmail,
        password,
        name: uniq('Linked User'),
        role: 'user',
        organizationId: testOrgId,
        bowlerId: bowler.id,
      })
      .returning();
    createdUserIds.push(user.id);
    const session = await login(oldEmail, TEST_PASSWORD);

    const newEmail = uniqEmail('linked-new');
    const rawToken = `vitest-linked-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    await db.insert(emailChangeRequests).values({
      userId: user.id,
      newEmail,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const res = await apiPost<{ email: string; paymentSyncStatus: string }>(
      `/api/account/confirm-email-change`,
      { token: rawToken },
      session,
    );
    expect(res.status).toBe(200);
    expect(res.data.data?.email).toBe(newEmail);
    // No Square config on this org → sync helper resolves to 'skipped',
    // proving the sync code-path actually ran (a 'not_applicable' result
    // would mean the bowlerId branch was skipped, which would be wrong).
    expect(res.data.data?.paymentSyncStatus).toBe('skipped');

    // Cleanup: detach the user from the bowler (FK), then drop the
    // bowler row. The user itself is cleaned up by the afterAll hook.
    await db.update(users).set({ bowlerId: null }).where(eq(users.id, user.id));
    await db.delete(bowlers).where(eq(bowlers.id, bowler.id));
  });

  it('rejects an already-consumed token', async () => {
    const { userId, session } = await createUserAndLogin();
    const newEmail = uniqEmail('new');
    const rawToken = `reuse-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    await db.insert(emailChangeRequests).values({
      userId,
      newEmail,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const first = await apiPost(`/api/account/confirm-email-change`, { token: rawToken }, session);
    expect(first.status).toBe(200);

    const second = await apiPost(`/api/account/confirm-email-change`, { token: rawToken }, session);
    expect(second.status).toBe(400);
    expect(second.data.error?.code).toBe('TOKEN_CONSUMED');
  });

  it('rejects an expired token', async () => {
    const { userId, session } = await createUserAndLogin();
    const newEmail = uniqEmail('new');
    const rawToken = `expired-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    await db.insert(emailChangeRequests).values({
      userId,
      newEmail,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const res = await apiPost(`/api/account/confirm-email-change`, { token: rawToken }, session);
    expect(res.status).toBe(400);
    expect(res.data.error?.code).toBe('TOKEN_EXPIRED');
  });

  it('rejects a bogus token with INVALID_TOKEN, both authenticated and anonymous (the endpoint is CSRF-exempt by design)', async () => {
    const { session } = await createUserAndLogin();
    const res = await apiPost(
      `/api/account/confirm-email-change`,
      { token: 'never-issued-deadbeef' },
      session,
    );
    expect(res.status).toBe(400);
    expect(res.data.error?.code).toBe('INVALID_TOKEN');

    const anon = await apiPost(`/api/account/confirm-email-change`, {
      token: 'never-issued-deadbeef-anon',
    });
    expect(anon.status).toBe(400);
    expect(anon.data.error?.code).toBe('INVALID_TOKEN');
  });

  it('rejects when the target email was claimed between request and confirm', async () => {
    const { userId, oldEmail, session } = await createUserAndLogin();
    const requestedEmail = uniqEmail('requested');
    const rawToken = `race-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    await db.insert(emailChangeRequests).values({
      userId,
      newEmail: requestedEmail,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    // Race: another user grabs the address before the original confirms.
    const password = await hashPassword(TEST_PASSWORD);
    const [other] = await db
      .insert(users)
      .values({
        email: requestedEmail,
        password,
        name: uniq('Squatter'),
        role: 'user',
        organizationId: testOrgId,
      })
      .returning();
    createdUserIds.push(other.id);

    const res = await apiPost(`/api/account/confirm-email-change`, { token: rawToken }, session);
    expect(res.status).toBe(400);
    expect(res.data.error?.code).toBe('EMAIL_IN_USE');

    // Original user's email must remain unchanged.
    const [reread] = await db.select().from(users).where(eq(users.id, userId));
    expect(reread.email).toBe(oldEmail);

    // Token consumed so a refresh doesn't loop on the same race.
    // eslint-disable-next-line leaguevault/no-unscoped-table-query-in-test-assertion -- scoped by tokenHash (cryptographic hash, unique-by-construction) which is just as race-safe as filtering by .id.
    const [request] = await db
      .select()
      .from(emailChangeRequests)
      .where(eq(emailChangeRequests.tokenHash, hashToken(rawToken)));
    expect(request.consumedAt).not.toBeNull();
  });
});

describe('POST /api/account/change-password invalidates pending email-change requests', () => {
  it('marks open email-change requests as consumed after a successful password change', async () => {
    const { userId, session } = await createUserAndLogin();
    const newEmail = uniqEmail('pending');
    const rawToken = `pwchange-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    await db.insert(emailChangeRequests).values({
      userId,
      newEmail,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const res = await apiPost(
      `/api/account/change-password`,
      { currentPassword: TEST_PASSWORD, newPassword: 'NewPassword!2026XX' },
      session,
    );
    expect(res.status).toBe(200);

    // The previously-issued token should now be useless.
    const confirmRes = await apiPost(
      `/api/account/confirm-email-change`,
      { token: rawToken },
      session,
    );
    expect(confirmRes.status).toBe(400);
    expect(confirmRes.data.error?.code).toBe('TOKEN_CONSUMED');
  });
});

describe('POST /api/auth/set-password invalidates pending email-change requests', () => {
  it('marks open email-change requests as consumed after a successful password reset', async () => {
    const { userId, oldEmail } = await createUserAndLogin();
    const newEmail = uniqEmail('pending-reset');
    const rawToken = `setpw-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    // Stage an invite/reset token on the user, then a pending email-change.
    const inviteAction = await storage.issueAccountAction({
      userId,
      action: 'password_reset',
      expiresAt: new Date(Date.now() + 60_000),
      organizationId: testOrgId,
      recipientEmail: oldEmail,
    });
    await db.insert(emailChangeRequests).values({
      userId,
      newEmail,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const setRes = await apiPost(`/api/auth/set-password`, {
      token: inviteAction.token,
      password: 'AfterReset!2026XX',
    });
    expect(setRes.status).toBe(200);

    // Pending token from before the reset must no longer work.
    const { session } = await createUserAndLogin();
    const confirmRes = await apiPost(
      `/api/account/confirm-email-change`,
      { token: rawToken },
      session,
    );
    expect(confirmRes.status).toBe(400);
    expect(confirmRes.data.error?.code).toBe('TOKEN_CONSUMED');
  });
});

describe('POST /api/account/confirm-email-change concurrency', () => {
  it('N parallel confirms with the same token: exactly one wins, the rest see TOKEN_CONSUMED', async () => {
    const { userId } = await createUserAndLogin();
    const newEmail = uniqEmail('parallel');
    const rawToken = `parallel-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    await db.insert(emailChangeRequests).values({
      userId,
      newEmail,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    // Endpoint is intentionally unauthenticated (token IS the auth factor).
    // Fire requests with NO shared session so express-session locking can't
    // partially serialize them — that would mask any real race in the
    // confirm transaction.
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        apiPost<{ email: string }>(
          `/api/account/confirm-email-change`,
          { token: rawToken },
        ),
      ),
    );

    const ok = results.filter(r => r.status === 200);
    const consumed = results.filter(
      r => r.status === 400 && r.data.error?.code === 'TOKEN_CONSUMED',
    );

    // Exactly one win, every other call sees the token-consumed branch.
    // No 500s, no other 400 codes (e.g. EMAIL_IN_USE / INVALID_TOKEN /
    // TOKEN_EXPIRED) are acceptable here.
    expect(ok.length).toBe(1);
    expect(consumed.length).toBe(N - 1);
    expect(ok[0].data.data?.email).toBe(newEmail);

    // DB ground truth: email actually swapped, exactly one token row,
    // and it is consumed.
    const [reread] = await db.select().from(users).where(eq(users.id, userId));
    expect(reread.email).toBe(newEmail);

    // eslint-disable-next-line leaguevault/no-unscoped-table-query-in-test-assertion -- scoped by tokenHash (cryptographic hash, unique-by-construction) which is just as race-safe as filtering by .id.
    const rows = await db
      .select()
      .from(emailChangeRequests)
      .where(eq(emailChangeRequests.tokenHash, hashToken(rawToken)));
    expect(rows.length).toBe(1);
    expect(rows[0].consumedAt).not.toBeNull();
  });

  it('two confirms targeting the same new email race-safely: one 200, one 400 EMAIL_IN_USE, never 500', async () => {
    // Two independent users each hold a confirmation token for the SAME
    // target address. Whichever transaction commits first wins; the
    // loser must see EMAIL_IN_USE (not 500), and the loser's user row
    // must remain on its old email.
    const a = await createUserAndLogin();
    const b = await createUserAndLogin();

    const targetEmail = uniqEmail('contested');
    const tokenA = `contendA-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const tokenB = `contendB-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    await db.insert(emailChangeRequests).values([
      {
        userId: a.userId,
        newEmail: targetEmail,
        tokenHash: hashToken(tokenA),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      {
        userId: b.userId,
        newEmail: targetEmail,
        tokenHash: hashToken(tokenB),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ]);

    const [resA, resB] = await Promise.all([
      apiPost(`/api/account/confirm-email-change`, { token: tokenA }, a.session),
      apiPost(`/api/account/confirm-email-change`, { token: tokenB }, b.session),
    ]);

    const ok = [resA, resB].filter(r => r.status === 200);
    const inUse = [resA, resB].filter(
      r => r.status === 400 && r.data.error?.code === 'EMAIL_IN_USE',
    );
    const fivexx = [resA, resB].filter(r => r.status >= 500);

    expect(fivexx.length).toBe(0);
    expect(ok.length).toBe(1);
    expect(inUse.length).toBe(1);

    // Loser's user row must be untouched.
    const winnerId = resA.status === 200 ? a.userId : b.userId;
    const loser = resA.status === 200 ? b : a;
    const [loserRow] = await db.select().from(users).where(eq(users.id, loser.userId));
    expect(loserRow.email).toBe(loser.oldEmail);

    // Winner's row holds the contested email.
    const [winnerRow] = await db.select().from(users).where(eq(users.id, winnerId));
    expect(winnerRow.email).toBe(targetEmail);

    // Loser's token is consumed (so a refresh doesn't loop on the race).
    const loserToken = resA.status === 200 ? tokenB : tokenA;
    // eslint-disable-next-line leaguevault/no-unscoped-table-query-in-test-assertion -- scoped by tokenHash (cryptographic hash, unique-by-construction) which is just as race-safe as filtering by .id.
    const [loserRequest] = await db
      .select()
      .from(emailChangeRequests)
      .where(eq(emailChangeRequests.tokenHash, hashToken(loserToken)));
    expect(loserRequest.consumedAt).not.toBeNull();
  });
});

describe('PATCH /api/account/profile/:id when invoked by a system_admin', () => {
  it("admin editing another user's email triggers the confirmation flow rather than an immediate write", async () => {
    // The endpoint comment is explicit: the confirmation gate applies to
    // ALL callers, including system_admin acting on behalf of someone
    // else. A regression here would let any admin (or a hijacked admin
    // session) silently re-route another user's login email.
    const { userId, oldEmail } = await createUserAndLogin();
    const adminSession = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
    expect(adminSession.user.role).toBe('system_admin');

    const newEmail = uniqEmail('admin-initiated');
    const res = await apiPatch<{
      email: string;
      emailChangeRequested: boolean;
    }>(`/api/account/profile/${userId}`, { email: newEmail }, adminSession);

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data?.emailChangeRequested).toBe(true);
    // Returned record still shows the OLD email — admin did NOT write it.
    expect(res.data.data?.email).toBe(oldEmail);

    // DB ground truth: target user's login email is unchanged.
    const [reread] = await db.select().from(users).where(eq(users.id, userId));
    expect(reread.email).toBe(oldEmail);

    // A pending confirmation request was created for the user.
    const pending = await db
      .select()
      .from(emailChangeRequests)
      .where(eq(emailChangeRequests.userId, userId));
    const open = pending.filter(r => r.consumedAt === null);
    expect(open.length).toBe(1);
    expect(open[0].newEmail).toBe(newEmail);
  });

  it("writes an admin_email_change_audits row when an admin requests another user's email change", async () => {
    // Audit-trail contract from task #325. The row must be written in
    // the SAME transaction as the email_change_requests insert; this
    // test only asserts the post-conditions, but the route comment
    // covers the transactional invariant.
    const { userId, oldEmail } = await createUserAndLogin();
    const adminSession = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
    const newEmail = uniqEmail('admin-audited');

    const before = Date.now();
    const res = await apiPatch<{ emailChangeRequested: boolean }>(
      `/api/account/profile/${userId}`,
      { email: newEmail },
      adminSession,
    );
    expect(res.status).toBe(200);
    expect(res.data.data?.emailChangeRequested).toBe(true);

    const auditRows = await db
      .select()
      .from(adminEmailChangeAudits)
      .where(eq(adminEmailChangeAudits.targetUserId, userId));
    expect(auditRows.length).toBe(1);
    const audit = auditRows[0];
    expect(audit.actorUserId).toBe(adminSession.user.id);
    expect(audit.targetUserId).toBe(userId);
    // Stored masked, never the full address — guard against PII leak
    // through the audit table.
    expect(audit.oldEmailMasked).not.toBe(oldEmail);
    expect(audit.newEmailMasked).not.toBe(newEmail);
    expect(audit.oldEmailMasked).toContain('*');
    expect(audit.newEmailMasked).toContain('*');
    expect(new Date(audit.createdAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("writes an admin_profile_edit_audits row when an admin changes another user's name", async () => {
    // Task #376: name/phone/preferredLanguage edits by an admin must
    // also be auditable, not just email. The route writes the audit
    // row in the SAME transaction as the user update so the two
    // cannot disagree (this test asserts the post-conditions; the
    // route comment covers the transactional invariant).
    const { userId } = await createUserAndLogin();
    const adminSession = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);

    const [before] = await db.select().from(users).where(eq(users.id, userId));
    const newName = `Admin-Renamed ${Date.now()}`;

    const res = await apiPatch<{ name: string }>(
      `/api/account/profile/${userId}`,
      { name: newName },
      adminSession,
    );
    expect(res.status).toBe(200);
    expect(res.data.data?.name).toBe(newName);

    // The DB user row reflects the new name.
    const [after] = await db.select().from(users).where(eq(users.id, userId));
    expect(after.name).toBe(newName);

    // Exactly one audit row, scoped to the renamed field.
    const auditRows = await db
      .select()
      .from(adminProfileEditAudits)
      .where(eq(adminProfileEditAudits.targetUserId, userId));
    expect(auditRows.length).toBe(1);
    const audit = auditRows[0];
    expect(audit.actorUserId).toBe(adminSession.user.id);
    expect(audit.targetUserId).toBe(userId);
    expect(audit.field).toBe('name');
    expect(audit.oldValue).toBe(before.name);
    expect(audit.newValue).toBe(newName);
  });

  it("writes an admin_profile_edit_audits row when an admin changes another user's phone (and another when they clear it)", async () => {
    // Phone has tri-state semantics on the route (omit / null / value);
    // both setting AND clearing must be audited so support has the full
    // trail.
    const { userId } = await createUserAndLogin();
    const adminSession = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);

    // Set a phone number from null → "+15551234567".
    const newPhone = `+1555${Date.now().toString().slice(-7)}`;
    const setRes = await apiPatch<{ phone: string | null }>(
      `/api/account/profile/${userId}`,
      { phone: newPhone },
      adminSession,
    );
    expect(setRes.status).toBe(200);
    expect(setRes.data.data?.phone).toBe(newPhone);

    // Clear the phone with an explicit empty string (the route collapses
    // "" → null per the schema's tri-state contract).
    const clearRes = await apiPatch<{ phone: string | null }>(
      `/api/account/profile/${userId}`,
      { phone: '' },
      adminSession,
    );
    expect(clearRes.status).toBe(200);
    expect(clearRes.data.data?.phone).toBeNull();

    const auditRows = await db
      .select()
      .from(adminProfileEditAudits)
      .where(eq(adminProfileEditAudits.targetUserId, userId))
      .orderBy(adminProfileEditAudits.id);
    expect(auditRows.length).toBe(2);

    expect(auditRows[0].field).toBe('phone');
    expect(auditRows[0].oldValue).toBeNull();
    expect(auditRows[0].newValue).toBe(newPhone);
    expect(auditRows[0].actorUserId).toBe(adminSession.user.id);

    expect(auditRows[1].field).toBe('phone');
    expect(auditRows[1].oldValue).toBe(newPhone);
    expect(auditRows[1].newValue).toBeNull();
    expect(auditRows[1].actorUserId).toBe(adminSession.user.id);
  });

  it('writes one row per changed field when an admin updates name and phone in the same request', async () => {
    // The route emits one audit row per changed field (rather than one
    // packed row per request) so the trail is queryable by field. This
    // pins that contract.
    const { userId } = await createUserAndLogin();
    const adminSession = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);

    const newName = `Combo Rename ${Date.now()}`;
    const newPhone = `+1444${Date.now().toString().slice(-7)}`;

    const res = await apiPatch<{ name: string; phone: string | null }>(
      `/api/account/profile/${userId}`,
      { name: newName, phone: newPhone },
      adminSession,
    );
    expect(res.status).toBe(200);
    expect(res.data.data?.name).toBe(newName);
    expect(res.data.data?.phone).toBe(newPhone);

    const auditRows = await db
      .select()
      .from(adminProfileEditAudits)
      .where(eq(adminProfileEditAudits.targetUserId, userId));
    const fields = auditRows.map(r => r.field).sort();
    expect(fields).toEqual(['name', 'phone']);
  });

  it('does NOT write a profile-edit audit row when the user edits their OWN name or phone', async () => {
    // Self-serve edits are intentionally NOT audited — they're already
    // logged at INFO via storage.updateUser and aren't a triage
    // concern. Mirrors the asymmetry on admin_email_change_audits.
    const { userId, session } = await createUserAndLogin();

    const res = await apiPatch<{ name: string }>(
      `/api/account/profile/${userId}`,
      { name: `Self Rename ${Date.now()}`, phone: '+15559999999' },
      session,
    );
    expect(res.status).toBe(200);

    const auditRows = await db
      .select()
      .from(adminProfileEditAudits)
      .where(eq(adminProfileEditAudits.targetUserId, userId));
    expect(auditRows.length).toBe(0);
  });

  it('does NOT write a profile-edit audit row when an admin submits a name/phone identical to the current value (no-op)', async () => {
    // Only actual changes get an audit row. A PATCH that submits the
    // same value the column already holds is a no-op and must not
    // pollute the audit table.
    const { userId } = await createUserAndLogin();
    const adminSession = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
    const [current] = await db.select().from(users).where(eq(users.id, userId));

    const res = await apiPatch(
      `/api/account/profile/${userId}`,
      { name: current.name, phone: current.phone },
      adminSession,
    );
    expect(res.status).toBe(200);

    const auditRows = await db
      .select()
      .from(adminProfileEditAudits)
      .where(eq(adminProfileEditAudits.targetUserId, userId));
    expect(auditRows.length).toBe(0);
  });

  it('does NOT write a profile-edit row for the email field — those go to admin_email_change_audits', async () => {
    // Email changes still flow through the dedicated email-change
    // audit table (task #325) because they go through a confirmation
    // step and need different post-write semantics. The profile-edit
    // table must stay scoped to the synchronous fields only.
    const { userId } = await createUserAndLogin();
    const adminSession = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
    const newEmail = uniqEmail('admin-email-only');

    const res = await apiPatch<{ emailChangeRequested: boolean }>(
      `/api/account/profile/${userId}`,
      { email: newEmail },
      adminSession,
    );
    expect(res.status).toBe(200);
    expect(res.data.data?.emailChangeRequested).toBe(true);

    const profileAudit = await db
      .select()
      .from(adminProfileEditAudits)
      .where(eq(adminProfileEditAudits.targetUserId, userId));
    expect(profileAudit.length).toBe(0);

    const emailAudit = await db
      .select()
      .from(adminEmailChangeAudits)
      .where(eq(adminEmailChangeAudits.targetUserId, userId));
    expect(emailAudit.length).toBe(1);
  });

  it('does NOT write an admin audit row when the user changes their OWN email', async () => {
    // Self-serve path is logged at INFO, not in the audit table —
    // task description is explicit about the asymmetry.
    const { userId, session } = await createUserAndLogin();
    const newEmail = uniqEmail('self-no-audit');

    const res = await apiPatch<{ emailChangeRequested: boolean }>(
      `/api/account/profile/${userId}`,
      { email: newEmail },
      session,
    );
    expect(res.status).toBe(200);
    expect(res.data.data?.emailChangeRequested).toBe(true);

    const auditRows = await db
      .select()
      .from(adminEmailChangeAudits)
      .where(eq(adminEmailChangeAudits.targetUserId, userId));
    expect(auditRows.length).toBe(0);
  });
});

describe('POST /api/account/confirm-email-change rate limiting', () => {
  it('trips the limiter after 30 failed confirms from one bucket, and other buckets are unaffected', async () => {
    const bucket = newBucketId();

    // 30 invalid-token attempts: all should return 400 INVALID_TOKEN.
    for (let i = 0; i < 30; i++) {
      const r = await postWithBucket(
        '/api/account/confirm-email-change',
        { token: `bf-${bucket}-${i}` },
        bucket,
      );
      expect(r.status).toBe(400);
      expect(r.body.error?.code).toBe('INVALID_TOKEN');
    }

    // The 31st attempt against the same bucket must be throttled.
    const blocked = await postWithBucket(
      '/api/account/confirm-email-change',
      { token: `bf-${bucket}-blocked` },
      bucket,
    );
    expect(blocked.status).toBe(429);
    expect(blocked.body.error?.code).toBe('RATE_LIMITED');

    // A different bucket is unaffected (per-key isolation).
    const fromOther = await postWithBucket(
      '/api/account/confirm-email-change',
      { token: 'unrelated' },
      newBucketId(),
    );
    expect(fromOther.status).toBe(400);
    expect(fromOther.body.error?.code).toBe('INVALID_TOKEN');
  });

  it('a fresh window allows requests again after the bucket counter resets', async () => {
    // Burn the bucket to 429, then ask the test-only reset endpoint to
    // clear that bucket's counter — semantically equivalent to the
    // express-rate-limit MemoryStore expiring the bucket once the
    // 10-minute window elapses, but without the wall-clock wait.
    const bucket = newBucketId();

    for (let i = 0; i < 30; i++) {
      const r = await postWithBucket(
        '/api/account/confirm-email-change',
        { token: `reset-${bucket}-${i}` },
        bucket,
      );
      expect(r.status).toBe(400);
    }
    const blocked = await postWithBucket(
      '/api/account/confirm-email-change',
      { token: `reset-${bucket}-blocked` },
      bucket,
    );
    expect(blocked.status).toBe(429);
    expect(blocked.body.error?.code).toBe('RATE_LIMITED');

    // Simulate the window rolling over.
    const reset = await postWithBucket(
      '/api/account/_test/reset-confirm-email-change-limit',
      {},
      bucket,
    );
    expect(reset.status).toBe(200);

    // A fresh window means the very next failed attempt is allowed
    // through to the route again (400, not 429), proving the limiter
    // does not permanently lock out callers.
    const afterReset = await postWithBucket(
      '/api/account/confirm-email-change',
      { token: `reset-${bucket}-post` },
      bucket,
    );
    expect(afterReset.status).toBe(400);
    expect(afterReset.body.error?.code).toBe('INVALID_TOKEN');
  });

  it('successful confirms do not count toward the limit (skipSuccessfulRequests)', async () => {
    // Burn 29 failed attempts on a fresh bucket, then successfully confirm
    // a real token, then verify we still have budget for one more failed
    // attempt — proving the success did NOT increment the bucket. (If it
    // had, the next failure below would be 429 instead of 400.)
    const bucket = newBucketId();

    for (let i = 0; i < 29; i++) {
      const r = await postWithBucket(
        '/api/account/confirm-email-change',
        { token: `skip-${bucket}-${i}` },
        bucket,
      );
      expect(r.status).toBe(400);
    }

    // Stage a real token and confirm it successfully.
    const password = await hashPassword(TEST_PASSWORD);
    const oldEmail = uniqEmail('rl-success');
    const [user] = await db
      .insert(users)
      .values({
        email: oldEmail,
        password,
        name: uniq('RL Success'),
        role: 'user',
        organizationId: testOrgId,
      })
      .returning();
    createdUserIds.push(user.id);

    const newEmail = uniqEmail('rl-success-new');
    const rawToken = `rl-ok-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    await db.insert(emailChangeRequests).values({
      userId: user.id,
      newEmail,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const ok = await postWithBucket(
      '/api/account/confirm-email-change',
      { token: rawToken },
      bucket,
    );
    expect(ok.status).toBe(200);

    // The 30th *failed* attempt should still be allowed (success above did
    // not count). This is the meat of the assertion.
    const stillAllowed = await postWithBucket(
      '/api/account/confirm-email-change',
      { token: `skip-${bucket}-final` },
      bucket,
    );
    expect(stillAllowed.status).toBe(400);
    expect(stillAllowed.body.error?.code).toBe('INVALID_TOKEN');

    // The very next failed attempt (our 31st failure on this bucket) trips.
    const blocked = await postWithBucket(
      '/api/account/confirm-email-change',
      { token: `skip-${bucket}-blocked` },
      bucket,
    );
    expect(blocked.status).toBe(429);
    expect(blocked.body.error?.code).toBe('RATE_LIMITED');
  });
});

// Quiet a TS warning when sql is imported but only sometimes used in future edits.
void sql;
