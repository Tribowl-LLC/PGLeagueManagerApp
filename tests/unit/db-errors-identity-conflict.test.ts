import { describe, expect, it } from 'vitest';
import { isNormalizedUserEmailConflict } from '../../server/utils/db-errors';

describe('normalized user email conflict detection', () => {
  it('recognizes the wrapped Postgres uniqueness error produced by Drizzle', () => {
    const error = new Error('Failed query', {
      cause: Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'users_email_normalized_unique',
      }),
    });
    expect(isNormalizedUserEmailConflict(error)).toBe(true);
  });

  it('does not relabel unrelated unique violations', () => {
    expect(isNormalizedUserEmailConflict({
      code: '23505',
      constraint: 'another_unique_constraint',
    })).toBe(false);
  });

  it('also recognizes the exact-email constraint reached after write normalization', () => {
    expect(isNormalizedUserEmailConflict({
      code: '23505',
      constraint: 'users_email_unique',
    })).toBe(true);
  });
});
