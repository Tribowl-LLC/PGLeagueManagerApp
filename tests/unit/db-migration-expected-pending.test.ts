import { describe, expect, it } from 'vitest';
import {
  assertExpectedPendingMigrations,
  parseExpectedPendingMigrations,
} from '../../scripts/lib/db-migration-runner';

describe('production migration expected-pending guard', () => {
  it('leaves normal migration callers unchanged when the guard is absent', () => {
    expect(parseExpectedPendingMigrations(undefined)).toBeUndefined();
  });

  it('accepts an explicit no-op expectation', () => {
    expect(parseExpectedPendingMigrations('none')).toEqual([]);
  });

  it('accepts an ordered comma-separated migration list', () => {
    expect(parseExpectedPendingMigrations('0035_first, 0036_second')).toEqual([
      '0035_first',
      '0036_second',
    ]);
  });

  it.each(['', '   ', '0036-BAD', '0036_valid,0036_valid'])('rejects unsafe input %j', (value) => {
    expect(() => parseExpectedPendingMigrations(value)).toThrow();
  });

  it('accepts only the exact ordered pending list', () => {
    expect(() => assertExpectedPendingMigrations(['0035_first', '0036_second'], [
      '0035_first',
      '0036_second',
    ])).not.toThrow();
    expect(() => assertExpectedPendingMigrations(['0036_second'], ['0035_first', '0036_second']))
      .toThrow('do not exactly match expected');
    expect(() => assertExpectedPendingMigrations(['0036_second', '0035_first'], [
      '0035_first',
      '0036_second',
    ])).toThrow('do not exactly match expected');
  });
});
