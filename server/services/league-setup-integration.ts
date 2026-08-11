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
import { getProductSeasonFromDateOnly } from "@shared/season-utils";
import { validateDoublePayDates } from "@shared/schema/leagues";
import {
  fallDraftCanonicalJson,
  fallDraftSha256,
  type FallDraftApplyResult,
} from "@shared/fall-draft-generation";
import {
  LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION,
  LEAGUE_SETUP_INTEGRATION_RESULT_VERSION,
  type LeagueSetupIntegrationIntent,
  type LeagueSetupIntegrationResult,
} from "@shared/league-setup-integration";
import { db } from "../db.js";
import { cacheInvalidate } from "../utils/cache.js";
import {
  applyFallDraftGenerationInTransaction,
  type FallDraftFailureStage,
} from "./fall-draft-generation.js";
import { lockLeagueSchedule, type LeagueScheduleTransaction } from "../storage/league-schedule-lock.js";

export const LEAGUE_SETUP_FALL_AUDIT_REASON = "Generate canonical Fall drafts during authoritative league setup";

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

interface SetupTransactionResult {
  result: LeagueSetupIntegrationResult;
  affectedBowlerIds: number[];
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new LeagueSetupIntegrationError("invalid_scope", `${field} must be a positive safe integer`);
  }
}

function setupCommandKey(intent: LeagueSetupIntegrationIntent): string {
  return `lvsetup:${fallDraftSha256({
    contractVersion: LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION,
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

async function assertOptionalLocationScope(
  tx: LeagueScheduleTransaction,
  organizationId: number,
  locationId: number | null | undefined,
): Promise<void> {
  if (locationId == null) return;
  const [location] = await tx.select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.id, locationId), eq(locations.organizationId, organizationId)));
  if (!location) throw new LeagueSetupIntegrationError("location_not_found", "location not found for this organization");
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
}): Promise<SetupTransactionResult | null> {
  const command = await existingSetupCommand(input.tx, input.scope.organizationId, input.commandKey);
  if (!command) return null;
  if (command.actorUserId !== input.scope.actorUserId || command.commandType !== "generate" || command.reason !== LEAGUE_SETUP_FALL_AUDIT_REASON) {
    throw new LeagueSetupIntegrationError("idempotency_conflict", "the setup idempotency key is bound to another actor or operation");
  }
  await lockLeagueSchedule(input.tx, input.scope.organizationId, command.leagueId);
  const [league] = await input.tx.select().from(leagues).where(and(
    eq(leagues.id, command.leagueId),
    eq(leagues.organizationId, input.scope.organizationId),
  )).for("update");
  if (!league) throw new LeagueSetupIntegrationError("idempotency_conflict", "the setup idempotency key has incomplete durable state");
  assertRetrySemantic(input.expected, league, input.kind);
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

async function createLeagueInTransaction(input: {
  tx: LeagueScheduleTransaction;
  scope: LeagueSetupScope;
  league: InsertLeague;
  setup: LeagueSetupIntegrationIntent;
  failureInjection?: LeagueSetupFailureStage;
  canonicalFailureInjection?: FallDraftFailureStage;
}): Promise<SetupTransactionResult> {
  const fall = isActiveFall(input.league);
  await authorizeSetupActor(input.tx, input.scope, fall, false);
  await assertOptionalLocationScope(input.tx, input.scope.organizationId, input.league.locationId);
  if (!fall) {
    const [league] = await input.tx.insert(leagues).values(input.league).returning();
    if (!league) throw new LeagueSetupIntegrationError("transaction_failure", "league was not created");
    return { result: setupResult(league, null, "not_applicable", true), affectedBowlerIds: [] };
  }
  await assertLocationScope(input.tx, input.scope.organizationId, input.league.locationId);
  const commandKey = setupCommandKey(input.setup);
  await lockSetupIntent(input.tx, commandKey);
  await assertSetupKeyOrganization(input.tx, input.scope.organizationId, commandKey);
  const retry = await retryExistingSetup({
    tx: input.tx, scope: input.scope, expected: input.league, commandKey, kind: "league",
  });
  if (retry) return retry;
  const [league] = await input.tx.insert(leagues).values(input.league).returning();
  if (!league) throw new LeagueSetupIntegrationError("transaction_failure", "league was not created");
  injectFailure(input.failureInjection, "after_league_insert");
  const canonicalDraftGeneration = await applyFallDraftGenerationInTransaction(input.tx, {
    ...input.scope,
    leagueId: league.id,
    internalSetupApply: { idempotencyKey: commandKey, reason: LEAGUE_SETUP_FALL_AUDIT_REASON },
    failureInjection: input.canonicalFailureInjection,
  });
  return {
    result: setupResult(league, canonicalDraftGeneration, "created", true),
    affectedBowlerIds: [],
  };
}

function buildNewSeasonLeague(source: League, values: NewSeasonSetupValues): InsertLeague {
  const weekDay = values.weekDay ?? source.weekDay;
  const totalBowlingWeeks = values.totalBowlingWeeks ?? source.totalBowlingWeeks;
  const seasonEnd = values.totalBowlingWeeks != null || !values.seasonEnd
    ? totalBowlingWeeks != null
      ? calculateSeasonEnd(values.seasonStart, weekDay, totalBowlingWeeks, values.skipDates, values.cancelledDates)
      : null
    : new Date(values.seasonEnd);
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
    squareLineageItemId: source.squareLineageItemId,
    lineageItemVariationId: source.lineageItemVariationId,
    squareLineageItemName: source.squareLineageItemName,
    squarePrizeFundItemId: source.squarePrizeFundItemId,
    prizeFundItemVariationId: source.prizeFundItemVariationId,
    squarePrizeFundItemName: source.squarePrizeFundItemName,
    squareCategoryId: source.squareCategoryId,
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

async function createNewSeasonInTransaction(input: {
  tx: LeagueScheduleTransaction;
  scope: LeagueSetupScope;
  sourceLeagueId: number;
  values: NewSeasonSetupValues;
  setup: LeagueSetupIntegrationIntent;
  failureInjection?: LeagueSetupFailureStage;
  canonicalFailureInjection?: FallDraftFailureStage;
}): Promise<SetupTransactionResult> {
  await authorizeSetupActor(input.tx, input.scope, true, false);
  const commandKey = setupCommandKey(input.setup);
  await lockSetupIntent(input.tx, commandKey);
  await assertSetupKeyOrganization(input.tx, input.scope.organizationId, commandKey);
  await lockLeagueSchedule(input.tx, input.scope.organizationId, input.sourceLeagueId);
  await authorizeSetupActor(input.tx, input.scope, true);
  const [source] = await input.tx.select().from(leagues).where(and(
    eq(leagues.id, input.sourceLeagueId),
    eq(leagues.organizationId, input.scope.organizationId),
  )).for("update");
  if (!source) throw new LeagueSetupIntegrationError("source_league_not_found", "source league was not found in the authorized organization");
  const target = buildNewSeasonLeague(source, input.values);
  const fall = isActiveFall(target);
  if (fall) {
    await assertLocationScope(input.tx, input.scope.organizationId, target.locationId);
    const retry = await retryExistingSetup({
      tx: input.tx, scope: input.scope, expected: target, commandKey, kind: "new_season",
    });
    if (retry) return retry;
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

  const sourceTeams = await input.tx.select().from(teams)
    .where(eq(teams.leagueId, source.id))
    .orderBy(asc(teams.displayOrder), asc(teams.number), asc(teams.id))
    .for("update");
  const teamIdMap = new Map<number, number>();
  for (const sourceTeam of sourceTeams) {
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

  const sourceRoster = await input.tx.select({
    row: bowlerLeagues,
    bowlerOrganizationId: bowlers.organizationId,
  }).from(bowlerLeagues)
    .innerJoin(bowlers, eq(bowlers.id, bowlerLeagues.bowlerId))
    .where(eq(bowlerLeagues.leagueId, source.id))
    .orderBy(asc(bowlerLeagues.teamId), asc(bowlerLeagues.order), asc(bowlerLeagues.id))
    .for("update");
  const affectedBowlerIds = new Set<number>();
  for (const { row, bowlerOrganizationId } of sourceRoster) {
    if (bowlerOrganizationId !== input.scope.organizationId) {
      throw new LeagueSetupIntegrationError("transaction_failure", "source roster contains cross-tenant membership");
    }
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

  let canonicalDraftGeneration: FallDraftApplyResult | null = null;
  if (fall) {
    canonicalDraftGeneration = await applyFallDraftGenerationInTransaction(input.tx, {
      ...input.scope,
      leagueId: league.id,
      internalSetupApply: { idempotencyKey: commandKey, reason: LEAGUE_SETUP_FALL_AUDIT_REASON },
      failureInjection: input.canonicalFailureInjection,
    });
  }
  injectFailure(input.failureInjection, "after_canonical_generation");
  const [archived] = await input.tx.update(leagues).set({ active: false }).where(and(
    eq(leagues.id, source.id),
    eq(leagues.organizationId, input.scope.organizationId),
    eq(leagues.active, true),
  )).returning({ id: leagues.id });
  if (!archived) throw new LeagueSetupIntegrationError("stale_source_league", "the source league could not be archived atomically");
  injectFailure(input.failureInjection, "after_source_archive");
  return {
    result: setupResult(league, canonicalDraftGeneration, fall ? "created" : "not_applicable", true),
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
  setup: LeagueSetupIntegrationIntent;
  failureInjection?: LeagueSetupFailureStage;
  canonicalFailureInjection?: FallDraftFailureStage;
}): Promise<LeagueSetupIntegrationResult> {
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
  values: NewSeasonSetupValues;
  setup: LeagueSetupIntegrationIntent;
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
