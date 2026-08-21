import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { sanitizeUser } from '../../server/utils/api';
import { users, insertUserSchema, type User } from '@shared/schema';

// Field-name patterns we never want to leak in any user-facing
// response. Broadened from the original /token|secret|password/i
// (task #327) to also catch `apiKey`, `clientSecret`, `webhookKey`,
// `credentials`, `authConfig`, etc. The implementation now uses an
// allowlist projection (`pick`), so anything not on the safe list is
// already dropped — this regex is the schema-side belt-and-suspenders.
const SENSITIVE_NAME_PATTERN = /token|secret|password|key|credential|auth/i;
// Benign columns whose names happen to match the broadened pattern
// but are safe to return (e.g. an `authProvider` enum). Add here
// only with explicit justification.
const SENSITIVE_NAME_ALLOWLIST = new Set<string>([
  // Task #455: this is a server-authoritative boolean flag (true
  // when an admin reset the user's password, false otherwise).
  // Surfacing it to the client is the whole point — the
  // ProtectedRoute guard reads it to bounce the user to
  // /change-password-required. The flag itself is not a credential.
  'mustChangePassword',
]);

// Build a fully-populated `User` so the test exercises every column the
// schema currently defines. This way, adding a new sensitive-looking column
// to `shared/schema/users.ts` immediately trips the test below.
//
// Routed through `insertUserSchema.parse(...)` (task #693) so a future
// required column added to `shared/schema/users.ts` fails LOUDLY here
// instead of rotting silently behind TypeScript's structural type check.
// Note: the password value below has to satisfy `passwordSchema` (8+
// chars, mixed case, digit, special) — the value is a stand-in, not a
// real credential, but it must pass the strong-password Zod refines.
function makeFullyPopulatedUser(): User {
  const parsed = insertUserSchema.parse({
    email: 'audit@example.com',
    password: 'AuditUser-1!do-not-leak',
    bowlerId: 42,
    name: 'Audit User',
    phone: '+15555550100',
    avatar: 'avatar-url',
    role: 'user',
    organizationId: 7,
    locationId: 3,
    preferredLanguage: 'en',
    mustChangePassword: false,
    failedPasswordChangeAttempts: 0,
    passwordChangeLockedUntil: null,
  });
  // `id` and `createdAt` are omitted from the insert schema, so we re-add
  // them to satisfy the SELECT type. `Object.assign` (instead of an
  // object literal) keeps the lint rule against object-literal `as`
  // casts happy.
  return Object.assign(
    {
      id: 1,
      createdAt: '2024-01-01T00:00:00.000Z',
      // Preserve defense-in-depth coverage for a stale object supplied by an
      // older caller even though these fields no longer exist in the schema.
      inviteToken: 'invite-token-do-not-leak',
      inviteTokenExpiry: '2099-01-01T00:00:00.000Z',
    },
    parsed,
  ) as User;
}

describe('sanitizeUser', () => {
  it('strips the known sensitive fields', () => {
    const sanitized = sanitizeUser(makeFullyPopulatedUser()) as Record<string, unknown>;
    expect(sanitized).not.toHaveProperty('password');
    expect(sanitized).not.toHaveProperty('inviteToken');
    expect(sanitized).not.toHaveProperty('inviteTokenExpiry');
  });

  it('preserves the safe fields', () => {
    const sanitized = sanitizeUser(makeFullyPopulatedUser());
    expect(sanitized.id).toBe(1);
    expect(sanitized.email).toBe('audit@example.com');
    expect(sanitized.name).toBe('Audit User');
    expect(sanitized.role).toBe('user');
    expect(sanitized.organizationId).toBe(7);
    expect(sanitized.locationId).toBe(3);
    expect(sanitized.bowlerId).toBe(42);
  });

  it('never returns any field whose name looks sensitive', () => {
    const sanitized = sanitizeUser(makeFullyPopulatedUser());
    const leaked = Object.keys(sanitized).filter(
      k => SENSITIVE_NAME_PATTERN.test(k) && !SENSITIVE_NAME_ALLOWLIST.has(k),
    );
    expect(leaked, `sanitizeUser leaked sensitive-looking fields: ${leaked.join(', ')}`).toEqual([]);
  });

  // Pin the contract to the live Drizzle schema: if a new column on `users`
  // is added with a name matching /token|secret|password/i, this test fails
  // until either `sanitizeUser` strips it or the column is renamed.
  it('strips every column on the users schema whose name looks sensitive', () => {
    const cols = Object.keys(getTableColumns(users));
    const sensitiveCols = cols.filter(
      c => SENSITIVE_NAME_PATTERN.test(c) && !SENSITIVE_NAME_ALLOWLIST.has(c),
    );
    // Build an object that has every column populated with a non-undefined
    // marker so `delete` is the only thing that can remove it.
    const fakeUser = Object.fromEntries(cols.map(c => [c, `__${c}__`])) as unknown as User;
    const sanitized = sanitizeUser(fakeUser) as Record<string, unknown>;
    for (const col of sensitiveCols) {
      expect(
        sanitized,
        `users.${col} matches the sensitive name pattern but sanitizeUser still returns it`,
      ).not.toHaveProperty(col);
    }
  });

  // Deny-by-default contract for the new allowlist projection (task
  // #327). A future column slipped in with a name the regex doesn't
  // catch (e.g. `apiKey`, `clientSecret`, `webhookKey`, `credentials`,
  // `authConfig`) must STILL be dropped, because it isn't on the
  // safe list. This is what makes the helper resistant to
  // unconventional column names.
  it('drops any field that is not on the allowlist, even if its name does not look sensitive', () => {
    const sneaky = {
      id: 1,
      email: 'a@b.com',
      name: 'A',
      role: 'user',
      // None of these names match the sensitive regex, but every
      // single one is a plausible secret-bearing column name.
      apiKey: 'sk_live_should_not_leak',
      clientSecret: 'cs_should_not_leak',
      webhookKey: 'whk_should_not_leak',
      credentials: { user: 'a', pass: 'b' },
      authConfig: { provider: 'oauth', clientSecret: 'leak' },
      arbitraryFutureColumn: 'should also be dropped',
    } as unknown as User;
    const sanitized = sanitizeUser(sneaky) as Record<string, unknown>;
    expect(sanitized).not.toHaveProperty('apiKey');
    expect(sanitized).not.toHaveProperty('clientSecret');
    expect(sanitized).not.toHaveProperty('webhookKey');
    expect(sanitized).not.toHaveProperty('credentials');
    expect(sanitized).not.toHaveProperty('authConfig');
    expect(sanitized).not.toHaveProperty('arbitraryFutureColumn');
    // Safe fields still pass through.
    expect(sanitized.id).toBe(1);
    expect(sanitized.email).toBe('a@b.com');
  });

  it('does not mutate the input user', () => {
    const input = makeFullyPopulatedUser();
    const snapshot = { ...input };
    sanitizeUser(input);
    expect(input).toEqual(snapshot);
  });
});
