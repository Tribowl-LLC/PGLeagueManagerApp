/**
 * Integration tests for POST /api/account/change-password (task #255).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../server/db';
import { users } from '@shared/schema';
import { hashPassword } from '../../server/lib/password';
import {
  apiPost,
  login,
  purgeSessionCache,
  BASE_URL,
  getBaselineOrgAId,
  type AuthSession,
} from '../helpers';

// Task #607: attach users to the seeded `vitest-org-a` baseline.
const createdUserIds: number[] = [];

const ORIGINAL_PASSWORD = 'ChangePwTest!2026';
const NEW_STRONG_PASSWORD = 'BrandNewPw!2026XX';

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

async function createUserAndLogin(): Promise<{
  userId: number;
  email: string;
  session: AuthSession;
}> {
  const email = uniqEmail('cp');
  const password = await hashPassword(ORIGINAL_PASSWORD);
  const [user] = await db
    .insert(users)
    .values({
      email,
      password,
      name: uniq('CP User'),
      role: 'user',
      organizationId: testOrgId,
    })
    .returning();
  createdUserIds.push(user.id);
  const session = await login(email, ORIGINAL_PASSWORD);
  return { userId: user.id, email, session };
}

describe('POST /api/account/change-password', () => {
  it('replaces the password on success: old credentials stop working, new credentials work', async () => {
    const { email, session } = await createUserAndLogin();

    const res = await apiPost<{ message: string }>(
      '/api/account/change-password',
      { currentPassword: ORIGINAL_PASSWORD, newPassword: NEW_STRONG_PASSWORD },
      session,
    );
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);

    const oldLogin = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: ORIGINAL_PASSWORD }),
    });
    expect(oldLogin.status).toBe(401);

    // Password just rotated — the cached session for `email` is now
    // tied to the OLD credential. Drop it so the next `login()` call
    // performs a real round-trip against the new password.
    purgeSessionCache(email);
    const newSession = await login(email, NEW_STRONG_PASSWORD);
    expect(newSession.user.email).toBe(email);
  });

  it('rejects a wrong current password with INVALID_PASSWORD and does not change the hash', async () => {
    const { userId, email, session } = await createUserAndLogin();

    const [before] = await db
      .select({ password: users.password })
      .from(users)
      .where(eq(users.id, userId));

    const res = await apiPost(
      '/api/account/change-password',
      { currentPassword: 'totally-wrong-current', newPassword: NEW_STRONG_PASSWORD },
      session,
    );
    expect(res.status).toBe(400);
    expect(res.data.success).toBe(false);
    expect(res.data.error?.code).toBe('INVALID_PASSWORD');

    const [after] = await db
      .select({ password: users.password })
      .from(users)
      .where(eq(users.id, userId));
    expect(after.password).toBe(before.password);

    const stillWorks = await login(email, ORIGINAL_PASSWORD);
    expect(stillWorks.user.email).toBe(email);
  });

  it('rejects a weak new password (fails passwordSchema) before writing the hash', async () => {
    const { userId, session } = await createUserAndLogin();

    const [before] = await db
      .select({ password: users.password })
      .from(users)
      .where(eq(users.id, userId));

    const res = await apiPost(
      '/api/account/change-password',
      { currentPassword: ORIGINAL_PASSWORD, newPassword: 'short' },
      session,
    );
    expect(res.status).toBe(400);
    expect(res.data.success).toBe(false);

    const [after] = await db
      .select({ password: users.password })
      .from(users)
      .where(eq(users.id, userId));
    expect(after.password).toBe(before.password);
  });

  it('destroys other sessions and refreshes the caller session after rotation (task #318)', async () => {
    const { email, session: sessionA } = await createUserAndLogin();
    // Second session for the SAME user — simulates another device or a
    // stolen cookie that we want force-logged-out by the password change.
    // Purge the cached entry from createUserAndLogin so this is a
    // genuinely distinct HTTP login (and therefore a distinct session
    // row), not a return of the same `sessionA` object.
    purgeSessionCache(email);
    const sessionB = await login(email, ORIGINAL_PASSWORD);

    // Sanity: sessionB can hit an authenticated endpoint before the change.
    const beforeB = await fetch(`${BASE_URL}/api/auth/user`, {
      headers: { Cookie: sessionB.cookies },
    });
    expect(beforeB.status).toBe(200);

    // Passport re-serializes the user after the trigger advances the
    // credential generation. That regeneration invalidates the old SID and
    // sends a replacement `connect.sid` cookie, so capture the response
    // headers here instead of using the helper which intentionally returns
    // only the decoded API body.
    const changeResponse = await fetch(`${BASE_URL}/api/account/change-password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionA.cookies,
        'x-csrf-token': sessionA.csrfToken,
        'x-test-rate-limit-bypass': '1',
        'x-test-suppress-apple-pay-kick': '1',
      },
      body: JSON.stringify({
        currentPassword: ORIGINAL_PASSWORD,
        newPassword: NEW_STRONG_PASSWORD,
      }),
    });
    expect(changeResponse.status).toBe(200);
    const changeBody = await changeResponse.json() as { success: boolean };
    expect(changeBody.success).toBe(true);
    const refreshedCookies = (changeResponse.headers.getSetCookie?.() ?? [])
      .map(cookie => cookie.split(';')[0])
      .join('; ');
    expect(refreshedCookies).toMatch(/^connect\.sid=/);

    // sessionB must now be invalidated.
    const afterB = await fetch(`${BASE_URL}/api/auth/user`, {
      headers: { Cookie: sessionB.cookies },
    });
    expect(afterB.status).toBe(401);

    // The old caller SID is invalidated by Passport's session regeneration.
    const afterA = await fetch(`${BASE_URL}/api/auth/user`, {
      headers: { Cookie: sessionA.cookies },
    });
    expect(afterA.status).toBe(401);

    // The browser automatically adopts the replacement Set-Cookie header;
    // this is the session that must remain authorized after the self-service
    // change.
    const afterRefreshedA = await fetch(`${BASE_URL}/api/auth/user`, {
      headers: { Cookie: refreshedCookies },
    });
    expect(afterRefreshedA.status).toBe(200);
  });

  it('throttles repeated change-password attempts with RATE_LIMITED (task #317)', async () => {
    const { session } = await createUserAndLogin();

    // Limiter is set to 10/15min keyed on userId. Burn through the
    // budget with intentionally-wrong current passwords (so we
    // exercise the limiter without actually rotating the password)
    // and assert the 11th call is rejected as throttled instead of
    // INVALID_PASSWORD.
    let lastStatus = 0;
    let lastBody: { error?: { code?: string } } | null = null;
    for (let i = 0; i < 10; i++) {
      const r = await apiPost<unknown>(
        '/api/account/change-password',
        { currentPassword: `wrong-${i}`, newPassword: NEW_STRONG_PASSWORD },
        session,
      );
      lastStatus = r.status;
      lastBody = r.data as { error?: { code?: string } };
    }
    expect(lastStatus).toBe(400);
    expect(lastBody?.error?.code).toBe('INVALID_PASSWORD');

    const throttled = await apiPost(
      '/api/account/change-password',
      { currentPassword: 'wrong-final', newPassword: NEW_STRONG_PASSWORD },
      session,
    );
    expect(throttled.status).toBe(429);
    expect(throttled.data.success).toBe(false);
    expect(throttled.data.error?.code).toBe('RATE_LIMITED');
  });

  it('dispatches the password-changed notification email without blocking or failing the response (task #353)', async () => {
    // The notification helper is invoked as fire-and-forget AFTER the
    // password update + session-cleanup commit. We can't mock SendGrid
    // across the integration server's process boundary, but we CAN
    // assert the contract that matters end-to-end:
    //   1. The change-password route still returns 200 promptly even
    //      though it now triggers an outbound SendGrid call.
    //   2. The password rotation actually committed (new credentials
    //      work; old ones don't), so a SendGrid hiccup didn't somehow
    //      roll the change back.
    //   3. The route returns within a tight bound, proving the email
    //      send is not awaited inline.
    // A failing helper would surface in server logs; the route itself
    // must stay successful and snappy.
    const { email, session } = await createUserAndLogin();

    const startedAt = Date.now();
    const res = await apiPost<{ message: string }>(
      '/api/account/change-password',
      { currentPassword: ORIGINAL_PASSWORD, newPassword: NEW_STRONG_PASSWORD },
      session,
    );
    const elapsedMs = Date.now() - startedAt;

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    // Loose upper bound — the route does a couple of DB writes, a
    // session-store sweep, and *fires off* (does not await) the
    // SendGrid call. If we ever accidentally `await` the mailer the
    // wall-clock here will balloon to seconds.
    expect(elapsedMs).toBeLessThan(3000);

    // Old creds dead, new creds live → the rotation really happened.
    const oldLogin = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: ORIGINAL_PASSWORD }),
    });
    expect(oldLogin.status).toBe(401);

    // Password rotated — drop the cached old-credential session.
    purgeSessionCache(email);
    const newSession = await login(email, NEW_STRONG_PASSWORD);
    expect(newSession.user.email).toBe(email);
  });

  it('rejects an unauthenticated request with AUTH_REQUIRED', async () => {
    // Fetch CSRF token+cookie without logging in so the request reaches
    // requireAuth instead of being 403'd by CSRF middleware first.
    const csrfRes = await fetch(`${BASE_URL}/api/csrf-token`);
    const cookies = (csrfRes.headers.getSetCookie?.() ?? [])
      .map(c => c.split(';')[0])
      .join('; ');
    const csrfBody = await csrfRes.json();
    const csrfToken: string = csrfBody?.data?.token ?? '';
    expect(csrfToken).toBeTruthy();

    const res = await fetch(`${BASE_URL}/api/account/change-password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookies,
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify({
        currentPassword: ORIGINAL_PASSWORD,
        newPassword: NEW_STRONG_PASSWORD,
      }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe('AUTH_REQUIRED');
  });
});
