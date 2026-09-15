/**
 * Bowler phone validation contract for the shared insert/update schemas.
 *
 * `insertBowlerSchema.phone` and `updateBowlerSchema.phone` share one
 * refinement: an optional leading `+`, then digits, spaces, parentheses,
 * dots, and hyphens, with 9-16 digits without `+` and 9-15 digits with `+`.
 * Empty string clears the value (update) / is accepted (insert); null is
 * accepted on both; missing is accepted on both. Anything else — emails,
 * letters, other symbols, or a digit count outside those bounds — is
 * rejected with a `phone`-path issue.
 */
import { describe, expect, it } from 'vitest';
import { insertBowlerSchema, insertUserSchema, updateBowlerSchema } from '../../shared/schema';
import { profileUpdateSchema } from '../../server/routes/account-shared';

const VALID_PHONES = [
  '+12025550123',
  '(202)555-0123',
  '202.555.0123',
  '123456789', // 9-digit lower bound
  '1234567890123456', // 16-digit upper bound
  '+123456789012345', // E.164 15-digit upper bound
];

const INVALID_PHONES: [string, string][] = [
  ['an email address', 'alex@example.com'],
  ['letters mixed into digits', 'callme555'],
  ['fewer than 9 digits (8)', '12345678'],
  ['more than 16 digits (17)', '12345678901234567'],
  ['unsupported symbols', '+12025550123!'],
  ['a double leading plus', '++12025550123'],
  ['a leading plus with 16 digits', '+1234567890123456'],
];

const PHONE_MESSAGE = 'Enter a valid phone number';

function expectPhoneIssue(result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) {
  expect(result.success).toBe(false);
  expect(result.error?.issues).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: ['phone'], message: PHONE_MESSAGE }),
  ]));
}

describe('insertBowlerSchema phone validation', () => {
  it.each(VALID_PHONES)('accepts %s', (phone) => {
    const parsed = insertBowlerSchema.parse({ name: 'Ada Bowler', phone });
    expect(parsed.phone).toBe(phone);
  });

  it('trims surrounding whitespace from a valid number', () => {
    const parsed = insertBowlerSchema.parse({ name: 'Ada Bowler', phone: '  (202) 555-0123  ' });
    expect(parsed.phone).toBe('(202) 555-0123');
  });

  it('accepts null, an empty string, and a missing phone', () => {
    expect(insertBowlerSchema.parse({ name: 'Ada Bowler', phone: null }).phone).toBeNull();
    expect(insertBowlerSchema.parse({ name: 'Ada Bowler', phone: '' }).phone).toBe('');
    expect(insertBowlerSchema.parse({ name: 'Ada Bowler' }).phone).toBeUndefined();
  });

  it.each(INVALID_PHONES)('rejects %s with a phone-path issue', (_caseName, phone) => {
    expectPhoneIssue(insertBowlerSchema.safeParse({ name: 'Ada Bowler', phone }));
  });
});

describe('updateBowlerSchema phone validation', () => {
  it.each(VALID_PHONES)('accepts %s', (phone) => {
    const parsed = updateBowlerSchema.parse({ phone });
    expect(parsed.phone).toBe(phone);
  });

  it('trims surrounding whitespace from a valid number', () => {
    const parsed = updateBowlerSchema.parse({ phone: '  +12025550123  ' });
    expect(parsed.phone).toBe('+12025550123');
  });

  it('accepts null and an empty string (clears the value)', () => {
    expect(updateBowlerSchema.parse({ phone: null }).phone).toBeNull();
    expect(updateBowlerSchema.parse({ phone: '' }).phone).toBe('');
  });

  it('accepts a payload that omits phone', () => {
    const parsed = updateBowlerSchema.parse({ name: 'New Name' });
    expect(parsed.phone).toBeUndefined();
  });

  it.each(INVALID_PHONES)('rejects %s with a phone-path issue', (_caseName, phone) => {
    expectPhoneIssue(updateBowlerSchema.safeParse({ phone }));
  });
});

describe('profileUpdateSchema phone validation', () => {
  it('rejects an email-shaped phone value with a phone-path issue', () => {
    expectPhoneIssue(profileUpdateSchema.safeParse({ phone: 'alex@example.com' }));
  });

  it('preserves a valid trimmed phone value', () => {
    const parsed = profileUpdateSchema.parse({ phone: '  +12025550123  ' });
    expect(parsed.phone).toBe('+12025550123');
  });

  it('preserves an explicit null clear', () => {
    const parsed = profileUpdateSchema.parse({ phone: null });
    expect(parsed.phone).toBeNull();
  });

  it('preserves an empty clear as null', () => {
    const parsed = profileUpdateSchema.parse({ phone: '' });
    expect(parsed.phone).toBeNull();
  });

  it('preserves a whitespace-only clear as null', () => {
    const parsed = profileUpdateSchema.parse({ phone: '   ' });
    expect(parsed.phone).toBeNull();
  });

  it('preserves an omitted phone as undefined', () => {
    const parsed = profileUpdateSchema.parse({});
    expect(parsed.phone).toBeUndefined();
  });
});

describe('insertUserSchema phone validation', () => {
  const userInput = {
    email: 'phone-schema-user@example.com',
    name: 'Phone Schema User',
    password: 'PhoneSchemaUser-1!',
    role: 'user' as const,
    // The insert schema requires an organization for non-admin users. This
    // positive ID is sufficient for the schema contract; FK existence is
    // enforced by the database at persistence time.
    organizationId: 1,
  };

  it('accepts a valid phone, an empty string, and omission', () => {
    expect(insertUserSchema.parse({ ...userInput, phone: '+12025550123' }).phone).toBe('+12025550123');
    expect(insertUserSchema.parse({ ...userInput, phone: '' }).phone).toBe('');
    expect(insertUserSchema.parse(userInput).phone).toBeUndefined();
  });
});
