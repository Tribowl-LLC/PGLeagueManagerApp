/**
 * Registration no longer accepts a client-selected organization. Canonical
 * host resolution is intentionally unavailable when active-organization
 * selection is ambiguous, regardless of body organizationId values.
 */
import { describe, expect, it } from 'vitest';
import { BASE_URL } from '../helpers';

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@vitest.local`;
}

async function postRegister(body: Record<string, unknown>): Promise<Response> {
  const csrfResponse = await fetch(`${BASE_URL}/api/csrf-token`);
  const csrfBody = await csrfResponse.json() as { data?: { token?: string } };
  const csrfToken = csrfBody.data?.token ?? '';
  const setCookie = csrfResponse.headers.getSetCookie?.() ?? [];
  const cookie = setCookie.map((value) => value.split(';', 1)[0]).join('; ');
  return fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-csrf-token': csrfToken,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/register — server-owned organization resolution', () => {
  it('fails closed when no organizationId is supplied', async () => {
    const res = await postRegister({
        email: uniqueEmail('register-no-org'),
        password: 'CorrectHorseBatteryStaple1!',
        name: 'No Org Sign Up',
      });
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.error?.code).toBe('SIGNUP_UNAVAILABLE');
  });

  it('fails closed when organizationId is the empty string', async () => {
    const res = await postRegister({
        email: uniqueEmail('register-empty-org'),
        password: 'CorrectHorseBatteryStaple1!',
        name: 'Empty Org Sign Up',
        organizationId: '',
      });
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.error?.code).toBe('SIGNUP_UNAVAILABLE');
  });

  it('fails closed when organizationId is non-numeric', async () => {
    const res = await postRegister({
        email: uniqueEmail('register-nan-org'),
        password: 'CorrectHorseBatteryStaple1!',
        name: 'NaN Org Sign Up',
        organizationId: 'not-a-number',
      });
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.error?.code).toBe('SIGNUP_UNAVAILABLE');
  });
});
