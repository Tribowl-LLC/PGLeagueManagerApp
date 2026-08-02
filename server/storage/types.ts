import type {
  League, InsertLeague, UpdateLeague,
  Team, InsertTeam, UpdateTeam,
  Bowler, InsertBowler, UpdateBowler,
  BowlerLeague, InsertBowlerLeague, UpdateBowlerLeague,
  Payment, InsertPayment, UpdatePayment,
  Game, InsertGame, UpdateGame,
  Score, InsertScore, UpdateScore,
  User, InsertUser, UpdateUser,
  Organization, InsertOrganization, UpdateOrganization,
  Location, InsertLocation, UpdateLocation,
  PaymentSchedule, InsertPaymentSchedule, UpdatePaymentSchedule,
  PaymentOperation, PaymentOperationErrorClassification,
  AutopaySetupRequest,
  UserRole,
  LocationSquareCredentials,
  PaginatedResult,
  EmailTemplate, UpdateEmailTemplate,
  DeletionRequest, InsertDeletionRequest, DeletionRequestStatus,
  EmailChangeRequest, InsertEmailChangeRequest,
  ApplePayJob, ApplePayJobItem, ApplePayJobStatus, ApplePayJobItemStatus,
} from "@shared/schema";

export interface IFirstAdminBootstrapStorage {
  bootstrapFirstAdmin(input: {
    email: string;
    hashedPassword: string;
    name: string;
    phone?: string;
  }): Promise<User>;
  promoteFirstAdmin(userId: number): Promise<User>;
}

export interface ILeagueStorage {
  getLeagues(organizationId: number): Promise<League[]>;
  getAllLeaguesSystemAdmin(): Promise<League[]>;
  getLeague(id: number): Promise<League | undefined>;
  getLeaguesByIds(ids: number[]): Promise<League[]>;
  createLeague(league: InsertLeague): Promise<League>;
  updateLeague(id: number, league: UpdateLeague): Promise<League>;
  deleteLeague(id: number): Promise<void>;
  archiveLeague(id: number): Promise<League>;
  restoreLeague(id: number): Promise<League>;
}

export interface ITeamStorage {
  getTeams(leagueId?: number): Promise<Team[]>;
  getTeam(id: number): Promise<Team | undefined>;
  getTeamsByIds(ids: number[]): Promise<Team[]>;
  getTeamByNumber(leagueId: number, teamNumber: number): Promise<Team | undefined>;
  createTeam(team: InsertTeam): Promise<Team>;
  updateTeam(id: number, team: UpdateTeam): Promise<Team>;
  deleteTeam(id: number): Promise<void>;
  reorderTeams(updates: { id: number; displayOrder: number; number: number }[]): Promise<void>;
  renumberActiveTeams(leagueId: number): Promise<void>;
}

export interface IBowlerStorage {
  getBowlers(filters: { teamId?: number; organizationId: number }): Promise<Bowler[]>;
  getAllBowlersSystemAdmin(): Promise<Bowler[]>;
  getBowler(id: number): Promise<Bowler | undefined>;
  getBowlersByIds(ids: number[]): Promise<Bowler[]>;
  getBowlerByEmail(email: string, organizationId: number): Promise<Bowler | undefined>;
  getBowlerByEmailInOrg(email: string, organizationId: number): Promise<Bowler | undefined>;
  searchBowlersByName(q: string, organizationId: number, limit?: number): Promise<{ id: number; name: string; organizationId: number; secondaryLabel: string | null }[]>;
  getBowlerByEmailSystemAdmin(email: string): Promise<Bowler | undefined>;
  getBowlersByEmailSystemAdmin(email: string): Promise<Bowler[]>;
  createBowler(bowler: InsertBowler): Promise<Bowler>;
  updateBowler(id: number, bowler: UpdateBowler): Promise<Bowler>;
  deleteBowler(id: number): Promise<void>;
  anonymizeBowler(id: number): Promise<Bowler>;
  getBowlerLeagues(filters?: { bowlerId?: number; leagueId?: number; teamId?: number }): Promise<BowlerLeague[]>;
  getBowlerLeague(id: number): Promise<BowlerLeague | undefined>;
  isBowlerActiveInLeague(bowlerId: number, leagueId: number): Promise<boolean>;
  getBowlerLeaguesByBowlerIds(bowlerIds: number[]): Promise<BowlerLeague[]>;
  createBowlerLeague(bowlerLeague: InsertBowlerLeague): Promise<BowlerLeague>;
  createBowlerLeagueIfBowlerFree(bowlerLeague: InsertBowlerLeague): Promise<BowlerLeague | null>;
  createBowlerLeagueIfNotInLeague(bowlerLeague: InsertBowlerLeague): Promise<BowlerLeague | null>;
  updateBowlerLeague(id: number, bowlerLeague: UpdateBowlerLeague): Promise<BowlerLeague>;
  updateBowlerLeagueOrder(id: number, newOrder: number): Promise<BowlerLeague[]>;
  deleteBowlerLeague(id: number): Promise<boolean>;
}

export interface IPaymentStorage {
  getPayments(filters: { bowlerId?: number; leagueId?: number; teamId?: number; weekOf?: Date; organizationId: number }): Promise<Payment[]>;
  getAllPaymentsSystemAdmin(filters?: { bowlerId?: number; leagueId?: number; teamId?: number; weekOf?: Date }): Promise<Payment[]>;
  getAllPaymentsPaginatedSystemAdmin(filters: { bowlerId?: number; leagueId?: number; teamId?: number; weekOf?: Date }, page: number, limit: number): Promise<PaginatedResult<Payment>>;
  getPaymentsPaginated(filters: { bowlerId?: number; leagueId?: number; teamId?: number; weekOf?: Date; organizationId: number }, page: number, limit: number): Promise<PaginatedResult<Payment>>;
  getPaymentById(id: number): Promise<Payment | undefined>;
  getPaymentByIdempotencyKey(key: string): Promise<Payment | undefined>;
  getPaymentByDisputeId(disputeId: string): Promise<Payment | undefined>;
  getPaymentByProviderPaymentId(providerPaymentId: string): Promise<Payment | undefined>;
  createPayment(payment: InsertPayment): Promise<Payment>;
  createCombinedPayments(rows: InsertPayment[]): Promise<Array<{ id: number; bowlerId: number; amount: number }>>;
  getPaymentsByCombinedGroupId(groupId: string): Promise<Payment[]>;
  updatePayment(id: number, payment: UpdatePayment): Promise<Payment>;
  refundPayment(id: number, providerRefundId?: string, reason?: string): Promise<Payment>;
  openDispute(id: number, disputeId: string): Promise<Payment>;
  deletePayment(id: number): Promise<void>;
  createPaymentSchedule(schedule: InsertPaymentSchedule): Promise<PaymentSchedule>;
  getPaymentSchedule(bowlerId: number, leagueId: number): Promise<PaymentSchedule | undefined>;
  getPaymentScheduleById(id: number): Promise<PaymentSchedule | undefined>;
  getActiveSchedulesByLeague(leagueId: number): Promise<PaymentSchedule[]>;
  getActiveSchedulesByLocationId(locationId: number): Promise<PaymentSchedule[]>;
  deactivatePaymentSchedule(id: number, reason?: string): Promise<void>;
  updatePaymentScheduleFields(id: number, fields: UpdatePaymentSchedule): Promise<PaymentSchedule>;
  updatePaymentScheduleCard(bowlerId: number, leagueId: number, cardId: string): Promise<void>;
}

export interface IPaymentOperationStorage {
  createOrGetInteractivePaymentOperation(
    input: import("./payment-operations").CreateOrGetInteractivePaymentOperationInput,
    existingTransaction?: import("./payment-operations").PaymentOperationTransaction,
  ): Promise<PaymentOperation>;
  createOrGetScheduledPaymentOperation(
    input: import("./payment-operations").CreateOrGetScheduledPaymentOperationInput,
    existingTransaction?: import("./payment-operations").PaymentOperationTransaction,
  ): Promise<PaymentOperation>;
  getPaymentOperationForOrganization(
    organizationId: number,
    operationId: string,
  ): Promise<PaymentOperation | undefined>;
  acquirePaymentOperationLease(
    input: import("./payment-operations").AcquirePaymentOperationLeaseInput,
  ): Promise<PaymentOperation | undefined>;
  schedulePaymentOperationRetry(
    input: import("./payment-operations").LeasedPaymentOperationInput & {
      nextAttemptAt: Date;
      errorClassification: PaymentOperationErrorClassification;
      errorCode?: string | null;
      providerOrderId?: string | null;
      failedPaymentRows?: import("./payment-operations").PaymentOperationLinkedPaymentInput[];
    },
  ): Promise<PaymentOperation>;
  recordPaymentOperationProviderUnknown(
    input: import("./payment-operations").LeasedPaymentOperationInput & {
      recoveryAt: Date;
      errorCode?: string | null;
      providerOrderId?: string | null;
      failedPaymentRows?: import("./payment-operations").PaymentOperationLinkedPaymentInput[];
    },
  ): Promise<PaymentOperation>;
  recordPaymentOperationActionRequired(
    input: import("./payment-operations").LeasedPaymentOperationInput & {
      errorCode?: string | null;
      providerOrderId?: string | null;
      failedPaymentRows?: import("./payment-operations").PaymentOperationLinkedPaymentInput[];
    },
  ): Promise<PaymentOperation>;
  recordPaymentOperationFailedTerminal(
    input: import("./payment-operations").LeasedPaymentOperationInput & {
      errorClassification: PaymentOperationErrorClassification;
      errorCode?: string | null;
      providerOrderId?: string | null;
      failedPaymentRows?: import("./payment-operations").PaymentOperationLinkedPaymentInput[];
    },
  ): Promise<PaymentOperation>;
  finalizePaymentOperationSuccess(
    input: import("./payment-operations").LeasedPaymentOperationInput & {
      providerObjectId: string;
      providerOrderId?: string | null;
      paymentRows?: import("./payment-operations").PaymentOperationLinkedPaymentInput[];
    },
  ): Promise<PaymentOperation>;
  reconcilePaymentOperationSuccess(
    input: import("./payment-operations").LeasedPaymentOperationInput & {
      providerObjectId: string;
      providerOrderId?: string | null;
      paymentRows?: import("./payment-operations").PaymentOperationLinkedPaymentInput[];
    },
  ): Promise<PaymentOperation>;
  persistScheduledPaymentOperationSnapshot(
    operation: PaymentOperation,
    snapshot: import("../services/scheduled-payment-operation-snapshot").ScheduledPaymentSemanticSnapshot,
    transaction: import("./payment-operations").PaymentOperationTransaction,
  ): Promise<import("../services/scheduled-payment-operation-snapshot").ScheduledPaymentSemanticSnapshot>;
  getScheduledPaymentOperationSnapshotForOrganization(
    organizationId: number,
    operationId: string,
  ): Promise<import("../services/scheduled-payment-operation-snapshot").ScheduledPaymentSemanticSnapshot | undefined>;
  getNextPaymentOperationWake(): Promise<import("./payment-operations").PaymentOperationWake | undefined>;
  recordExpiredPaymentOperationAttemptExhausted(input: {
    organizationId: number;
    operationId: string;
    now?: Date;
    failedPaymentRows?: import("./payment-operations").PaymentOperationLinkedPaymentInput[];
  }): Promise<PaymentOperation | undefined>;
  hasNonterminalScheduledPaymentOperation(input: {
    organizationId: number;
    paymentScheduleId: number;
  }): Promise<boolean>;
  cancelPaymentOperation(
    input: Omit<import("./payment-operations").LeasedPaymentOperationInput, "leaseToken"> & {
      leaseToken?: string;
    },
  ): Promise<PaymentOperation>;
}

export interface IAutopaySetupRequestStorage {
  createOrGetAutopaySetupRequest(
    input: import("./autopay-setup-requests").CreateOrGetAutopaySetupRequestInput,
  ): Promise<import("./autopay-setup-requests").AutopaySetupRequestWithOperation>;
  getAutopaySetupRequestForOrganization(
    organizationId: number,
    requestId: string,
  ): Promise<import("./autopay-setup-requests").AutopaySetupRequestWithOperation | undefined>;
  getAutopaySetupRequestByOperationForOrganization(
    organizationId: number,
    operationId: string,
  ): Promise<AutopaySetupRequest | undefined>;
  completeAutopaySetupRequest(input: {
    organizationId: number;
    requestId: string;
    paymentScheduleId?: number | null;
    now?: Date;
  }): Promise<AutopaySetupRequest>;
  cancelAutopaySetupRequest(input: {
    organizationId: number;
    requestId: string;
    now?: Date;
  }): Promise<AutopaySetupRequest>;
}

export interface IGameScoreStorage {
  getGames(leagueId: number, weekNumber?: number): Promise<Game[]>;
  getGame(id: number): Promise<Game | undefined>;
  createGame(game: InsertGame): Promise<Game>;
  updateGame(id: number, game: UpdateGame): Promise<Game>;
  deleteGame(id: number): Promise<void>;
  getScores(gameId: number, teamId?: number): Promise<Score[]>;
  getScore(id: number): Promise<Score | undefined>;
  getScoresByGameIds(gameIds: number[]): Promise<Score[]>;
  getScoresByLeagueAndWeek(leagueId: number, weekNumber: number): Promise<Score[]>;
  getBowlerScores(bowlerId: number): Promise<Score[]>;
  createScore(score: InsertScore): Promise<Score>;
  updateScore(id: number, score: UpdateScore): Promise<Score>;
  deleteScore(id: number): Promise<void>;
  createBatchScores(scores: InsertScore[]): Promise<Score[]>;
  getGameScores(gameId: number): Promise<Score[]>;
}

export interface IUserStorage {
  getUser(id: number): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getUsers(): Promise<User[]>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: number, userData: UpdateUser, executor?: import('./users').UserDbExecutor): Promise<User>;
  updateUserRole(userId: number, role: UserRole, executor?: import('./users').UserDbExecutor): Promise<User>;
  deleteUser(userId: number, executor?: import('./users').UserDbExecutor): Promise<User>;
  linkUserToBowler(userId: number, bowlerId: number | undefined): Promise<User>;
  getLinkedBowlerIds(): Promise<number[]>;
  isBowlerLinked(bowlerId: number): Promise<boolean>;
  getUserByBowlerId(bowlerId: number): Promise<User | undefined>;
  hasAdminUsers(): Promise<boolean>;
  countOrgAdmins(organizationId: number): Promise<number>;
  getOrgAdmins(organizationId: number): Promise<User[]>;
  setUserLocation(userId: number, locationId: number | null): Promise<User>;
  getUserByInviteToken(token: string): Promise<User | undefined>;
  setUserInviteToken(userId: number, token: string, expiry: Date): Promise<User>;
  clearUserInviteToken(userId: number): Promise<User>;
  // Task #357: change-password lockout
  recordFailedPasswordChangeAttempt(userId: number): Promise<{
    count: number;
    lockedUntil: string | null;
    justLocked: boolean;
  }>;
  resetFailedPasswordChangeAttempts(userId: number): Promise<void>;
}

export interface IOrganizationStorage {
  getOrganizations(): Promise<Organization[]>;
  getOrganization(id: number): Promise<Organization | undefined>;
  getOrganizationBySlug(slug: string): Promise<Organization | undefined>;
  getOrganizationBySubdomain(subdomain: string): Promise<Organization | undefined>;
  createOrganization(organization: InsertOrganization): Promise<Organization>;
  updateOrganization(id: number, organization: UpdateOrganization): Promise<Organization>;
  deleteOrganization(id: number): Promise<void>;
  archiveOrganization(id: number): Promise<Organization>;
  restoreOrganization(id: number): Promise<Organization>;
  getUserOrganizations(userId: number): Promise<Organization[]>;
  setUserOrganization(userId: number, organizationId: number | null): Promise<User>;
  getOrganizationUsers(organizationId: number): Promise<User[]>;
}

export interface ILocationStorage {
  getLocations(organizationId: number): Promise<Location[]>;
  getAllLocationsSystemAdmin(): Promise<Location[]>;
  getLocation(id: number): Promise<Location | undefined>;
  createLocation(data: InsertLocation): Promise<Location>;
  updateLocation(id: number, data: UpdateLocation): Promise<Location>;
  deleteLocation(id: number): Promise<void>;
  archiveLocation(id: number): Promise<Location>;
  restoreLocation(id: number): Promise<Location>;
  getLocationSquareConfig(locationId: number): Promise<LocationSquareCredentials | null>;
  updateLocationSquareConfig(locationId: number, creds: LocationSquareCredentials): Promise<Location>;
  getFirstSquareConfiguredLocation(orgId: number): Promise<Location | undefined>;
  getAllSquareConfiguredLocations(): Promise<Location[]>;
  getFirstPaymentConfiguredLocation(orgId: number): Promise<Location | undefined>;
}

export interface IEmailTemplateStorage {
  getEmailTemplates(): Promise<EmailTemplate[]>;
  getEmailTemplate(id: number): Promise<EmailTemplate | undefined>;
  getEmailTemplateBySlug(slug: string): Promise<EmailTemplate | undefined>;
  updateEmailTemplate(id: number, data: UpdateEmailTemplate): Promise<EmailTemplate>;
}

export interface IDeletionRequestStorage {
  createDeletionRequest(data: InsertDeletionRequest): Promise<DeletionRequest>;
  listDeletionRequests(filters?: { status?: DeletionRequestStatus }): Promise<DeletionRequest[]>;
  countDeletionRequests(filters?: { status?: DeletionRequestStatus }): Promise<number>;
  getDeletionRequest(id: number): Promise<DeletionRequest | undefined>;
  updateDeletionRequestStatus(
    id: number,
    status: Exclude<DeletionRequestStatus, "pending">,
    reviewedBy: number,
    adminNote?: string | null,
  ): Promise<DeletionRequest>;
  completeDeletionRequestWithExecution(
    id: number,
    reviewedBy: number,
    executionSummary: string,
    adminNote: string | null,
  ): Promise<DeletionRequest>;
  countDeletionRequestsForEmailSince(email: string, since: Date): Promise<number>;
}

export interface IEmailChangeRequestStorage {
  createEmailChangeRequest(data: InsertEmailChangeRequest): Promise<EmailChangeRequest>;
  getEmailChangeRequestByTokenHash(tokenHash: string): Promise<EmailChangeRequest | undefined>;
  consumeEmailChangeRequest(id: number): Promise<void>;
  claimEmailChangeRequest(tokenHash: string): Promise<EmailChangeRequest | undefined>;
  invalidatePendingEmailChangeRequestsForUser(userId: number): Promise<number>;
}

export interface IApplePayJobStorage {
  createApplePayJob(createdBy: number | null): Promise<ApplePayJob>;
  getApplePayJob(id: number): Promise<ApplePayJob | undefined>;
  listApplePayJobs(limit?: number): Promise<ApplePayJob[]>;
  countApplePayJobsNeedingAttention(): Promise<number>;
  getApplePayJobsRecoveredItemTotals(jobIds: number[]): Promise<Map<number, number>>;
  claimNextApplePayJob(opts?: { onlyJobIds?: number[] }): Promise<ApplePayJob | undefined>;
  recoverInterruptedApplePayJobs(opts?: { onlyJobIds?: number[] }): Promise<import("./apple-pay-jobs").ApplePayRecoveryResult>;
  countApplePayJobItems(jobId: number): Promise<number>;
  claimApplePayJobItemForProcessing(itemId: number): Promise<boolean>;
  claimAndCompleteApplePayJobItem(
    itemId: number,
    patch: { status: Exclude<ApplePayJobItemStatus, "pending" | "processing">; message?: string | null },
  ): Promise<boolean>;
  getApplePayJobItemCounts(jobId: number): Promise<{
    succeeded: number;
    failed: number;
    skipped: number;
    pending: number;
  }>;
  insertApplePayJobItems(
    jobId: number,
    items: Array<{
      organizationId: number | null;
      locationId: number | null;
      domain: string;
      status?: ApplePayJobItemStatus;
      message?: string | null;
    }>,
  ): Promise<void>;
  setApplePayJobTotal(jobId: number, total: number): Promise<void>;
  getPendingApplePayJobItems(jobId: number): Promise<ApplePayJobItem[]>;
  getApplePayJobItems(jobId: number): Promise<ApplePayJobItem[]>;
  getRegisteredApplePayDomainsForOrg(organizationId: number): Promise<string[]>;
  updateApplePayJobItem(
    itemId: number,
    patch: { status: ApplePayJobItemStatus; message?: string | null },
  ): Promise<void>;
  finalizeApplePayJob(
    jobId: number,
    patch: {
      status: ApplePayJobStatus;
      succeededCount: number;
      failedCount: number;
      skippedCount: number;
      errorMessage?: string | null;
    },
  ): Promise<void>;
  reopenApplePayJobForRetry(jobId: number): Promise<boolean>;
  getApplePayJobStatus(jobId: number): Promise<ApplePayJobStatus | undefined>;
  cancelApplePayJob(jobId: number): Promise<ApplePayJob | undefined>;
  deleteApplePayJob(jobId: number): Promise<boolean>;
  retryApplePayJob(jobId: number): Promise<{ job: ApplePayJob; resetCount: number } | undefined>;
  retryApplePayJobItem(
    jobId: number,
    itemId: number,
  ): Promise<{ item: ApplePayJobItem; job: ApplePayJob } | undefined>;
}

export interface IAlerterStateStorage {
  tryClaimAlerterSlot(
    kind: string,
    minIntervalMs: number,
  ): Promise<{ claimed: boolean; suppressedCount: number }>;
  recordAlerterSummary(
    kind: string,
    summary: import("@shared/schema").AlerterSummary,
  ): Promise<void>;
  getRecentAlerterEvent(
    kind: string,
    withinMs: number,
  ): Promise<
    | {
        lastSentAt: Date;
        summary: import("@shared/schema").AlerterSummary | null;
      }
    | null
  >;
  listRecentAlerterEventsByPrefix(
    prefix: string,
    withinMs: number,
  ): Promise<
    Array<{
      kind: string;
      lastSentAt: Date;
      summary: import("@shared/schema").AlerterSummary | null;
    }>
  >;
}

export interface IStorage extends
  ILeagueStorage,
  ITeamStorage,
  IBowlerStorage,
  IPaymentStorage,
  IPaymentOperationStorage,
  IAutopaySetupRequestStorage,
  IGameScoreStorage,
  IUserStorage,
  IOrganizationStorage,
  ILocationStorage,
  IEmailTemplateStorage,
  IDeletionRequestStorage,
  IEmailChangeRequestStorage,
  IFirstAdminBootstrapStorage,
  IApplePayJobStorage,
  IAlerterStateStorage {}
