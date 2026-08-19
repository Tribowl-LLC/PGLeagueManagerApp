import { describe, expect, it } from 'vitest';
import { getActiveLegacyExpiry } from '../../scripts/migrate-legacy-account-actions';

function candidate(expiry: string | null) {
  return {
    userId: 1,
    email: 'legacy@example.com',
    name: 'Legacy User',
    organizationId: 1,
    organizationName: 'Legacy Org',
    organizationSlug: 'legacy',
    inviteTokenExpiry: expiry,
    hasInviteToken: true,
  };
}

describe('legacy account-action bridge', () => {
  it('preserves the original token expiration instead of extending it', () => {
    const original = '2030-01-02T03:04:05.000Z';
    expect(getActiveLegacyExpiry(candidate(original), Date.parse('2030-01-01T00:00:00.000Z'))?.toISOString())
      .toBe(original);
  });

  it('does not reissue an action that has expired before processing', () => {
    expect(getActiveLegacyExpiry(
      candidate('2030-01-01T00:00:00.000Z'),
      Date.parse('2030-01-01T00:00:00.001Z'),
    )).toBeNull();
  });
});
