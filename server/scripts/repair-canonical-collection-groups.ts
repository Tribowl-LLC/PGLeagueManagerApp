import { repairCanonicalCollectionGroups } from "../services/canonical-collection-group-repair.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function parsePairs(raw: string) {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("REPAIR_PAIRS_JSON must be a JSON array");
  return parsed as Array<{ triggerOccurrenceId: string; pairedOccurrenceId: string; triggerLocalDate: string; pairedLocalDate: string }>;
}

/**
 * Explicit production repair only. The orchestrator must supply every UUID
 * and date after independent evidence review; no candidate discovery occurs.
 */
const result = await repairCanonicalCollectionGroups({
  organizationId: Number(required("REPAIR_ORGANIZATION_ID")),
  leagueId: Number(required("REPAIR_LEAGUE_ID")),
  actorUserId: Number(required("REPAIR_ACTOR_USER_ID")),
  generationRunId: required("REPAIR_GENERATION_RUN_ID"),
  sourceScheduleRevision: Number(required("REPAIR_SOURCE_SCHEDULE_REVISION")),
  idempotencyKey: required("REPAIR_IDEMPOTENCY_KEY"),
  reason: required("REPAIR_REASON"),
  pairs: parsePairs(required("REPAIR_PAIRS_JSON")),
});
process.stdout.write(`${JSON.stringify(result)}\n`);
