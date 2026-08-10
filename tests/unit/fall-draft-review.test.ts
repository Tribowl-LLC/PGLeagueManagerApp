import { describe, expect, it } from "vitest";
import {
  FALL_DRAFT_APPROVE_REQUEST_VERSION,
  FALL_DRAFT_RESCHEDULE_REQUEST_VERSION,
  fallDraftApproveRequestSchema,
  fallDraftRescheduleRequestSchema,
  fallDraftReviewFingerprint,
} from "@shared/fall-draft-review";

describe("C2 Fall draft review contracts", () => {
  it("fingerprints semantic state deterministically while excluding runtime eligibility and personal identity", () => {
    const value = {
      reviewContractVersion: "fall-draft-review/1",
      organizationId: 1,
      occurrences: [{ id: "occurrence", status: "scheduled", effectivelyLocked: false }],
      commands: [{ id: "command", commandType: "generate" }],
    };
    const first = fallDraftReviewFingerprint(value);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(fallDraftReviewFingerprint({ ...value, reviewFingerprint: first })).toBe(first);
    expect(fallDraftReviewFingerprint({
      ...value,
      occurrences: [{ ...value.occurrences[0], effectivelyLocked: true }],
    })).toBe(first);
    expect(fallDraftReviewFingerprint({
      ...value,
      commands: [{ ...value.commands[0], actorUserId: 999 }],
    })).toBe(first);
    expect(fallDraftReviewFingerprint({
      ...value,
      occurrences: [{ ...value.occurrences[0], status: "cancelled" }],
    })).not.toBe(first);
  });

  it("requires strict versioned reschedule and approval payloads", () => {
    const reschedule = {
      contractVersion: FALL_DRAFT_RESCHEDULE_REQUEST_VERSION,
      confirmedReviewFingerprint: "a".repeat(64),
      reason: "Audited reschedule",
      idempotencyKey: "reschedule-key",
      occurrenceId: "00000000-0000-4000-8000-000000000001",
      expectedOccurrenceRevision: 1,
      authoritativeLocalDate: "2032-11-07",
      authoritativeLocalStartTime: "01:30:00",
      timezone: "America/New_York",
      ambiguousFold: "later",
    };
    expect(fallDraftRescheduleRequestSchema.parse(reschedule)).toEqual(reschedule);
    expect(() => fallDraftRescheduleRequestSchema.parse({ ...reschedule, now: "2032-01-01T00:00:00.000Z" })).toThrow();
    expect(() => fallDraftRescheduleRequestSchema.parse({ ...reschedule, reason: " untrimmed" })).toThrow();
    expect(() => fallDraftRescheduleRequestSchema.parse({ ...reschedule, expectedOccurrenceRevision: 0 })).toThrow();

    const approval = {
      contractVersion: FALL_DRAFT_APPROVE_REQUEST_VERSION,
      confirmedReviewFingerprint: "b".repeat(64),
      reason: "Approve exact review",
      idempotencyKey: "approval-key",
      discrepancyDispositions: [{
        discrepancyId: "00000000-0000-4000-8000-000000000002",
        disposition: "waived",
      }],
    };
    expect(fallDraftApproveRequestSchema.parse(approval)).toEqual(approval);
    expect(() => fallDraftApproveRequestSchema.parse({ ...approval, organizationId: 9 })).toThrow();
  });
});
