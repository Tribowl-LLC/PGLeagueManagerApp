import { and, asc, eq, sql } from "drizzle-orm";
import {
  bowlerLeagues,
  bowlers,
  leagues,
  leagueScheduleCommands,
  locations,
  organizations,
  teams,
  users,
  DEFAULT_TIMEZONE,
  type InsertLeague,
  type League,
  type PaymentMode,
} from "@shared/schema";
import { calculateSeasonEnd } from "@shared/schedule-utils";
import { getProductSeasonFromDateOnly, type ProductSeason } from "@shared/season-utils";
import { validateDoublePayDates } from "@shared/schema/leagues";
import {
  fallDraftCanonicalJson,
  fallDraftSha256,
  type FallDraftApplyResult,
} from "@shared/fall-draft-generation";
import {
  LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION,
  LEAGUE_SETUP_INTEGRATION_RESULT_VERSION,
  LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION_2,
  LEAGUE_SETUP_INTEGRATION_RESULT_VERSION_2,
  LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION_3,
  LEAGUE_SETUP_INTEGRATION_RESULT_VERSION_3,
  LEAGUE_ROLLOVER_SOURCE_CONTRACT_VERSION,
  LEAGUE_ROLLOVER_SOURCE_FINGERPRINT_VERSION,
  type AnyLeagueSetupIntegrationIntent,
  type AnyLeagueSetupIntegrationResult,
  type LeagueSetupIntegrationResult,
  type LeagueSetupIntegrationIntentV2,
  type LeagueSetupIntegrationIntentV3,
  type LeagueSetupIntegrationResultV2,
  type LeagueSetupIntegrationResultV3,
  type LeagueRolloverSourceConfirmation,
  type LeagueRolloverSourceContract,
} from "@shared/league-setup-integration";
import { db } from "../db.js";
import { cacheInvalidate } from "../utils/cache.js";
import {
  applyFallDraftGenerationInTransaction,
  applyFutureSeasonDraftGenerationInTransaction,
  verifyFutureSeasonSetupRetryInTransaction,
  type FallDraftFailureStage,
} from "./fall-draft-generation.js";
import type { FutureSeasonDraftGenerationResult } from "@shared/future-season-draft-generation";
import { lockLeagueSchedule, type LeagueScheduleTransaction } from "../storage/league-schedule-lock.js";
import { publishCanonicalDraftInTransaction } from "./fall-draft-review.js";
import { persistCanonicalCollectionGroupsInTransaction, type PersistCanonicalCollectionGroupsResult } from "./canonical-collection-groups.js";
import { CanonicalCollectionGroupingError } from "@shared/canonical-collection-groups";

export const LEAGUE_SETUP_FALL_AUDIT_REASON = "Generate canonical Fall drafts during authoritative league setup";
export const LEAGUE_SETUP_FUTURE_SEASON_AUDIT_REASON = "Generate canonical future-season drafts during authoritative league setup";

export type LeagueSetupFailureStage =
  | "after_league_insert"
  | "after_team_copy"
  | "after_roster_copy"
  | "after_canonical_generation"
  | "after_source_archive";

export type LeagueSetupIntegrationErrorCode =
  | "invalid_scope"
  | "unauthorized_actor"
  | "organization_not_found"
  | "location_not_found"
  | "source_league_not_found"
  | "stale_source_league"
  | "successor_exists"
  | "idempotency_conflict"
  | "validation_error"
  | "transaction_failure";

export class LeagueSetupIntegrationError extends Error {
  readonly code: LeagueSetupIntegrationErrorCode;

  constructor(code: LeagueSetupIntegrationErrorCode, message: string) {
    super(message);
    this.name = "LeagueSetupIntegrationError";
    this.code = code;
  }
}

export interface LeagueSetupScope {
  organizationId: number;
  actorUserId: number;
}

export interface NewSeasonSetupValues {
  seasonStart: string;
  seasonEnd?: string;
  totalBowlingWeeks?: number;
  weekDay?: League["weekDay"];
  skipDates: string[];
  cancelledDates: string[];
  doublePayDates: string[];
  allowPublicSignup?: boolean;
  paymentMode: PaymentMode;
}

export interface NewSeasonSetupValuesV2 {
  seasonStart: string;
  totalBowlingWeeks: number;
  weekDay: League["weekDay"];
  skipDates: string[];
  cancelledDates: string[];
  doublePayDates: string[];
  allowPublicSignup: boolean;
  paymentMode: PaymentMode;
}

export type NewSeasonSetupValuesV3 = NewSeasonSetupValuesV2;

interface SetupTransactionResult {
  result: AnyLeagueSetupIntegrationResult;
  affectedBowlerIds: number[];
}

interface PublishedCanonicalSetup {
  generation: FutureSeasonDraftGenerationResult;
  approvalCommandId: string;
  publicationCommandId: string;
  groups: PersistCanonicalCollectionGroupsResult;
}

interface RolloverCarriedEvidence {
  teams: Array<{
    id: number;
    name: string;
    number: number;
    active: boolean;
    displayOrder: number;
  }>;
  roster: Array<{
    id: number;
    bowlerId: number;
    leagueId: number;
    teamId: number;
    active: boolean;
    order: number;
    joinedAt: string;
  }>;
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new LeagueSetupIntegrationError("invalid_scope", `${field} must be a positive safe integer`);
  }
}

function setupCommandKey(intent: AnyLeagueSetupIntegrationIntent): string {
  return `lvsetup:${fallDraftSha256({
    contractVersion: intent.contractVersion,
    idempotencyKey: intent.idempotencyKey,
  })}`;
}

async function lockSetupIntent(tx: LeagueScheduleTransaction, commandKey: string): Promise<void> {
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtext('league-setup-integration/1')::integer,
      hashtext(${commandKey})::integer
    )
  `);
}

async function authorizeSetupActor(
  tx: LeagueScheduleTransaction,
  scope: LeagueSetupScope,
  requireAdministrator: boolean,
  lockActor = true,
): Promise<void> {
  assertPositiveInteger(scope.organizationId, "organizationId");
  assertPositiveInteger(scope.actorUserId, "actorUserId");
  const actorQuery = tx.select({
    id: users.id,
    organizationId: users.organizationId,
    role: users.role,
  }).from(users).where(eq(users.id, scope.actorUserId));
  const [actor] = lockActor ? await actorQuery.for("update") : await actorQuery;
  const tenantAllowed = actor?.role === "system_admin" || actor?.organizationId === scope.organizationId;
  const roleAllowed = !requireAdministrator || actor?.role === "system_admin" || actor?.role === "org_admin";
  if (!actor || !tenantAllowed || !roleAllowed) {
    throw new LeagueSetupIntegrationError("unauthorized_actor", "the authenticated actor is not authorized for this league setup");
  }
  const [organization] = await tx.select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, scope.organizationId));
  if (!organization) {
    throw new LeagueSetupIntegrationError("organization_not_found", "the authorized organization was not found");
  }
}

async function assertLocationScope(tx: LeagueScheduleTransaction, organizationId: number, locationId: number | null | undefined): Promise<void> {
  if (!locationId) throw new LeagueSetupIntegrationError("location_not_found", "a location in the authorized organization is required for Fall setup");
  const [location] = await tx.select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.id, locationId), eq(locations.organizationId, organizationId)));
  if (!location) throw new LeagueSetupIntegrationError("location_not_found", "the setup location was not found in the authorized organization");
}

function dateOnly(value: string): string {
  return value.slice(0, 10);
}

function isActiveFall(league: Pick<InsertLeague, "active" | "seasonStart">): boolean {
  return league.active === true && getProductSeasonFromDateOnly(dateOnly(league.seasonStart)) === "Fall";
}

function normalizedLeagueSemantic(league: InsertLeague | League, kind: "league" | "new_season"): Record<string, unknown> {
  return {
    setupKind: kind,
    name: league.name,
    description: league.description ?? null,
    payingLineupSize: league.payingLineupSize ?? null,
    active: league.active,
    allowPublicSignup: league.allowPublicSignup,
    seasonStart: new Date(league.seasonStart).toISOString(),
    seasonEnd: new Date(league.seasonEnd).toISOString(),
    weekDay: league.weekDay,
    weeklyFee: league.weeklyFee,
    lineageFee: league.lineageFee ?? null,
    prizeFundFee: league.prizeFundFee ?? null,
    practiceStartTime: league.practiceStartTime ?? null,
    competitionStartTime: league.competitionStartTime ?? null,
    timezone: league.timezone ?? null,
    paymentMode: league.paymentMode,
    squareLineageItemId: league.squareLineageItemId ?? null,
    lineageItemVariationId: league.lineageItemVariationId ?? null,
    squareLineageItemName: league.squareLineageItemName ?? null,
    squarePrizeFundItemId: league.squarePrizeFundItemId ?? null,
    prizeFundItemVariationId: league.prizeFundItemVariationId ?? null,
    squarePrizeFundItemName: league.squarePrizeFundItemName ?? null,
    squareCategoryId: league.squareCategoryId ?? null,
    organizationId: league.organizationId,
    locationId: league.locationId ?? null,
    seasonNumber: league.seasonNumber,
    previousSeasonId: league.previousSeasonId ?? null,
    totalBowlingWeeks: league.totalBowlingWeeks ?? null,
    skipDates: [...(league.skipDates ?? [])],
    cancelledDates: [...(league.cancelledDates ?? [])],
    doublePayDates: [...(league.doublePayDates ?? [])],
  };
}

function rolloverSourceContract(source: League, evidence: RolloverCarriedEvidence): LeagueRolloverSourceContract {
  if (!source.organizationId || !source.locationId || !source.competitionStartTime || (source.payingLineupSize !== 3 && source.payingLineupSize !== 4)) {
    throw new LeagueSetupIntegrationError(
      "validation_error",
      "source league is missing the tenant, location, competition time, or lineup size required for canonical rollover",
    );
  }
  const semantic = {
    contractVersion: LEAGUE_ROLLOVER_SOURCE_CONTRACT_VERSION,
    fingerprintVersion: LEAGUE_ROLLOVER_SOURCE_FINGERPRINT_VERSION,
    organizationId: source.organizationId,
    sourceLeagueId: source.id,
    carriedConfiguration: {
      name: source.name,
      description: source.description ?? null,
      payingLineupSize: source.payingLineupSize,
      locationId: source.locationId,
      timezone: source.timezone ?? DEFAULT_TIMEZONE,
      practiceStartTime: source.practiceStartTime ?? null,
      competitionStartTime: source.competitionStartTime,
      weeklyFee: source.weeklyFee,
      lineageFee: source.lineageFee ?? null,
      prizeFundFee: source.prizeFundFee ?? null,
    },
  } as const;
  return {
    ...semantic,
    fingerprint: fallDraftSha256({
      ...semantic,
      sourceSeasonNumber: source.seasonNumber,
      carriedTeams: evidence.teams,
      carriedRoster: evidence.roster,
    }),
  };
}

async function loadRolloverCarriedEvidence(
  tx: LeagueScheduleTransaction,
  organizationId: number,
  sourceLeagueId: number,
  lock: boolean,
): Promise<RolloverCarriedEvidence> {
  const teamsQuery = tx.select().from(teams)
    .where(eq(teams.leagueId, sourceLeagueId))
    .orderBy(asc(teams.displayOrder), asc(teams.number), asc(teams.id));
  const sourceTeams = lock ? await teamsQuery.for("update") : await teamsQuery;
  const teamIds = new Set(sourceTeams.map((team) => team.id));
  const rosterQuery = tx.select({
    row: bowlerLeagues,
    bowlerOrganizationId: bowlers.organizationId,
  }).from(bowlerLeagues)
    .innerJoin(bowlers, eq(bowlers.id, bowlerLeagues.bowlerId))
    .where(eq(bowlerLeagues.leagueId, sourceLeagueId))
    .orderBy(asc(bowlerLeagues.teamId), asc(bowlerLeagues.order), asc(bowlerLeagues.id));
  const sourceRoster = lock ? await rosterQuery.for("update") : await rosterQuery;
  for (const { row, bowlerOrganizationId } of sourceRoster) {
    if (bowlerOrganizationId !== organizationId) {
      throw new LeagueSetupIntegrationError("transaction_failure", "source roster contains cross-tenant membership");
    }
    if (!teamIds.has(row.teamId)) {
      throw new LeagueSetupIntegrationError("transaction_failure", "source roster team mapping is incomplete");
    }
  }
  return {
    teams: sourceTeams.map(({ id, name, number, active, displayOrder }) => ({ id, name, number, active, displayOrder })),
    roster: sourceRoster.map(({ row }) => ({
      id: row.id,
      bowlerId: row.bowlerId,
      leagueId: row.leagueId,
      teamId: row.teamId,
      active: row.active,
      order: row.order,
      joinedAt: row.joinedAt,
    })),
  };
}

function setupConfirmationFingerprint(input: {
  setup: LeagueSetupIntegrationIntentV2 | LeagueSetupIntegrationIntentV3;
  kind: "league" | "new_season";
  target: InsertLeague;
  sourceConfirmationFingerprint?: string;
}): string {
  return fallDraftSha256({
    contractVersion: input.setup.contractVersion,
    idempotencyKey: input.setup.idempotencyKey,
    setupKind: input.kind,
    target: normalizedLeagueSemantic(input.target, input.kind),
    sourceConfirmationFingerprint: input.sourceConfirmationFingerprint ?? null,
  });
}

function assertRetrySemantic(expected: InsertLeague, persisted: League, kind: "league" | "new_season"): void {
  if (fallDraftCanonicalJson(normalizedLeagueSemantic(expected, kind))
    !== fallDraftCanonicalJson(normalizedLeagueSemantic(persisted, kind))) {
    throw new LeagueSetupIntegrationError("idempotency_conflict", "the setup idempotency key is bound to different league setup semantics");
  }
}

function setupResult(
  league: League,
  canonicalDraftGeneration: FallDraftApplyResult | null,
  mode: LeagueSetupIntegrationResult["setupIntegration"]["mode"],
  writesPerformed: boolean,
): LeagueSetupIntegrationResult {
  return {
    ...league,
    setupIntegration: {
      resultContractVersion: LEAGUE_SETUP_INTEGRATION_RESULT_VERSION,
      requestContractVersion: LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION,
      mode,
      writesPerformed,
    },
    canonicalDraftGeneration,
  };
}

function setupResultV2(
  league: League,
  canonicalDraftGeneration: FutureSeasonDraftGenerationResult,
  mode: LeagueSetupIntegrationResultV2["setupIntegration"]["mode"],
  writesPerformed: boolean,
): LeagueSetupIntegrationResultV2 {
  return {
    ...league,
    setupIntegration: {
      resultContractVersion: LEAGUE_SETUP_INTEGRATION_RESULT_VERSION_2,
      requestContractVersion: LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION_2,
      mode,
      writesPerformed,
    },
    canonicalDraftGeneration,
  };
}

function setupResultV3(
  league: League,
  canonicalSchedule: PublishedCanonicalSetup,
  mode: LeagueSetupIntegrationResultV3["setupIntegration"]["mode"],
  writesPerformed: boolean,
): LeagueSetupIntegrationResultV3 {
  return {
    ...league,
    canonicalScheduleRevision: canonicalSchedule.generation.sourceScheduleRevision,
    setupIntegration: {
      resultContractVersion: LEAGUE_SETUP_INTEGRATION_RESULT_VERSION_3,
      requestContractVersion: LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION_3,
      mode,
      writesPerformed,
      reviewAvailable: false,
    },
    canonicalDraftGeneration: canonicalSchedule.generation,
    canonicalSchedule: {
      state: "published",
      approvalCommandId: canonicalSchedule.approvalCommandId,
      publicationCommandId: canonicalSchedule.publicationCommandId,
      collectionGroups: canonicalSchedule.groups.groups,
    },
  };
}

async function publishCanonicalSetupInTransaction(input: {
  tx: LeagueScheduleTransaction;
  scope: LeagueSetupScope;
  setupKey: string;
  reason: string;
  generation: FutureSeasonDraftGenerationResult;
}): Promise<PublishedCanonicalSetup> {
  const publication = await publishCanonicalDraftInTransaction(input.tx, {
    organizationId: input.scope.organizationId,
    leagueId: input.generation.leagueId,
    actorUserId: input.scope.actorUserId,
    idempotencyKey: input.setupKey,
    reason: input.reason,
    draftContractFamily: "future_season",
  });
  const [league] = await input.tx.select({ id: leagues.id, doublePayDates: leagues.doublePayDates }).from(leagues).where(and(
    eq(leagues.organizationId, input.scope.organizationId),
    eq(leagues.id, input.generation.leagueId),
  )).for("update");
  if (!league) throw new LeagueSetupIntegrationError("transaction_failure", "published setup league could not be reloaded");
  let groups: PersistCanonicalCollectionGroupsResult;
  try {
    groups = await persistCanonicalCollectionGroupsInTransaction(input.tx, {
      organizationId: input.scope.organizationId,
      leagueId: input.generation.leagueId,
      actorUserId: input.scope.actorUserId,
      generationRunId: input.generation.durableIds.generationRunId,
      sourceScheduleRevision: input.generation.sourceScheduleRevision,
      doublePayDates: league.doublePayDates,
      idempotencyKey: input.setupKey,
      reason: input.reason,
    });
  } catch (error) {
    if (error instanceof CanonicalCollectionGroupingError) {
      throw new LeagueSetupIntegrationError("validation_error", error.message);
    }
    throw error;
  }
  const [revisionedLeague] = await input.tx.update(leagues).set({
    canonicalScheduleRevision: input.generation.sourceScheduleRevision,
  }).where(and(
    eq(leagues.id, input.generation.leagueId),
    eq(leagues.organizationId, input.scope.organizationId),
    eq(leagues.canonicalScheduleRevision, 0),
  )).returning({ id: leagues.id });
  if (!revisionedLeague && !input.generation.mode.includes("retry")) {
    throw new LeagueSetupIntegrationError("transaction_failure", "canonical setup schedule revision could not be initialized");
  }
  return {
    generation: input.generation,
    approvalCommandId: publication.approvalCommandId,
    publicationCommandId: publication.publicationCommandId,
    groups,
  };
}

function injectFailure(requested: LeagueSetupFailureStage | undefined, stage: LeagueSetupFailureStage): void {
  if (requested === stage) throw new LeagueSetupIntegrationError("transaction_failure", `injected league setup failure at ${stage}`);
}

async function existingSetupCommand(
  tx: LeagueScheduleTransaction,
  organizationId: number,
  commandKey: string,
) {
  const [command] = await tx.select().from(leagueScheduleCommands).where(and(
    eq(leagueScheduleCommands.organizationId, organizationId),
    eq(leagueScheduleCommands.idempotencyKey, commandKey),
  ));
  return command;
}

async function assertSetupKeyOrganization(
  tx: LeagueScheduleTransaction,
  organizationId: number,
  commandKey: string,
): Promise<void> {
  const commands = await tx.select({ organizationId: leagueScheduleCommands.organizationId })
    .from(leagueScheduleCommands)
    .where(eq(leagueScheduleCommands.idempotencyKey, commandKey))
    .limit(2);
  if (commands.some((command) => command.organizationId !== organizationId) || commands.length > 1) {
    throw new LeagueSetupIntegrationError("idempotency_conflict", "the setup idempotency key is bound to another organization");
  }
}

async function retryExistingSetup(input: {
  tx: LeagueScheduleTransaction;
  scope: LeagueSetupScope;
  expected: InsertLeague;
  commandKey: string;
  kind: "league" | "new_season";
  setup: AnyLeagueSetupIntegrationIntent;
  setupConfirmationFingerprint?: string;
  seasonClassification?: ProductSeason;
}): Promise<SetupTransactionResult | null> {
  const command = await existingSetupCommand(input.tx, input.scope.organizationId, input.commandKey);
  if (!command) return null;
  const expectedReason = input.setup.contractVersion === LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION
    ? LEAGUE_SETUP_FALL_AUDIT_REASON
    : LEAGUE_SETUP_FUTURE_SEASON_AUDIT_REASON;
  if (command.actorUserId !== input.scope.actorUserId || command.commandType !== "generate" || command.reason !== expectedReason) {
    throw new LeagueSetupIntegrationError("idempotency_conflict", "the setup idempotency key is bound to another actor or operation");
  }
  await lockLeagueSchedule(input.tx, input.scope.organizationId, command.leagueId);
  const [league] = await input.tx.select().from(leagues).where(and(
    eq(leagues.id, command.leagueId),
    eq(leagues.organizationId, input.scope.organizationId),
  )).for("update");
  if (!league) throw new LeagueSetupIntegrationError("idempotency_conflict", "the setup idempotency key has incomplete durable state");
  assertRetrySemantic(input.expected, league, input.kind);
  if (input.setup.contractVersion === LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION) {
    const canonicalDraftGeneration = await applyFallDraftGenerationInTransaction(input.tx, {
      ...input.scope,
      leagueId: league.id,
      internalSetupApply: { idempotencyKey: input.commandKey, reason: LEAGUE_SETUP_FALL_AUDIT_REASON },
    });
    if (canonicalDraftGeneration.mode !== "idempotent_retry" || canonicalDraftGeneration.writesPerformed) {
      throw new LeagueSetupIntegrationError("transaction_failure", "setup retry did not resolve to the durable zero-write result");
    }
    return {
      result: setupResult(league, canonicalDraftGeneration, "idempotent_retry", false),
      affectedBowlerIds: [],
    };
  }
  if (input.setup.contractVersion === LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION_3) {
    if (!input.seasonClassification || !input.setupConfirmationFingerprint) {
      throw new LeagueSetupIntegrationError("transaction_failure", "v3 retry semantics are incomplete");
    }
    const generation = await verifyFutureSeasonSetupRetryInTransaction(input.tx, {
      ...input.scope,
      leagueId: league.id,
      seasonClassification: input.seasonClassification,
      idempotencyKey: input.commandKey,
      reason: LEAGUE_SETUP_FUTURE_SEASON_AUDIT_REASON,
      setupConfirmationFingerprint: input.setupConfirmationFingerprint,
      draftContractFamily: "future_season",
    });
    const published = await publishCanonicalSetupInTransaction({
      tx: input.tx,
      scope: input.scope,
      setupKey: input.commandKey,
      reason: LEAGUE_SETUP_FUTURE_SEASON_AUDIT_REASON,
      generation,
    });
    if (published.generation.mode !== "idempotent_retry" || published.groups.writesPerformed) {
      throw new LeagueSetupIntegrationError("transaction_failure", "v3 retry did not resolve to the durable zero-write result");
    }
    return { result: setupResultV3(league, published, "idempotent_retry", false), affectedBowlerIds: [] };
  }
  if (!input.seasonClassification || !input.setupConfirmationFingerprint) {
    throw new LeagueSetupIntegrationError("transaction_failure", "v2 retry semantics are incomplete");
  }
  const canonicalDraftGeneration = await verifyFutureSeasonSetupRetryInTransaction(input.tx, {
    ...input.scope,
    leagueId: league.id,
    seasonClassification: input.seasonClassification,
    idempotencyKey: input.commandKey,
    reason: LEAGUE_SETUP_FUTURE_SEASON_AUDIT_REASON,
    setupConfirmationFingerprint: input.setupConfirmationFingerprint,
  });
  if (canonicalDraftGeneration.mode !== "idempotent_retry" || canonicalDraftGeneration.writesPerformed) {
    throw new LeagueSetupIntegrationError("transaction_failure", "setup retry did not resolve to the durable zero-write result");
  }
  return {
    result: setupResultV2(league, canonicalDraftGeneration, "idempotent_retry", false),
    affectedBowlerIds: [],
  };
}

async function createLeagueInTransaction(input: {
  tx: LeagueScheduleTransaction;
  scope: LeagueSetupScope;
  league: InsertLeague;
  setup: AnyLeagueSetupIntegrationIntent;
  failureInjection?: LeagueSetupFailureStage;
  canonicalFailureInjection?: FallDraftFailureStage;
}): Promise<SetupTransactionResult> {
  const legacyFall = isActiveFall(input.league);
  await authorizeSetupActor(input.tx, input.scope, input.setup.contractVersion !== LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION || legacyFall, false);
  if ((input.setup.contractVersion === LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION_2 || input.setup.contractVersion === LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION_3) && input.league.active !== true) {
    throw new LeagueSetupIntegrationError("validation_error", "canonical setup requires an active future league");
  }
  await assertLocationScope(input.tx, input.scope.organizationId, input.league.locationId);
  const commandKey = setupCommandKey(input.setup);
  await lockSetupIntent(input.tx, commandKey);
  await assertSetupKeyOrganization(input.tx, input.scope.organizationId, commandKey);
  const start = dateOnly(input.league.seasonStart);
  const seasonClassification = start ? getProductSeasonFromDateOnly(start) : null;
  if (!seasonClassification) throw new LeagueSetupIntegrationError("validation_error", "league start must classify to a product season");
  const confirmationFingerprint = input.setup.contractVersion !== LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION
    ? setupConfirmationFingerprint({ setup: input.setup, kind: "league", target: input.league })
    : undefined;
  const retry = await retryExistingSetup({
    tx: input.tx, scope: input.scope, expected: input.league, commandKey, kind: "league", setup: input.setup,
    setupConfirmationFingerprint: confirmationFingerprint,
    seasonClassification,
  });
  if (retry) return retry;
  if (input.setup.contractVersion === LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION) {
    throw new LeagueSetupIntegrationError(
      "idempotency_conflict",
      "league-setup-integration-request/1 is accepted only for an exact historical Fall retry",
    );
  }
  if (!confirmationFingerprint) {
    throw new LeagueSetupIntegrationError("transaction_failure", "v2 league setup confirmation fingerprint is missing");
  }
  const [league] = await input.tx.insert(leagues).values(input.league).returning();
  if (!league) throw new LeagueSetupIntegrationError("transaction_failure", "league was not created");
  injectFailure(input.failureInjection, "after_league_insert");
  const canonicalDraftGeneration = await applyFutureSeasonDraftGenerationInTransaction(input.tx, {
    ...input.scope,
    leagueId: league.id,
    seasonClassification,
    internalSetupApply: {
      idempotencyKey: commandKey,
      reason: LEAGUE_SETUP_FUTURE_SEASON_AUDIT_REASON,
      setupConfirmationFingerprint: confirmationFingerprint,
    },
    failureInjection: input.canonicalFailureInjection,
  });
  if (input.setup.contractVersion === LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION_3) {
    const canonicalSchedule = await publishCanonicalSetupInTransaction({
      tx: input.tx,
      scope: input.scope,
      setupKey: commandKey,
      reason: LEAGUE_SETUP_FUTURE_SEASON_AUDIT_REASON,
      generation: canonicalDraftGeneration,
    });
    return { result: setupResultV3(league, canonicalSchedule, "created", true), affectedBowlerIds: [] };
  }
  return { result: setupResultV2(league, canonicalDraftGeneration, "created", true), affectedBowlerIds: [] };
}

function buildNewSeasonLeague(
  source: League,
  values: NewSeasonSetupValues | NewSeasonSetupValuesV2 | NewSeasonSetupValuesV3,
  setupVersion: AnyLeagueSetupIntegrationIntent["contractVersion"],
): InsertLeague {
  const explicit = setupVersion === LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION_2 || setupVersion === LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION_3;
  if (explicit && (values.totalBowlingWeeks == null || values.weekDay == null || values.allowPublicSignup == null)) {
    throw new LeagueSetupIntegrationError("validation_error", "canonical target-season values must all be explicit");
  }
  const submittedSeasonEnd = "seasonEnd" in values ? values.seasonEnd : undefined;
  const weekDay = values.weekDay ?? source.weekDay;
  const totalBowlingWeeks = values.totalBowlingWeeks ?? source.totalBowlingWeeks;
  const seasonEnd = values.totalBowlingWeeks != null || !submittedSeasonEnd
    ? totalBowlingWeeks != null
      ? calculateSeasonEnd(values.seasonStart, weekDay, totalBowlingWeeks, values.skipDates, values.cancelledDates)
      : null
    : new Date(submittedSeasonEnd);
  const seasonStart = new Date(values.seasonStart);
  if (!seasonEnd || seasonEnd <= seasonStart) {
    throw new LeagueSetupIntegrationError("validation_error", "season end date must be after start date");
  }
  const doublePay = validateDoublePayDates({
    doublePayDates: values.doublePayDates,
    skipDates: values.skipDates,
    cancelledDates: values.cancelledDates,
    weekDay,
    seasonStart: values.seasonStart,
    seasonEnd: seasonEnd.toISOString(),
  });
  if (!doublePay.ok) throw new LeagueSetupIntegrationError("validation_error", doublePay.message);
  return {
    name: source.name,
    description: source.description,
    payingLineupSize: source.payingLineupSize as 3 | 4,
    active: true,
    allowPublicSignup: values.allowPublicSignup ?? source.allowPublicSignup,
    seasonStart: seasonStart.toISOString(),
    seasonEnd: seasonEnd.toISOString(),
    weekDay,
    weeklyFee: source.weeklyFee,
    lineageFee: source.lineageFee,
    prizeFundFee: source.prizeFundFee,
    practiceStartTime: source.practiceStartTime ?? undefined,
    competitionStartTime: source.competitionStartTime ?? undefined,
    timezone: source.timezone ?? DEFAULT_TIMEZONE,
    squareLineageItemId: explicit ? null : source.squareLineageItemId,
    lineageItemVariationId: explicit ? null : source.lineageItemVariationId,
    squareLineageItemName: explicit ? null : source.squareLineageItemName,
    squarePrizeFundItemId: explicit ? null : source.squarePrizeFundItemId,
    prizeFundItemVariationId: explicit ? null : source.prizeFundItemVariationId,
    squarePrizeFundItemName: explicit ? null : source.squarePrizeFundItemName,
    squareCategoryId: explicit ? null : source.squareCategoryId,
    paymentMode: values.paymentMode,
    organizationId: source.organizationId,
    locationId: source.locationId,
    seasonNumber: source.seasonNumber + 1,
    previousSeasonId: source.id,
    totalBowlingWeeks,
    skipDates: values.skipDates,
    cancelledDates: values.cancelledDates,
    doublePayDates: values.doublePayDates,
  };
}

async function retryExistingNewSeasonV2BeforeSourceFreshness(input: {
  tx: LeagueScheduleTransaction;
  scope: LeagueSetupScope;
  sourceLeagueId: number;
  values: NewSeasonSetupValues | NewSeasonSetupValuesV2 | NewSeasonSetupValuesV3;
  setup: LeagueSetupIntegrationIntentV2 | LeagueSetupIntegrationIntentV3;
  sourceConfirmation?: LeagueRolloverSourceConfirmation;
  commandKey: string;
}): Promise<SetupTransactionResult | null> {
  const command = await existingSetupCommand(input.tx, input.scope.organizationId, input.commandKey);
  if (!command) return null;
  if (!input.sourceConfirmation || input.sourceConfirmation.contractVersion !== LEAGUE_ROLLOVER_SOURCE_CONTRACT_VERSION
    || input.sourceConfirmation.confirmed !== true) {
    throw new LeagueSetupIntegrationError("idempotency_conflict", "canonical retry is missing its original source confirmation");
  }
  await lockLeagueSchedule(input.tx, input.scope.organizationId, command.leagueId);
  const [persisted] = await input.tx.select().from(leagues).where(and(
    eq(leagues.id, command.leagueId),
    eq(leagues.organizationId, input.scope.organizationId),
  )).for("update");
  if (!persisted || persisted.previousSeasonId !== input.sourceLeagueId) {
    throw new LeagueSetupIntegrationError("idempotency_conflict", "setup idempotency key is bound to another source league");
  }
  const syntheticSource: League = {
    ...persisted,
    id: input.sourceLeagueId,
    active: true,
    seasonNumber: persisted.seasonNumber - 1,
  };
  const expected = buildNewSeasonLeague(syntheticSource, input.values, input.setup.contractVersion);
  const start = dateOnly(expected.seasonStart);
  const seasonClassification = start ? getProductSeasonFromDateOnly(start) : null;
  if (!seasonClassification) {
    throw new LeagueSetupIntegrationError("validation_error", "target season start must classify to a product season");
  }
  const confirmationFingerprint = setupConfirmationFingerprint({
    setup: input.setup,
    kind: "new_season",
    target: expected,
    sourceConfirmationFingerprint: input.sourceConfirmation.fingerprint,
  });
  return retryExistingSetup({
    tx: input.tx,
    scope: input.scope,
    expected,
    commandKey: input.commandKey,
    kind: "new_season",
    setup: input.setup,
    setupConfirmationFingerprint: confirmationFingerprint,
    seasonClassification,
  });
}

async function createNewSeasonInTransaction(input: {
  tx: LeagueScheduleTransaction;
  scope: LeagueSetupScope;
  sourceLeagueId: number;
  values: NewSeasonSetupValues | NewSeasonSetupValuesV2 | NewSeasonSetupValuesV3;
  setup: AnyLeagueSetupIntegrationIntent;
  sourceConfirmation?: LeagueRolloverSourceConfirmation;
  failureInjection?: LeagueSetupFailureStage;
  canonicalFailureInjection?: FallDraftFailureStage;
}): Promise<SetupTransactionResult> {
  await authorizeSetupActor(input.tx, input.scope, true, false);
  const commandKey = setupCommandKey(input.setup);
  await lockSetupIntent(input.tx, commandKey);
  await assertSetupKeyOrganization(input.tx, input.scope.organizationId, commandKey);
  if (input.setup.contractVersion === LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION_2 || input.setup.contractVersion === LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION_3) {
    const retry = await retryExistingNewSeasonV2BeforeSourceFreshness({
      tx: input.tx,
      scope: input.scope,
      sourceLeagueId: input.sourceLeagueId,
      values: input.values,
      setup: input.setup,
      sourceConfirmation: input.sourceConfirmation,
      commandKey,
    });
    if (retry) return retry;
  }
  await lockLeagueSchedule(input.tx, input.scope.organizationId, input.sourceLeagueId);
  await authorizeSetupActor(input.tx, input.scope, true);
  const [source] = await input.tx.select().from(leagues).where(and(
    eq(leagues.id, input.sourceLeagueId),
    eq(leagues.organizationId, input.scope.organizationId),
  )).for("update");
  if (!source) throw new LeagueSetupIntegrationError("source_league_not_found", "source league was not found in the authorized organization");
  const carriedEvidence = await loadRolloverCarriedEvidence(
    input.tx,
    input.scope.organizationId,
    source.id,
    true,
  );
  const sourceContract = rolloverSourceContract(source, carriedEvidence);
  if (input.setup.contractVersion === LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION_2 || input.setup.contractVersion === LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION_3) {
    if (!input.sourceConfirmation || input.sourceConfirmation.contractVersion !== LEAGUE_ROLLOVER_SOURCE_CONTRACT_VERSION
      || input.sourceConfirmation.confirmed !== true
      || input.sourceConfirmation.fingerprint !== sourceContract.fingerprint) {
      throw new LeagueSetupIntegrationError("stale_source_league", "confirmed carried configuration no longer matches the locked source league");
    }
  }
  const target = buildNewSeasonLeague(source, input.values, input.setup.contractVersion);
  const start = dateOnly(target.seasonStart);
  const seasonClassification = start ? getProductSeasonFromDateOnly(start) : null;
  if (!seasonClassification) throw new LeagueSetupIntegrationError("validation_error", "target season start must classify to a product season");
  const fall = isActiveFall(target);
  if (input.setup.contractVersion === LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION_2 || input.setup.contractVersion === LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION_3 || fall) {
    await assertLocationScope(input.tx, input.scope.organizationId, target.locationId);
  }
  const confirmationFingerprint = input.setup.contractVersion !== LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION
    ? setupConfirmationFingerprint({
      setup: input.setup,
      kind: "new_season",
      target,
      sourceConfirmationFingerprint: sourceContract.fingerprint,
    })
    : undefined;
  const retry = await retryExistingSetup({
    tx: input.tx, scope: input.scope, expected: target, commandKey, kind: "new_season", setup: input.setup,
    setupConfirmationFingerprint: confirmationFingerprint,
    seasonClassification,
  });
  if (retry) return retry;
  if (input.setup.contractVersion === LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION) {
    throw new LeagueSetupIntegrationError(
      "idempotency_conflict",
      "league-setup-integration-request/1 is accepted only for an exact historical Fall retry",
    );
  }
  if (!confirmationFingerprint) {
    throw new LeagueSetupIntegrationError("transaction_failure", "canonical rollover confirmation fingerprint is missing");
  }
  if (!source.active) throw new LeagueSetupIntegrationError("stale_source_league", "the source league is no longer active");
  const [successor] = await input.tx.select({ id: leagues.id }).from(leagues).where(and(
    eq(leagues.organizationId, input.scope.organizationId),
    eq(leagues.previousSeasonId, source.id),
  )).limit(1);
  if (successor) throw new LeagueSetupIntegrationError("successor_exists", "a successor season already exists for the source league");
  const [league] = await input.tx.insert(leagues).values(target).returning();
  if (!league) throw new LeagueSetupIntegrationError("transaction_failure", "new season league was not created");
  injectFailure(input.failureInjection, "after_league_insert");
  await lockLeagueSchedule(input.tx, input.scope.organizationId, league.id);

  const teamIdMap = new Map<number, number>();
  for (const sourceTeam of carriedEvidence.teams) {
    const [newTeam] = await input.tx.insert(teams).values({
      name: sourceTeam.name,
      number: sourceTeam.number,
      leagueId: league.id,
      active: sourceTeam.active,
      displayOrder: sourceTeam.displayOrder,
    }).returning();
    if (!newTeam) throw new LeagueSetupIntegrationError("transaction_failure", "new season team was not copied");
    teamIdMap.set(sourceTeam.id, newTeam.id);
  }
  injectFailure(input.failureInjection, "after_team_copy");

  const affectedBowlerIds = new Set<number>();
  for (const row of carriedEvidence.roster) {
    const teamId = teamIdMap.get(row.teamId);
    if (!teamId) throw new LeagueSetupIntegrationError("transaction_failure", "source roster team mapping is incomplete");
    await input.tx.insert(bowlerLeagues).values({
      bowlerId: row.bowlerId,
      leagueId: league.id,
      teamId,
      active: row.active,
      order: row.order,
      joinedAt: row.joinedAt,
    });
    affectedBowlerIds.add(row.bowlerId);
  }
  injectFailure(input.failureInjection, "after_roster_copy");

  const canonicalDraftGeneration = await applyFutureSeasonDraftGenerationInTransaction(input.tx, {
    ...input.scope,
    leagueId: league.id,
    seasonClassification,
    internalSetupApply: {
      idempotencyKey: commandKey,
      reason: LEAGUE_SETUP_FUTURE_SEASON_AUDIT_REASON,
      setupConfirmationFingerprint: confirmationFingerprint,
    },
    failureInjection: input.canonicalFailureInjection,
  });
  injectFailure(input.failureInjection, "after_canonical_generation");
  let publishedSetup: PublishedCanonicalSetup | null = null;
  if (input.setup.contractVersion === LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION_3) {
    publishedSetup = await publishCanonicalSetupInTransaction({
      tx: input.tx,
      scope: input.scope,
      setupKey: commandKey,
      reason: LEAGUE_SETUP_FUTURE_SEASON_AUDIT_REASON,
      generation: canonicalDraftGeneration,
    });
  }
  const [archived] = await input.tx.update(leagues).set({ active: false }).where(and(
    eq(leagues.id, source.id),
    eq(leagues.organizationId, input.scope.organizationId),
    eq(leagues.active, true),
  )).returning({ id: leagues.id });
  if (!archived) throw new LeagueSetupIntegrationError("stale_source_league", "the source league could not be archived atomically");
  injectFailure(input.failureInjection, "after_source_archive");
  return {
    result: publishedSetup
      ? setupResultV3(league, publishedSetup, "created", true)
      : setupResultV2(league, canonicalDraftGeneration, "created", true),
    affectedBowlerIds: [...affectedBowlerIds],
  };
}

function invalidateSetupCaches(): void {
  cacheInvalidate("leagues:");
  cacheInvalidate("bowlers:");
}

export async function createLeagueWithCanonicalSetup(input: {
  scope: LeagueSetupScope;
  league: InsertLeague;
  setup: AnyLeagueSetupIntegrationIntent;
  failureInjection?: LeagueSetupFailureStage;
  canonicalFailureInjection?: FallDraftFailureStage;
}): Promise<AnyLeagueSetupIntegrationResult> {
  const committed = await db.transaction(
    (tx) => createLeagueInTransaction({ tx, ...input }),
    { isolationLevel: "read committed", accessMode: "read write" },
  );
  if (committed.result.setupIntegration.writesPerformed) invalidateSetupCaches();
  return committed.result;
}

export async function createNewSeasonWithCanonicalSetup(input: {
  scope: LeagueSetupScope;
  sourceLeagueId: number;
  values: NewSeasonSetupValues | NewSeasonSetupValuesV2 | NewSeasonSetupValuesV3;
  setup: AnyLeagueSetupIntegrationIntent;
  sourceConfirmation?: LeagueRolloverSourceConfirmation;
  failureInjection?: LeagueSetupFailureStage;
  canonicalFailureInjection?: FallDraftFailureStage;
}): Promise<SetupTransactionResult> {
  const committed = await db.transaction(
    (tx) => createNewSeasonInTransaction({ tx, ...input }),
    { isolationLevel: "read committed", accessMode: "read write" },
  );
  if (committed.result.setupIntegration.writesPerformed) invalidateSetupCaches();
  return committed;
}

export async function loadLeagueRolloverSource(input: {
  scope: LeagueSetupScope;
  sourceLeagueId: number;
}): Promise<LeagueRolloverSourceContract> {
  return db.transaction(async (tx) => {
    await authorizeSetupActor(tx, input.scope, true, false);
    const [source] = await tx.select().from(leagues).where(and(
      eq(leagues.id, input.sourceLeagueId),
      eq(leagues.organizationId, input.scope.organizationId),
    ));
    if (!source) {
      throw new LeagueSetupIntegrationError("source_league_not_found", "source league was not found in the authorized organization");
    }
    if (!source.active) {
      throw new LeagueSetupIntegrationError("stale_source_league", "only an active source league can be confirmed for rollover");
    }
    await assertLocationScope(tx, input.scope.organizationId, source.locationId);
    const evidence = await loadRolloverCarriedEvidence(tx, input.scope.organizationId, source.id, false);
    return rolloverSourceContract(source, evidence);
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
