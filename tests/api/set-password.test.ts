/**
 * Integration tests for POST /api/auth/set-password.
 *
 * Task #352 extends the change-password (#318) "force-log-out other
 * sessions" defense to the unauthenticated reset / set-password flow.
 * The user clicking a reset link is overwhelmingly likely to be doing
 * so because they suspect compromise, so any leftover session for
 * that user must die — not just "all other sessions besides the
 * caller's", since the caller has no current session here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../server/db';
import { accountActionRequests, users } from '@shared/schema';
import { hashPassword } from '../../server/lib/password';
import { storage } from '../../server/storage';
import { login, purgeSessionCache, BASE_URL, getBaselineOrgAId, type AuthSession } from '../helpers';

const ORIGINAL_PASSWORD = 'SetPwTest!2026';
const NEW_PASSWORD = 'BrandNewSetPw!2026XX';

// Task #607: attach users to the seeded `vitest-org-a` baseline.
const createdUserIds: number[] = [];

let testOrgId: number;

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
function uniqEmail(prefix: string): string {
  return `${uniq(prefix)}@vitest.local`;
}

beforeAll(async () => {
  testOrgId = await getBaselineOrgAId();
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
    createdUserIds.length = 0;
  }
});

async function createUserWithPassword(): Promise<{ userId: number; email: string }> {
  const email = uniqEmail('sp');
  const password = await hashPassword(ORIGINAL_PASSWORD);
  const [user] = await db
    .insert(users)
    .values({
      email,
      password,
      name: uniq('SP User'),
      role: 'user',
      organizationId: testOrgId,
    })
    .returning();
  createdUserIds.push(user.id);
  return { userId: user.id, email };
}

async function loggedInSession(email: string): Promise<AuthSession> {
  return login(email, ORIGINAL_PASSWORD);
}

async function issueResetToken(userId: number, recipientEmail: string): Promise<string> {
  const issued = await issueResetAction(userId, recipientEmail);
  return issued.token;
}

async function issueResetAction(userId: number, recipientEmail: string) {
  const issued = await storage.issueAccountAction({
    userId,
    action: 'password_reset',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    organizationId: testOrgId,
    recipientEmail,
  });
  return issued;
}

async function callSetPassword(token: string, password: string) {
  const res = await fetch(`${BASE_URL}/api/auth/set-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, password }),
  });
  return { status: res.status, body: (await res.json()) as { success: boolean } };
}

async function callValidateInvite(token: string) {
  const res = await fetch(`${BASE_URL}/api/auth/validate-invite?token=${encodeURIComponent(token)}`);
  return { status: res.status, body: await res.json() as {
    success: boolean;
    data?: { email?: string; action?: string };
    error?: { code?: string; message?: string };
  } };
}

describe('GET /api/auth/validate-invite · account action contract', () => {
  it('validates both invitations and password resets, and repeated GETs do not consume either token', async () => {
    const { userId, email } = await createUserWithPassword();
    const invite = await storage.issueAccountAction({
      userId,
      action: 'account_invite',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      organizationId: testOrgId,
    });
    const reset = await issueResetAction(userId, email);

    for (const [token, action] of [
      [invite.token, 'account_invite'],
      [reset.token, 'password_reset'],
    ] as const) {
      const first = await callValidateInvite(token);
      const second = await callValidateInvite(token);

      expect(first.status).toBe(200);
      expect(first.body).toEqual({
        success: true,
        data: { email: expect.stringMatching(/^s\*\*\*@vitest\.local$/), action },
      });
      expect(second.body).toEqual(first.body);
    }

    const [inviteRow, resetRow] = await Promise.all([
      db.select({ status: accountActionRequests.status })
        .from(accountActionRequests)
        .where(eq(accountActionRequests.id, invite.request.id)),
      db.select({ status: accountActionRequests.status })
        .from(accountActionRequests)
        .where(eq(accountActionRequests.id, reset.request.id)),
    ]);
    expect(inviteRow[0]?.status).toBe('pending');
    expect(resetRow[0]?.status).toBe('pending');
  });

  it('returns deliberate terminal-state codes without exposing account data', async () => {
    const expiredFixture = await createUserWithPassword();
    const expired = await issueResetAction(expiredFixture.userId, expiredFixture.email);
    await db.update(accountActionRequests)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(accountActionRequests.id, expired.request.id));

    const consumedFixture = await createUserWithPassword();
    const consumed = await issueResetAction(consumedFixture.userId, consumedFixture.email);
    expect(await storage.consumeAccountActionAndSetPassword({
      token: consumed.token,
      passwordHash: 'consumed-by-validator-test',
    })).toBeTruthy();

    const supersededFixture = await createUserWithPassword();
    const superseded = await storage.issueAccountAction({
      userId: supersededFixture.userId,
      action: 'account_invite',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      organizationId: testOrgId,
    });
    await storage.issueAccountAction({
      userId: supersededFixture.userId,
      action: 'account_invite',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      organizationId: testOrgId,
    });

    const revokedFixture = await createUserWithPassword();
    const revoked = await storage.issueAccountAction({
      userId: revokedFixture.userId,
      action: 'account_invite',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      organizationId: testOrgId,
    });
    expect(await storage.revokeAccountAction(revoked.request.id)).toBeTruthy();

    const cases = [
      [expired.token, 'TOKEN_EXPIRED'],
      [consumed.token, 'TOKEN_USED'],
      [superseded.token, 'TOKEN_SUPERSEDED'],
      [revoked.token, 'TOKEN_REVOKED'],
    ] as const;
    for (const [token, code] of cases) {
      const result = await callValidateInvite(token);
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ success: false, error: { code } });
      expect(result.body).not.toHaveProperty('data');
      expect(JSON.stringify(result.body)).not.toContain('@vitest.local');
    }
  });

  it('keeps an earlier usable password-reset link valid when a newer link is issued, then revokes the sibling on completion', async () => {
    const { userId, email } = await createUserWithPassword();
    const first = await issueResetAction(userId, email);
    const second = await issueResetAction(userId, email);

    // Password recovery intentionally preserves still-usable links so a
    // delayed email cannot strand the account. Invitation issuance retains
    // the older supersession behavior tested by the terminal-state case
    // below.
    expect((await callValidateInvite(first.token)).status).toBe(200);
    expect((await callValidateInvite(second.token)).status).toBe(200);

    const completed = await callSetPassword(first.token, NEW_PASSWORD);
    expect(completed.status).toBe(200);
    expect(completed.body.success).toBe(true);

    // Completion rotates credentials and the database trigger revokes every
    // remaining pending credential action. The sibling is revoked rather
    // than superseded, preserving the terminal state used for credential
    // invalidation.
    const sibling = await callValidateInvite(second.token);
    expect(sibling.status).toBe(400);
    expect(sibling.body.error?.code).toBe('TOKEN_REVOKED');
  });

  it('rejects missing, malformed, unsupported, and overlong tokens without account lookup leakage', async () => {
    const missing = await fetch(`${BASE_URL}/api/auth/validate-invite`);
    expect(missing.status).toBe(400);
    expect((await missing.json()).error.code).toBe('VALIDATION_ERROR');

    const malformed = await callValidateInvite('definitely-not-a-real-token');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error?.code).toBe('INVALID_TOKEN');

    const overlong = await callValidateInvite('x'.repeat(257));
    expect(overlong.status).toBe(400);
    expect(overlong.body.error?.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/auth/set-password · force-log-out (task #352)', () => {
  it('destroys every existing session for the user after a successful reset', async () => {
    // The user has TWO devices logged in — the laptop they suspect
    // is compromised (sessionA) and the phone they're using to
    // reset (sessionB). They never re-login on either of these
    // sessions; instead they click the reset link in their email,
    // which hits set-password unauthenticated. After the reset,
    // BOTH leftover sessions must be dead.
    const { userId, email } = await createUserWithPassword();
    const sessionA = await loggedInSession(email);
    // Drop the cached entry so sessionB is a genuinely distinct
    // session row, not a return of the same `sessionA` object — the
    // load-bearing assertion below requires both sessions to be
    // independently invalidated by the reset.
    purgeSessionCache(email);
    const sessionB = await loggedInSession(email);

    // Sanity: both are live before the reset.
    for (const s of [sessionA, sessionB]) {
      const r = await fetch(`${BASE_URL}/api/auth/user`, { headers: { Cookie: s.cookies } });
      expect(r.status).toBe(200);
    }

    const token = await issueResetToken(userId, email);
    const reset = await callSetPassword(token, NEW_PASSWORD);
    expect(reset.status).toBe(200);
    expect(reset.body.success).toBe(true);

    // Both pre-reset sessions must now be invalidated. This is the
    // load-bearing assertion of #352 — without the
    // destroyOtherSessionsForUser call in the route, sessionA and
    // sessionB would still be honored until their cookies expired.
    for (const s of [sessionA, sessionB]) {
      const r = await fetch(`${BASE_URL}/api/auth/user`, { headers: { Cookie: s.cookies } });
      expect(r.status).toBe(401);
    }

    // The new password actually works (the rotation committed; the
    // session destruction didn't somehow roll it back).
    purgeSessionCache(email);
    const newSession = await login(email, NEW_PASSWORD);
    expect(newSession.user.email).toBe(email);
  });

  it('clears mustChangePassword when a flagged user recovers via the set-password / forgot-password flow (task #455)', async () => {
    // After an admin reset, requirePasswordRotated traps the user
    // on /change-password-required until the flag clears. The user
    // is allowed to use either /api/account/change-password OR the
    // unauthenticated forgot-password / set-password flow (the
    // admin-emailed temp password is exactly the kind of thing
    // people lose, so forcing them to remember it before recovery
    // would be hostile). This test pins that set-password also
    // clears the flag — without that clear, a user who recovered
    // via the email link would still be locked out by the gate even
    // though the credential the admin knew is now dead, defeating
    // the recovery path entirely.
    const { userId, email } = await createUserWithPassword();
    // Simulate the admin reset having flagged the row.
    await storage.updateUser(userId, { mustChangePassword: true });
    const flagged = await storage.getUser(userId);
    expect(flagged?.mustChangePassword).toBe(true);

    const token = await issueResetToken(userId, email);
    const reset = await callSetPassword(token, NEW_PASSWORD);
    expect(reset.status).toBe(200);
    expect(reset.body.success).toBe(true);

    // Load-bearing assertion: the row must be unflagged after the
    // user has chosen a new password through the recovery flow.
    const after = await storage.getUser(userId);
    expect(after?.mustChangePassword).toBe(false);

    // And the new credentials let them in clean — proving the gate
    // would no longer 403 their next protected API call.
    const newSession = await login(email, NEW_PASSWORD);
    expect(newSession.user.email).toBe(email);
  });

  it('still completes the reset (and returns 200) when the user has no existing sessions', async () => {
    // Pure-happy-path regression guard — destroying zero sessions
    // must not cause the destroy step (or the surrounding handler)
    // to fail. This pins that the count==0 branch is harmless.
    const { userId, email } = await createUserWithPassword();
    const token = await issueResetToken(userId, email);

    const reset = await callSetPassword(token, NEW_PASSWORD);
    expect(reset.status).toBe(200);
    expect(reset.body.success).toBe(true);

    // Old credentials gone, new credentials work.
    const oldLogin = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: ORIGINAL_PASSWORD }),
    });
    expect(oldLogin.status).toBe(401);

    const newSession = await login(email, NEW_PASSWORD);
    expect(newSession.user.email).toBe(email);
  });
});
