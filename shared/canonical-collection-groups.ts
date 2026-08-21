import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Canonical collection grouping is evidence about collection timing only. It
 * never changes the physical occurrence, billing term, ordinal, or amount.
 */
export const CANONICAL_COLLECTION_GROUP_CONTRACT_VERSION = "canonical-collection-group/1" as const;
export const CANONICAL_COLLECTION_GROUP_RESULT_VERSION = "canonical-collection-group-result/1" as const;
export const CANONICAL_COLLECTION_GROUP_REVISION_SNAPSHOT_VERSION = 1 as const;
export const CANONICAL_COLLECTION_GROUP_MEMBER_REVISION_SNAPSHOT_VERSION = 1 as const;
export const CANONICAL_COLLECTION_GROUP_FINGERPRINT_VERSION = "canonical-collection-group-fingerprint/1" as const;
export const CANONICAL_COLLECTION_GROUP_FINGERPRINT_PREFIX = "lvcollectiongroup:v1:" as const;

export const canonicalCollectionGroupRoleSchema = z.enum(["trigger", "paired"]);
export type CanonicalCollectionGroupEvidenceRole = z.infer<typeof canonicalCollectionGroupRoleSchema>;

export interface CanonicalCollectionGroupMemberEvidence {
  occurrenceId: string;
  billingTermId: string;
  role: CanonicalCollectionGroupEvidenceRole;
  memberOrdinal: 1 | 2;
  localDate: string;
  billingOrdinal: number;
  amountMinor: number;
  currency: string;
}

export interface CanonicalCollectionGroupEvidence {
  contractVersion: typeof CANONICAL_COLLECTION_GROUP_CONTRACT_VERSION;
  resultVersion: typeof CANONICAL_COLLECTION_GROUP_RESULT_VERSION;
  fingerprintVersion: typeof CANONICAL_COLLECTION_GROUP_FINGERPRINT_VERSION;
  fingerprint: string;
  groupOrdinal: number;
  kind: "double_pay";
  state: "published" | "revoked";
  generationRunId: string;
  sourceScheduleRevision: number;
  triggerLocalDate: string;
  pairedLocalDate: string;
  members: [CanonicalCollectionGroupMemberEvidence, CanonicalCollectionGroupMemberEvidence];
}

export interface CanonicalCollectionPairableOccurrence {
  occurrenceId: string;
  localDate: string;
  status: "scheduled" | "cancelled" | "completed" | "discarded";
  lifecycle: "draft" | "published" | "locked";
  billingTerm: {
    id: string;
    obligationPolicy: "none" | "eligible_bowlers";
    billingOrdinal: number | null;
    amountMinor: number;
    currency: string;
  } | null;
}

export interface CanonicalCollectionPairingInput {
  doublePayDates: readonly string[];
  occurrences: readonly CanonicalCollectionPairableOccurrence[];
}

export class CanonicalCollectionGroupingError extends Error {
  constructor(
    public readonly code:
      | "invalid_date"
      | "duplicate_trigger"
      | "trigger_not_billable"
      | "trigger_not_found"
      | "insufficient_tail_candidates"
      | "incompatible_occurrence",
    message: string,
  ) {
    super(message);
    this.name = "CanonicalCollectionGroupingError";
  }
}

function assertDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new CanonicalCollectionGroupingError("invalid_date", "double-pay dates must be YYYY-MM-DD calendar dates");
  }
  const probe = new Date(`${value}T12:00:00.000Z`);
  if (!Number.isFinite(probe.getTime()) || probe.toISOString().slice(0, 10) !== value) {
    throw new CanonicalCollectionGroupingError("invalid_date", `invalid double-pay date ${value}`);
  }
}

function compareDate(left: { localDate: string; occurrenceId: string }, right: { localDate: string; occurrenceId: string }): number {
  return left.localDate.localeCompare(right.localDate) || left.occurrenceId.localeCompare(right.occurrenceId);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function canonicalCollectionGroupFingerprint(input: {
  groupOrdinal: number;
  generationRunId: string;
  sourceScheduleRevision: number;
  trigger: CanonicalCollectionGroupMemberEvidence;
  paired: CanonicalCollectionGroupMemberEvidence;
}): string {
  return `${CANONICAL_COLLECTION_GROUP_FINGERPRINT_PREFIX}${sha256({
    fingerprintVersion: CANONICAL_COLLECTION_GROUP_FINGERPRINT_VERSION,
    contractVersion: CANONICAL_COLLECTION_GROUP_CONTRACT_VERSION,
    kind: "double_pay",
    groupOrdinal: input.groupOrdinal,
    generationRunId: input.generationRunId,
    sourceScheduleRevision: input.sourceScheduleRevision,
    members: [input.trigger, input.paired],
  })}`;
}

/**
 * Pair selected trigger occurrences with the final N *other* billable
 * occurrences. Both lists are sorted by authoritative calendar date and UUID
 * as a deterministic tie-breaker. No amount is multiplied and no occurrence
 * is copied: the returned members retain each row's exact term evidence.
 */
export function deriveCanonicalCollectionPairs(input: CanonicalCollectionPairingInput): Array<{
  groupOrdinal: number;
  trigger: CanonicalCollectionGroupMemberEvidence;
  paired: CanonicalCollectionGroupMemberEvidence;
  fingerprint: string | null;
}> {
  const dates = [...input.doublePayDates];
  dates.forEach(assertDate);
  const sortedDates = [...dates].sort();
  if (new Set(sortedDates).size !== sortedDates.length) {
    throw new CanonicalCollectionGroupingError("duplicate_trigger", "double-pay dates must be unique");
  }

  const occurrences = [...input.occurrences].sort(compareDate);
  const byDate = new Map<string, CanonicalCollectionPairableOccurrence[]>();
  for (const occurrence of occurrences) {
    const rows = byDate.get(occurrence.localDate) ?? [];
    rows.push(occurrence);
    byDate.set(occurrence.localDate, rows);
  }
  const triggerRows = sortedDates.map((date) => {
    const candidates = byDate.get(date) ?? [];
    if (candidates.length > 1) {
      throw new CanonicalCollectionGroupingError("incompatible_occurrence", `double-pay date ${date} maps to multiple canonical occurrences`);
    }
    const row = candidates[0];
    if (!row) throw new CanonicalCollectionGroupingError("trigger_not_found", `double-pay date ${date} has no canonical occurrence`);
    if (row.status !== "scheduled" || !["draft", "published"].includes(row.lifecycle)
      || !row.billingTerm || row.billingTerm.obligationPolicy !== "eligible_bowlers"
      || row.billingTerm.billingOrdinal === null || row.billingTerm.amountMinor <= 0) {
      throw new CanonicalCollectionGroupingError("trigger_not_billable", `double-pay date ${date} is not a billable canonical occurrence`);
    }
    return row;
  });

  const triggerIds = new Set(triggerRows.map((row) => row.occurrenceId));
  const tailRows = occurrences.filter((row) => !triggerIds.has(row.occurrenceId)
    && row.status === "scheduled"
    && ["draft", "published"].includes(row.lifecycle)
    && row.billingTerm?.obligationPolicy === "eligible_bowlers"
    && row.billingTerm.billingOrdinal !== null
    && row.billingTerm.amountMinor > 0);
  if (tailRows.length < triggerRows.length) {
    throw new CanonicalCollectionGroupingError("insufficient_tail_candidates", "there are not enough final billable occurrences for the selected double-pay dates");
  }
  const pairedRows = tailRows.slice(-triggerRows.length);
  const result: Array<{
    groupOrdinal: number;
    trigger: CanonicalCollectionGroupMemberEvidence;
    paired: CanonicalCollectionGroupMemberEvidence;
    fingerprint: string | null;
  }> = [];
  triggerRows.forEach((trigger, index) => {
    const paired = pairedRows[index];
    if (!paired || !trigger.billingTerm || !paired.billingTerm) {
      throw new CanonicalCollectionGroupingError("incompatible_occurrence", "canonical pair evidence is incomplete");
    }
    const toMember = (row: CanonicalCollectionPairableOccurrence, role: CanonicalCollectionGroupEvidenceRole, memberOrdinal: 1 | 2): CanonicalCollectionGroupMemberEvidence => {
      const billingTerm = row.billingTerm;
      if (!billingTerm || billingTerm.billingOrdinal === null) throw new CanonicalCollectionGroupingError("incompatible_occurrence", "canonical pair evidence is incomplete");
      return {
        occurrenceId: row.occurrenceId,
        billingTermId: billingTerm.id,
        role,
        memberOrdinal,
        localDate: row.localDate,
        billingOrdinal: billingTerm.billingOrdinal,
        amountMinor: billingTerm.amountMinor,
        currency: billingTerm.currency,
      };
    };
    result.push({
      groupOrdinal: index + 1,
      trigger: toMember(trigger, "trigger", 1),
      paired: toMember(paired, "paired", 2),
      fingerprint: null,
    });
  });
  return result;
}
