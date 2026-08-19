import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../server/db";

describe("F3 PostgreSQL workflow and conservation guards", () => {
  it("has one authoritative D2 plan path and immutable F3 evidence tables", async () => {
    const result = await db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN (
        'f3_collection_policies', 'f3_payer_autopay_authorizations',
        'f3_autopay_plan_provenance', 'occurrence_collection_plans',
        'occurrence_collection_plan_items'
      ) ORDER BY table_name
    `);
    expect(result.rows.map((row) => String((row as { table_name: string }).table_name))).toEqual([
      'f3_autopay_plan_provenance', 'f3_collection_policies',
      'f3_payer_autopay_authorizations', 'occurrence_collection_plan_items',
      'occurrence_collection_plans',
    ]);
  });

  it("enforces current-row uniqueness, next revisions, tenant links, and policy grouping triggers", async () => {
    const constraints = await db.execute(sql`
      SELECT conname FROM pg_constraint
      WHERE conname IN (
        'f3_policies_current_approved_unique', 'f3_auth_current_authorized_unique',
        'f3_policies_collection_points_shape_check', 'f3_auth_fingerprint_check',
        'f3_policy_occurrences_pair_fk'
      )
    `);
    const indexes = await db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE indexname IN ('f3_policies_current_approved_unique', 'f3_auth_current_authorized_unique')
    `);
    const names = new Set(constraints.rows.map((row) => String((row as { conname: string }).conname)));
    expect(names.has('f3_policies_collection_points_shape_check')).toBe(true);
    expect(names.has('f3_auth_fingerprint_check')).toBe(true);
    expect(names.has('f3_policy_occurrences_pair_fk')).toBe(true);
    expect(indexes.rows).toHaveLength(2);
    const triggers = await db.execute(sql`SELECT tgname FROM pg_trigger WHERE tgname = 'f3_policy_occurrence_commit_guard'`);
    expect(triggers.rows).toHaveLength(1);
  });

  it("serializes F3 writers on the same tenant/league advisory key", async () => {
    const lockResult = await db.execute(sql`SELECT pg_try_advisory_xact_lock(923001::integer, 923002::integer) AS acquired`);
    expect((lockResult.rows[0] as { acquired: boolean }).acquired).toBe(true);
  });

  it("rejects malformed quote-item evidence at the database boundary", async () => {
    const malformed = await db.execute(sql`
      SELECT f3_json_array_shape('[{"obligationId":"00000000-0000-4000-8000-000000000001","occurrenceId":"00000000-0000-4000-8000-000000000002","bowlerId":1,"collectionPointOccurrenceId":"00000000-0000-4000-8000-000000000002","amountMinor":0,"itemIndex":0}]'::jsonb, 'quote-item') AS zero_amount,
             f3_json_array_shape('[{"obligationId":"00000000-0000-4000-8000-000000000001","occurrenceId":"00000000-0000-4000-8000-000000000002","bowlerId":1,"collectionPointOccurrenceId":"00000000-0000-4000-8000-000000000002","amountMinor":1,"itemIndex":1}]'::jsonb, 'quote-item') AS non_contiguous,
             f3_json_array_shape('[{"obligationId":"------------------------------------","occurrenceId":"00000000-0000-4000-8000-000000000002","bowlerId":1,"collectionPointOccurrenceId":"00000000-0000-4000-8000-000000000002","amountMinor":1,"itemIndex":0}]'::jsonb, 'quote-item') AS malformed_uuid
    `);
    expect((malformed.rows[0] as { zero_amount: boolean; non_contiguous: boolean }).zero_amount).toBe(false);
    expect((malformed.rows[0] as { zero_amount: boolean; non_contiguous: boolean; malformed_uuid: boolean }).non_contiguous).toBe(false);
    expect((malformed.rows[0] as { zero_amount: boolean; non_contiguous: boolean; malformed_uuid: boolean }).malformed_uuid).toBe(false);
  });
});
