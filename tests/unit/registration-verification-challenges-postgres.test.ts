/** PostgreSQL coverage for safe reuse of a provider verification SID. */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { getTestDb } from "../setup/test-db";
import { getBaselineOrgIds } from "../helpers";
import { db as applicationDb } from "../../server/db";
import {
  registrationVerificationChallenges,
  type RegistrationVerificationChallenge,
} from "@shared/schema";
import {
  acquireRegistrationProviderLease,
  cancelRegistrationChallenge,
  createRegistrationChallenge,
  markRegistrationVerificationSent,
} from "../../server/storage/registration-verification-challenges";

const db = getTestDb();
const createdChallengeIds: string[] = [];
let orgAId = 0;
let orgBId = 0;
let sequence = 0;

beforeAll(async () => {
  ({ orgAId, orgBId } = await getBaselineOrgIds());
});

afterEach(async () => {
  if (createdChallengeIds.length === 0) return;
  await db.delete(registrationVerificationChallenges)
    .where(inArray(registrationVerificationChallenges.id, createdChallengeIds.splice(0)));
});

function nextValue(prefix: string): string {
  sequence += 1;
  return `${prefix}-${Date.now()}-${sequence}`;
}

function phone(label: string): string {
  // The application stores normalized E.164 destinations. Keep every fixture
  // synthetic and unique so this suite never touches a real recipient.
  return `+1202555${String(sequence + 100).padStart(4, "0")}`;
}

async function challenge(
  organizationId: number,
  bindingSecret: string,
  destination: string,
): Promise<RegistrationVerificationChallenge> {
  const created = await createRegistrationChallenge({
    bindingSecret,
    organizationId,
    email: `${nextValue("sid-reuse")}@example.test`,
    name: "SID reuse fixture",
    phone: destination,
  });
  createdChallengeIds.push(created.id);
  return created;
}

async function recordSid(
  row: RegistrationVerificationChallenge,
  bindingSecret: string,
  providerVerificationSid: string,
): Promise<RegistrationVerificationChallenge> {
  const lease = await acquireRegistrationProviderLease({
    challengeId: row.id,
    bindingSecret,
    organizationId: row.organizationId,
    operation: "send",
  });
  return markRegistrationVerificationSent({
    challengeId: row.id,
    bindingSecret,
    organizationId: row.organizationId,
    leaseToken: lease.leaseToken,
    providerVerificationSid,
  });
}

async function rowById(id: string) {
  const [row] = await db.select().from(registrationVerificationChallenges)
    .where(eq(registrationVerificationChallenges.id, id));
  return row;
}

describe("registration verification provider SID ownership", () => {
  it("releases a cancelled SID and claims it for the replacement in one transaction", async () => {
    const destination = phone("cancelled");
    const oldBinding = nextValue("cancelled-binding");
    const old = await challenge(orgAId, oldBinding, destination);
    const sid = `VE${nextValue("cancelled-sid")}`;
    await recordSid(old, oldBinding, sid);
    await cancelRegistrationChallenge({
      challengeId: old.id,
      bindingSecret: oldBinding,
      organizationId: orgAId,
    });

    const replacementBinding = nextValue("replacement-binding");
    const replacement = await challenge(orgAId, replacementBinding, destination);
    const claimed = await recordSid(replacement, replacementBinding, sid);

    expect(claimed.providerVerificationSid).toBe(sid);
    expect((await rowById(old.id))?.providerVerificationSid).toBeNull();
    expect((await rowById(old.id))?.status).toBe("cancelled");
    await expect(acquireRegistrationProviderLease({
      challengeId: old.id,
      bindingSecret: oldBinding,
      organizationId: orgAId,
      operation: "verify",
    })).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("releases a pre-existing replaced SID and fences the stale capability", async () => {
    const destination = phone("replaced");
    const binding = nextValue("replaced-binding");
    const old = await challenge(orgAId, binding, destination);
    const sid = `VE${nextValue("replaced-sid")}`;
    await recordSid(old, binding, sid);

    // Creating again with the same browser binding retires the pending row
    // while preserving its provider SID, matching the historical production
    // rows this fix must support.
    await challenge(orgAId, binding, destination);
    const retired = await rowById(old.id);
    expect(retired?.status).toBe("replaced");
    expect(retired?.providerVerificationSid).toBe(sid);

    const replacementBinding = nextValue("replaced-current-binding");
    const replacement = await challenge(orgAId, replacementBinding, destination);
    const claimed = await recordSid(replacement, replacementBinding, sid);

    expect(claimed.providerVerificationSid).toBe(sid);
    expect((await rowById(old.id))?.providerVerificationSid).toBeNull();
    await expect(acquireRegistrationProviderLease({
      challengeId: old.id,
      bindingSecret: binding,
      organizationId: orgAId,
      operation: "verify",
    })).rejects.toMatchObject({ code: "REPLACED" });
  });

  it.each(["pending", "verified", "consumed"] as const)(
    "does not steal a SID owned by an active %s challenge",
    async (status) => {
      const destination = phone(`active-${status}`);
      const ownerBinding = nextValue(`active-owner-${status}`);
      const owner = await challenge(orgAId, ownerBinding, destination);
      const sid = `VE${nextValue(`active-${status}-sid`)}`;
      await recordSid(owner, ownerBinding, sid);
      if (status !== "pending") {
        await db.update(registrationVerificationChallenges).set({
          status,
          ...(status === "verified" ? {
            setupExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
            verifiedAt: new Date().toISOString(),
          } : {}),
        }).where(eq(registrationVerificationChallenges.id, owner.id));
      }

      const targetBinding = nextValue(`active-target-${status}`);
      const target = await challenge(orgAId, targetBinding, destination);
      const targetLease = await acquireRegistrationProviderLease({
        challengeId: target.id,
        bindingSecret: targetBinding,
        organizationId: orgAId,
        operation: "send",
      });

      await expect(markRegistrationVerificationSent({
        challengeId: target.id,
        bindingSecret: targetBinding,
        organizationId: orgAId,
        leaseToken: targetLease.leaseToken,
        providerVerificationSid: sid,
      })).rejects.toMatchObject({ cause: { code: "23505" } });

      expect((await rowById(owner.id))?.providerVerificationSid).toBe(sid);
      expect((await rowById(target.id))?.providerVerificationSid).toBeNull();
    },
  );

  it("does not release an SID across organizations or normalized phone destinations", async () => {
    const crossOrgPhone = phone("cross-org");
    const crossOrgBinding = nextValue("cross-org-owner");
    const crossOrgOwner = await challenge(orgAId, crossOrgBinding, crossOrgPhone);
    const crossOrgSid = `VE${nextValue("cross-org-sid")}`;
    await recordSid(crossOrgOwner, crossOrgBinding, crossOrgSid);
    await cancelRegistrationChallenge({
      challengeId: crossOrgOwner.id,
      bindingSecret: crossOrgBinding,
      organizationId: orgAId,
    });
    const crossOrgTargetBinding = nextValue("cross-org-target");
    const crossOrgTarget = await challenge(orgBId, crossOrgTargetBinding, crossOrgPhone);
    const crossOrgLease = await acquireRegistrationProviderLease({
      challengeId: crossOrgTarget.id,
      bindingSecret: crossOrgTargetBinding,
      organizationId: orgBId,
      operation: "send",
    });
    await expect(markRegistrationVerificationSent({
      challengeId: crossOrgTarget.id,
      bindingSecret: crossOrgTargetBinding,
      organizationId: orgBId,
      leaseToken: crossOrgLease.leaseToken,
      providerVerificationSid: crossOrgSid,
    })).rejects.toMatchObject({ cause: { code: "23505" } });
    expect((await rowById(crossOrgOwner.id))?.providerVerificationSid).toBe(crossOrgSid);

    const crossPhoneOwnerBinding = nextValue("cross-phone-owner");
    const crossPhoneOwner = await challenge(orgAId, crossPhoneOwnerBinding, phone("cross-phone-owner"));
    const crossPhoneSid = `VE${nextValue("cross-phone-sid")}`;
    await recordSid(crossPhoneOwner, crossPhoneOwnerBinding, crossPhoneSid);
    await cancelRegistrationChallenge({
      challengeId: crossPhoneOwner.id,
      bindingSecret: crossPhoneOwnerBinding,
      organizationId: orgAId,
    });
    const crossPhoneTargetBinding = nextValue("cross-phone-target");
    const crossPhoneTarget = await challenge(orgAId, crossPhoneTargetBinding, phone("cross-phone-target"));
    const crossPhoneLease = await acquireRegistrationProviderLease({
      challengeId: crossPhoneTarget.id,
      bindingSecret: crossPhoneTargetBinding,
      organizationId: orgAId,
      operation: "send",
    });
    await expect(markRegistrationVerificationSent({
      challengeId: crossPhoneTarget.id,
      bindingSecret: crossPhoneTargetBinding,
      organizationId: orgAId,
      leaseToken: crossPhoneLease.leaseToken,
      providerVerificationSid: crossPhoneSid,
    })).rejects.toMatchObject({ cause: { code: "23505" } });
    expect((await rowById(crossPhoneOwner.id))?.providerVerificationSid).toBe(crossPhoneSid);
  });

  it("serializes concurrent claims and rolls back the losing claim", async () => {
    const destination = phone("race");
    const retiredBinding = nextValue("race-retired");
    const retired = await challenge(orgAId, retiredBinding, destination);
    const sid = `VE${nextValue("race-sid")}`;
    await recordSid(retired, retiredBinding, sid);
    await cancelRegistrationChallenge({
      challengeId: retired.id,
      bindingSecret: retiredBinding,
      organizationId: orgAId,
    });

    const firstBinding = nextValue("race-first");
    const secondBinding = nextValue("race-second");
    const first = await challenge(orgAId, firstBinding, destination);
    const second = await challenge(orgAId, secondBinding, destination);
    const [firstLease, secondLease] = await Promise.all([
      acquireRegistrationProviderLease({ challengeId: first.id, bindingSecret: firstBinding, organizationId: orgAId, operation: "send" }),
      acquireRegistrationProviderLease({ challengeId: second.id, bindingSecret: secondBinding, organizationId: orgAId, operation: "send" }),
    ]);

    const results = await Promise.allSettled([
      markRegistrationVerificationSent({ challengeId: first.id, bindingSecret: firstBinding, organizationId: orgAId, leaseToken: firstLease.leaseToken, providerVerificationSid: sid }),
      markRegistrationVerificationSent({ challengeId: second.id, bindingSecret: secondBinding, organizationId: orgAId, leaseToken: secondLease.leaseToken, providerVerificationSid: sid }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

    const rows = await db.select({
      id: registrationVerificationChallenges.id,
      providerVerificationSid: registrationVerificationChallenges.providerVerificationSid,
      operationLeaseToken: registrationVerificationChallenges.operationLeaseToken,
    }).from(registrationVerificationChallenges).where(and(
      inArray(registrationVerificationChallenges.id, [first.id, second.id]),
    ));
    expect(rows.filter((row) => row.providerVerificationSid === sid)).toHaveLength(1);
    expect(rows.filter((row) => row.providerVerificationSid === null && row.operationLeaseToken !== null)).toHaveLength(1);
    expect((await rowById(retired.id))?.providerVerificationSid).toBeNull();
  });

  it("rolls back terminal SID release when the claim transaction aborts", async () => {
    const destination = phone("rollback");
    const retiredBinding = nextValue("rollback-retired");
    const retired = await challenge(orgAId, retiredBinding, destination);
    const sid = `VE${nextValue("rollback-sid")}`;
    await recordSid(retired, retiredBinding, sid);
    await cancelRegistrationChallenge({
      challengeId: retired.id,
      bindingSecret: retiredBinding,
      organizationId: orgAId,
    });

    const targetBinding = nextValue("rollback-target");
    const target = await challenge(orgAId, targetBinding, destination);
    const targetLease = await acquireRegistrationProviderLease({
      challengeId: target.id,
      bindingSecret: targetBinding,
      organizationId: orgAId,
      operation: "send",
    });

    await expect(applicationDb.transaction(async (tx) => {
      await markRegistrationVerificationSent({
        challengeId: target.id,
        bindingSecret: targetBinding,
        organizationId: orgAId,
        leaseToken: targetLease.leaseToken,
        providerVerificationSid: sid,
      }, tx);
      throw new Error("intentional registration SID rollback");
    })).rejects.toThrow("intentional registration SID rollback");

    expect((await rowById(retired.id))?.providerVerificationSid).toBe(sid);
    expect((await rowById(target.id))?.providerVerificationSid).toBeNull();
    expect((await rowById(target.id))?.operationLeaseToken).toBe(targetLease.leaseToken);
  });
});
