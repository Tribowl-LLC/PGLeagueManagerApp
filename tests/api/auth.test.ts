import { describe, it, expect } from 'vitest';
import { login, apiGet, apiPost, BASE_URL, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD } from '../helpers';

describe('Authentication', () => {
  describe('login', () => {
    it('rejects missing credentials', async () => {
      const res = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(401);
    });

    it('rejects wrong password', async () => {
      const res = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: TEST_ADMIN_EMAIL, password: 'wrong-password-xyz' }),
      });
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.success).toBe(false);
    });

    it('succeeds with valid credentials', async () => {
      const session = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
      expect(session.user.email).toBe(TEST_ADMIN_EMAIL);
      expect(session.cookies).toBeTruthy();
      expect(session.csrfToken).toBeTruthy();
    });
  });

  describe('unauthenticated access', () => {
    it('blocks unauthenticated requests to /api/leagues', async () => {
      const { status } = await apiGet('/api/leagues');
      expect(status).toBe(401);
    });

    it('blocks unauthenticated requests to /api/payments', async () => {
      const { status } = await apiGet('/api/payments');
      expect(status).toBe(401);
    });

    it('blocks unauthenticated requests to /api/bowlers', async () => {
      const { status } = await apiGet('/api/bowlers');
      expect(status).toBe(401);
    });

    it('blocks unauthenticated requests to /api/teams', async () => {
      const { status } = await apiGet('/api/teams');
      expect(status).toBe(401);
    });

    it('blocks unauthenticated requests to /api/locations', async () => {
      const { status } = await apiGet('/api/locations');
      expect(status).toBe(401);
    });

    it('blocks unauthenticated requests to /api/admin routes', async () => {
      const { status } = await apiGet('/api/admin/reports');
      expect(status).toBe(401);
    });

    it('blocks unauthenticated requests to /api/system-admin routes', async () => {
      const { status } = await apiGet('/api/system-admin/users');
      expect(status).toBe(401);
    });
  });

  describe('session', () => {
    it('authenticated user can access /api/auth/user', async () => {
      const session = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
      const { status, data } = await apiGet('/api/auth/user', session);
      expect(status).toBe(200);
      expect(data.success).toBe(true);
    });

    it('unauthenticated request to /api/auth/user returns 401', async () => {
      const { status } = await apiGet('/api/auth/user');
      expect(status).toBe(401);
    });

    it('logout invalidates session', async () => {
      const session = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);

      // Confirm session is valid
      const before = await apiGet('/api/auth/user', session);
      expect(before.status).toBe(200);

      // Logout
      const logoutRes = await fetch(`${BASE_URL}/api/auth/logout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.cookies,
          'x-csrf-token': session.csrfToken,
        },
      });
      expect(logoutRes.status).toBe(200);

      // Same cookies should now be rejected
      const after = await apiGet('/api/auth/user', session);
      expect(after.status).toBe(401);
    });
  });

  describe('CSRF protection', () => {
    it('POST without CSRF token is rejected on protected routes', async () => {
      const session = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);

      // Attempt POST without CSRF token
      const res = await fetch(`${BASE_URL}/api/leagues`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.cookies,
          // Deliberately omitting x-csrf-token
        },
        body: JSON.stringify({ name: 'No CSRF League' }),
      });
      expect(res.status).toBe(403);
    });
  });
});
