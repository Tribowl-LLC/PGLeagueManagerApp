/**
 * Task #407: `bowlers.organization_id` is NOT NULL at the database level.
 *
 * Locks in the schema-level safety net so that any future code path
 * which forgets to stamp the owning organization on a new bowler is
 * rejected by Postgres instead of silently producing an invisible
 * orphan row. Pairs with the application-level stamping in
 * `server/routes/bowlers.ts`.
 */
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb } from '../setup/test-db';
const db = getTestDb();

// Drizzle wraps the raw pg error as `Error('Failed query: <sql>')` and puts
// the underlying Postgres error (whose message names the offending column /
// constraint) on `error.cause`. Match against the whole chain so the
// assertion checks the real DB error, not the echoed SQL text.
async function expectRejectsMatching(
  promise: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (e) {
    error = e;
  }
  expect(error, 'expected the query to reject').toBeDefined();
  const err = error as { message?: string; cause?: { message?: string } };
  const combined = `${err?.message ?? ''} ${err?.cause?.message ?? ''}`;
  expect(combined).toMatch(pattern);
}

describe('bowlers.organization_id NOT NULL constraint (task #407)', () => {
  it('rejects an INSERT that omits organization_id', async () => {
    await expectRejectsMatching(
      db.execute(
        sql`INSERT INTO bowlers (name) VALUES ('Vitest #407 Org-less Bowler')`,
      ),
      /organization_id/i,
    );
  });

  it('rejects an INSERT that explicitly sets organization_id = NULL', async () => {
    await expectRejectsMatching(
      db.execute(
        sql`INSERT INTO bowlers (name, organization_id) VALUES ('Vitest #407 Null Bowler', NULL)`,
      ),
      /organization_id/i,
    );
  });

  it('reports the column as NOT NULL in information_schema', async () => {
    const result = await db.execute(
      sql`SELECT is_nullable FROM information_schema.columns
          WHERE table_name = 'bowlers' AND column_name = 'organization_id'`,
    );
    const rows = result.rows as Array<{ is_nullable: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].is_nullable).toBe('NO');
  });
});
