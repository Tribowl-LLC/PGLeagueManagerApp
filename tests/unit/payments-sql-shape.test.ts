/**
 * Query-shape tests for `buildPaymentConditions` (task #295).
 *
 * Pins the SQL fragments emitted for the system-admin org-less exclusion
 * branch and the per-org JOIN branch without needing DDL mutation of the
 * shared `leagues.organization_id NOT NULL` constraint. Complements the
 * route-level integration tests in `tests/api/payments-by-org.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { and } from 'drizzle-orm';
import { getTestDb } from '../setup/test-db';
const db = getTestDb();
import { payments } from '@shared/schema';
import { buildPaymentConditions } from '../../server/storage/payments';

function sqlFor(conditions: ReturnType<typeof buildPaymentConditions>): string {
  // eslint-disable-next-line leaguevault/no-unscoped-table-query-in-test-assertion -- this query is never executed: `.toSQL().sql` only inspects the emitted SQL string for shape assertions.
  return db.select().from(payments).where(and(...conditions)).toSQL().sql;
}

describe('buildPaymentConditions — emitted SQL shape', () => {
  it('system-admin path (no org filter, excludeOrgLessLeagues) excludes org-less leagues', () => {
    const sqlText = sqlFor(buildPaymentConditions({}, { excludeOrgLessLeagues: true }));
    expect(sqlText).toMatch(/"organization_id" is not null/i);
    expect(sqlText).toMatch(/"league_id" in \(select "id" from "leagues"/i);
  });

  it('org-scoped path constrains payments to the supplied organization', () => {
    const sqlText = sqlFor(buildPaymentConditions({ organizationId: 42 }));
    expect(sqlText).toMatch(/"organization_id" = \$1/i);
    expect(sqlText).toMatch(/"league_id" in \(select "id" from "leagues" where "leagues"."organization_id" = \$\d+/i);
    expect(sqlText).not.toMatch(/is not null/i);
  });

  it('default org-user path (no excludeOrgLessLeagues, no orgId) emits no league join clause', () => {
    const sqlText = sqlFor(buildPaymentConditions({}));
    expect(sqlText).not.toMatch(/"league_id" in \(select/i);
    expect(sqlText).not.toMatch(/is not null/i);
  });

  it('correlates a team membership to the payment league', () => {
    const sqlText = sqlFor(buildPaymentConditions({ organizationId: 42, teamId: 7 }));
    expect(sqlText).toMatch(/exists \(\s*select 1\s*from "bowler_leagues"/i);
    expect(sqlText).toMatch(/"bowler_leagues"\."bowler_id" = "payments"\."bowler_id"/i);
    expect(sqlText).toMatch(/"bowler_leagues"\."team_id" = \$\d+/i);
    expect(sqlText).toMatch(/"bowler_leagues"\."league_id" = "payments"\."league_id"/i);
  });
});
