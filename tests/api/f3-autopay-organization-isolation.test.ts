import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../server/db";

describe("F3 organization-isolation inventory", () => {
  it("keeps every F3 evidence table tenant-scoped with organization/league links", async () => {
    const result = await db.execute(sql`
      SELECT DISTINCT tc.table_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
      WHERE tc.table_schema = 'public'
        AND tc.table_name IN ('f3_collection_policies','f3_collection_policy_occurrences','f3_payer_autopay_authorizations','f3_autopay_plan_provenance')
        AND kcu.column_name = 'organization_id'
    `);
    expect(new Set(result.rows.map((row) => String((row as { table_name: string }).table_name)))).toEqual(new Set([
      'f3_collection_policies', 'f3_collection_policy_occurrences', 'f3_payer_autopay_authorizations', 'f3_autopay_plan_provenance',
    ]));
  });
});
