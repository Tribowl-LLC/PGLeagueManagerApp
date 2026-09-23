import { and, asc, desc, eq, inArray, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { paymentObligationOwnerRevisions, paymentObligations } from "@shared/schema";
import type { PaymentOperationTransaction } from "../storage/payment-operations.js";

export type EffectivePaymentObligationOwner =
  | { kind: "bowler"; bowlerId: number }
  | { kind: "team"; teamId: number };

export class PaymentObligationOwnerError extends Error {
  constructor(public readonly code: string) {
    super("Payment obligation owner evidence is incomplete or inconsistent");
    this.name = "PaymentObligationOwnerError";
  }
}

/**
 * Resolve the current liability owner without rewriting the historical payer.
 * A legacy obligation with no revision remains bowler-owned by its payer.
 * Missing ownership on a new payer-less obligation is always a hard failure.
 */
export async function resolvePaymentObligationOwnerInTransaction(
  tx: PaymentOperationTransaction,
  input: { organizationId: number; leagueId: number; obligationId: string },
): Promise<EffectivePaymentObligationOwner> {
  const [obligation] = await tx.select({
    payerBowlerId: paymentObligations.payerBowlerId,
  }).from(paymentObligations).where(and(
    eq(paymentObligations.organizationId, input.organizationId),
    eq(paymentObligations.leagueId, input.leagueId),
    eq(paymentObligations.id, input.obligationId),
  )).limit(1);
  if (!obligation) throw new PaymentObligationOwnerError("OBLIGATION_NOT_FOUND");
  const revisions = await tx.select().from(paymentObligationOwnerRevisions).where(and(
    eq(paymentObligationOwnerRevisions.organizationId, input.organizationId),
    eq(paymentObligationOwnerRevisions.leagueId, input.leagueId),
    eq(paymentObligationOwnerRevisions.obligationId, input.obligationId),
  )).orderBy(desc(paymentObligationOwnerRevisions.revisionNumber), asc(paymentObligationOwnerRevisions.id)).limit(2);
  if (revisions.length > 1 && revisions[0]?.revisionNumber === revisions[1]?.revisionNumber) {
    throw new PaymentObligationOwnerError("OWNER_REVISION_DUPLICATE");
  }
  const current = revisions[0];
  if (!current) {
    if (obligation.payerBowlerId === null) throw new PaymentObligationOwnerError("OWNER_EVIDENCE_MISSING");
    return { kind: "bowler", bowlerId: obligation.payerBowlerId };
  }
  if (current.ownerKind === "bowler" && current.ownerBowlerId !== null && current.ownerTeamId === null) {
    return { kind: "bowler", bowlerId: current.ownerBowlerId };
  }
  if (current.ownerKind === "team" && current.ownerTeamId !== null && current.ownerBowlerId === null) {
    return { kind: "team", teamId: current.ownerTeamId };
  }
  throw new PaymentObligationOwnerError("OWNER_REVISION_INVALID");
}

export async function resolvePaymentObligationOwnersInTransaction(
  tx: PaymentOperationTransaction,
  input: {
    organizationId: number;
    leagueId: number;
    obligations: ReadonlyArray<Pick<typeof paymentObligations.$inferSelect, "id" | "payerBowlerId">>;
  },
): Promise<Map<string, EffectivePaymentObligationOwner>> {
  const ids = input.obligations.map((obligation) => obligation.id);
  if (ids.length === 0) return new Map();
  const rows = await tx.select().from(paymentObligationOwnerRevisions).where(and(
    eq(paymentObligationOwnerRevisions.organizationId, input.organizationId),
    eq(paymentObligationOwnerRevisions.leagueId, input.leagueId),
    inArray(paymentObligationOwnerRevisions.obligationId, ids),
  )).orderBy(desc(paymentObligationOwnerRevisions.revisionNumber), asc(paymentObligationOwnerRevisions.id));
  const revisionByObligation = new Map<string, typeof paymentObligationOwnerRevisions.$inferSelect>();
  for (const revision of rows) {
    const existing = revisionByObligation.get(revision.obligationId);
    if (existing?.revisionNumber === revision.revisionNumber) throw new PaymentObligationOwnerError("OWNER_REVISION_DUPLICATE");
    if (!existing) revisionByObligation.set(revision.obligationId, revision);
  }
  const result = new Map<string, EffectivePaymentObligationOwner>();
  for (const obligation of input.obligations) {
    const revision = revisionByObligation.get(obligation.id);
    if (!revision) {
      if (obligation.payerBowlerId === null) throw new PaymentObligationOwnerError("OWNER_EVIDENCE_MISSING");
      result.set(obligation.id, { kind: "bowler", bowlerId: obligation.payerBowlerId });
    } else if (revision.ownerKind === "bowler" && revision.ownerBowlerId !== null && revision.ownerTeamId === null) {
      result.set(obligation.id, { kind: "bowler", bowlerId: revision.ownerBowlerId });
    } else if (revision.ownerKind === "team" && revision.ownerTeamId !== null && revision.ownerBowlerId === null) {
      result.set(obligation.id, { kind: "team", teamId: revision.ownerTeamId });
    } else {
      throw new PaymentObligationOwnerError("OWNER_REVISION_INVALID");
    }
  }
  return result;
}

/** SQL predicate shared by legacy per-bowler due, FIFO, and standing paths.
 * Sidecar team ownership overrides the retained historical payer ID. */
export function isCurrentBowlerOwnedObligationSql(input: {
  organizationId: number;
  leagueId: number;
  obligationId: SQLWrapper;
  payerBowlerId: SQLWrapper;
  bowlerId: number;
}): SQL {
  return sql`(
    NOT EXISTS (
      SELECT 1
      FROM payment_obligation_owner_revisions current_owner
      WHERE current_owner.organization_id = ${input.organizationId}
        AND current_owner.league_id = ${input.leagueId}
        AND current_owner.obligation_id = ${input.obligationId}
        AND current_owner.revision_number = (
          SELECT MAX(latest_owner.revision_number)
          FROM payment_obligation_owner_revisions latest_owner
          WHERE latest_owner.organization_id = ${input.organizationId}
            AND latest_owner.league_id = ${input.leagueId}
            AND latest_owner.obligation_id = ${input.obligationId}
        )
        AND current_owner.owner_kind = 'team'
    )
    AND COALESCE((
      SELECT current_owner.owner_bowler_id
      FROM payment_obligation_owner_revisions current_owner
      WHERE current_owner.organization_id = ${input.organizationId}
        AND current_owner.league_id = ${input.leagueId}
        AND current_owner.obligation_id = ${input.obligationId}
        AND current_owner.revision_number = (
          SELECT MAX(latest_owner.revision_number)
          FROM payment_obligation_owner_revisions latest_owner
          WHERE latest_owner.organization_id = ${input.organizationId}
            AND latest_owner.league_id = ${input.leagueId}
            AND latest_owner.obligation_id = ${input.obligationId}
        )
        AND current_owner.owner_kind = 'bowler'
    ), ${input.payerBowlerId}) = ${input.bowlerId}
  )`;
}

/** Append a team-owner revision, preserving all obligation and tender rows. */
export async function appendTeamPaymentObligationOwnerInTransaction(
  tx: PaymentOperationTransaction,
  input: {
    organizationId: number;
    leagueId: number;
    obligationId: string;
    teamId: number;
    actorUserId: number;
    reason: "rotating_conversion" | "rotating_materialization";
  },
): Promise<boolean> {
  const [obligation] = await tx.select().from(paymentObligations).where(and(
    eq(paymentObligations.organizationId, input.organizationId),
    eq(paymentObligations.leagueId, input.leagueId),
    eq(paymentObligations.id, input.obligationId),
  )).limit(1).for("update");
  if (!obligation) throw new PaymentObligationOwnerError("OBLIGATION_NOT_FOUND");
  const current = await resolvePaymentObligationOwnerInTransaction(tx, input);
  if (current.kind === "team") {
    if (current.teamId !== input.teamId) throw new PaymentObligationOwnerError("OWNER_TEAM_CONFLICT");
    return false;
  }
  if (obligation.state === "settled" || obligation.state === "voided") return false;
  if (obligation.state !== "open" && obligation.state !== "partially_settled") {
    throw new PaymentObligationOwnerError("OBLIGATION_STATE_INVALID");
  }
  const [latest] = await tx.select({ revisionNumber: paymentObligationOwnerRevisions.revisionNumber })
    .from(paymentObligationOwnerRevisions)
    .where(and(
      eq(paymentObligationOwnerRevisions.organizationId, input.organizationId),
      eq(paymentObligationOwnerRevisions.leagueId, input.leagueId),
      eq(paymentObligationOwnerRevisions.obligationId, input.obligationId),
    ))
    .orderBy(desc(paymentObligationOwnerRevisions.revisionNumber))
    .limit(1)
    .for("update");
  await tx.insert(paymentObligationOwnerRevisions).values({
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    obligationId: obligation.id,
    revisionNumber: (latest?.revisionNumber ?? 0) + 1,
    ownerKind: "team",
    ownerBowlerId: null,
    ownerTeamId: input.teamId,
    reason: input.reason,
    recordedByUserId: input.actorUserId,
  });
  return true;
}
