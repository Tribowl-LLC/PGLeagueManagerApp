import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { users } from '@shared/schema';
import { getTestDb } from '../setup/test-db';
import {
  apiPost,
  login,
  TEST_ORG_A_EMAIL,
  TEST_ORG_PASSWORD,
  type AuthSession,
} from '../helpers';

const db = getTestDb();
let session: AuthSession;
const createdEmails: string[] = [];

beforeAll(async () => {
  session = await login(TEST_ORG_A_EMAIL, TEST_ORG_PASSWORD);
});

afterAll(async () => {
  for (const email of createdEmails) {
    await db.delete(users).where(eq(users.email, email));
  }
});

describe('user email creation race', () => {
  it('returns a stable conflict instead of a 500 for concurrent normalized duplicates', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const normalizedEmail = `create-race-${stamp}@example.com`;
    createdEmails.push(normalizedEmail);

    const [first, second] = await Promise.all([
      apiPost('/api/org-admin/users/create', {
        firstName: 'Create',
        lastName: 'Race One',
        email: normalizedEmail,
        role: 'user',
      }, session),
      apiPost('/api/org-admin/users/create', {
        firstName: 'Create',
        lastName: 'Race Two',
        email: normalizedEmail,
        role: 'user',
      }, session),
    ]);

    expect([first.status, second.status].sort((a, b) => a - b)).toEqual([200, 409]);
    const conflict = first.status === 409 ? first : second;
    expect(conflict.data.error?.code).toBe('conflict');
    const rows = await db.select({ id: users.id }).from(users)
      .where(eq(users.email, normalizedEmail));
    expect(rows).toHaveLength(1);
  });
});
