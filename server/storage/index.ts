import type { IStorage } from "./types";

import * as leagueStorage from "./leagues";
import * as teamStorage from "./teams";
import * as bowlerStorage from "./bowlers";
import * as paymentStorage from "./payments";
import * as paymentOperationStorage from "./payment-operations";
import * as autopaySetupRequestStorage from "./autopay-setup-requests";
import * as gameScoreStorage from "./games-scores";
import * as userStorage from "./users";
import * as orgStorage from "./organizations";
import * as locationStorage from "./locations";
import * as emailTemplateStorage from "./email-templates";
import * as deletionRequestStorage from "./deletion-requests";
import * as emailChangeRequestStorage from "./email-change-requests";
import * as applePayJobStorage from "./apple-pay-jobs";
import * as alerterStateStorage from "./alerter-state";

export type { IStorage };

export class DatabaseStorage implements IStorage {
  getLeagues!: IStorage["getLeagues"];
  getAllLeaguesSystemAdmin!: IStorage["getAllLeaguesSystemAdmin"];
  getLeague!: IStorage["getLeague"];
  getLeaguesByIds!: IStorage["getLeaguesByIds"];
  createLeague!: IStorage["createLeague"];
  updateLeague!: IStorage["updateLeague"];
  deleteLeague!: IStorage["deleteLeague"];
  archiveLeague!: IStorage["archiveLeague"];
  restoreLeague!: IStorage["restoreLeague"];

  getTeams!: IStorage["getTeams"];
  getTeam!: IStorage["getTeam"];
  getTeamsByIds!: IStorage["getTeamsByIds"];
  getTeamByNumber!: IStorage["getTeamByNumber"];
  createTeam!: IStorage["createTeam"];
  updateTeam!: IStorage["updateTeam"];
  deleteTeam!: IStorage["deleteTeam"];
  reorderTeams!: IStorage["reorderTeams"];
  renumberActiveTeams!: IStorage["renumberActiveTeams"];

  getBowlers!: IStorage["getBowlers"];
  getAllBowlersSystemAdmin!: IStorage["getAllBowlersSystemAdmin"];
  getBowler!: IStorage["getBowler"];
  getBowlersByIds!: IStorage["getBowlersByIds"];
  getBowlerByEmail!: IStorage["getBowlerByEmail"];
  getBowlerByEmailInOrg!: IStorage["getBowlerByEmailInOrg"];
  searchBowlersByName!: IStorage["searchBowlersByName"];
  getBowlerByEmailSystemAdmin!: IStorage["getBowlerByEmailSystemAdmin"];
  getBowlersByEmailSystemAdmin!: IStorage["getBowlersByEmailSystemAdmin"];
  createBowler!: IStorage["createBowler"];
  updateBowler!: IStorage["updateBowler"];
  deleteBowler!: IStorage["deleteBowler"];
  anonymizeBowler!: IStorage["anonymizeBowler"];
  getBowlerLeagues!: IStorage["getBowlerLeagues"];
  getBowlerLeague!: IStorage["getBowlerLeague"];
  isBowlerActiveInLeague!: IStorage["isBowlerActiveInLeague"];
  getBowlerLeaguesByBowlerIds!: IStorage["getBowlerLeaguesByBowlerIds"];
  createBowlerLeague!: IStorage["createBowlerLeague"];
  createBowlerLeagueIfBowlerFree!: IStorage["createBowlerLeagueIfBowlerFree"];
  createBowlerLeagueIfNotInLeague!: IStorage["createBowlerLeagueIfNotInLeague"];
  updateBowlerLeague!: IStorage["updateBowlerLeague"];
  updateBowlerLeagueOrder!: IStorage["updateBowlerLeagueOrder"];
  deleteBowlerLeague!: IStorage["deleteBowlerLeague"];

  getPayments!: IStorage["getPayments"];
  getAllPaymentsSystemAdmin!: IStorage["getAllPaymentsSystemAdmin"];
  getAllPaymentsPaginatedSystemAdmin!: IStorage["getAllPaymentsPaginatedSystemAdmin"];
  getPaymentsPaginated!: IStorage["getPaymentsPaginated"];
  getPaymentById!: IStorage["getPaymentById"];
  getPaymentByIdempotencyKey!: IStorage["getPaymentByIdempotencyKey"];
  getPaymentsByPaymentOperationId!: IStorage["getPaymentsByPaymentOperationId"];
  getPaymentByDisputeId!: IStorage["getPaymentByDisputeId"];
  getPaymentByProviderPaymentId!: IStorage["getPaymentByProviderPaymentId"];
  createPayment!: IStorage["createPayment"];
  createCombinedPayments!: IStorage["createCombinedPayments"];
  getPaymentsByCombinedGroupId!: IStorage["getPaymentsByCombinedGroupId"];
  updatePayment!: IStorage["updatePayment"];
  refundPayment!: IStorage["refundPayment"];
  openDispute!: IStorage["openDispute"];
  deletePayment!: IStorage["deletePayment"];
  createPaymentSchedule!: IStorage["createPaymentSchedule"];
  getPaymentSchedule!: IStorage["getPaymentSchedule"];
  getPaymentScheduleById!: IStorage["getPaymentScheduleById"];
  getActiveSchedulesByLeague!: IStorage["getActiveSchedulesByLeague"];
  getActiveSchedulesByLocationId!: IStorage["getActiveSchedulesByLocationId"];
  deactivatePaymentSchedule!: IStorage["deactivatePaymentSchedule"];
  updatePaymentScheduleFields!: IStorage["updatePaymentScheduleFields"];
  updatePaymentScheduleCard!: IStorage["updatePaymentScheduleCard"];

  createOrGetInteractivePaymentOperation!: IStorage["createOrGetInteractivePaymentOperation"];
  createOrGetGeneralInteractivePaymentOperation!: IStorage["createOrGetGeneralInteractivePaymentOperation"];
  createOrGetRefundPaymentOperation!: IStorage["createOrGetRefundPaymentOperation"];
  createOrGetScheduledPaymentOperation!: IStorage["createOrGetScheduledPaymentOperation"];
  persistScheduledPaymentOperationSnapshot!: IStorage["persistScheduledPaymentOperationSnapshot"];
  getScheduledPaymentOperationSnapshotForOrganization!: IStorage["getScheduledPaymentOperationSnapshotForOrganization"];
  persistInteractivePaymentOperationSnapshot!: IStorage["persistInteractivePaymentOperationSnapshot"];
  getInteractivePaymentOperationSnapshotForOrganization!: IStorage["getInteractivePaymentOperationSnapshotForOrganization"];
  persistRefundPaymentOperationSnapshot!: IStorage["persistRefundPaymentOperationSnapshot"];
  getRefundPaymentOperationSnapshotForOrganization!: IStorage["getRefundPaymentOperationSnapshotForOrganization"];
  getPaymentOperationForOrganization!: IStorage["getPaymentOperationForOrganization"];
  getGeneralInteractivePaymentOperationForOrganization!: IStorage["getGeneralInteractivePaymentOperationForOrganization"];
  getRefundPaymentOperationForOrganization!: IStorage["getRefundPaymentOperationForOrganization"];
  acquirePaymentOperationLease!: IStorage["acquirePaymentOperationLease"];
  schedulePaymentOperationRetry!: IStorage["schedulePaymentOperationRetry"];
  recordPaymentOperationProviderUnknown!: IStorage["recordPaymentOperationProviderUnknown"];
  recordPaymentOperationActionRequired!: IStorage["recordPaymentOperationActionRequired"];
  recordPaymentOperationFailedTerminal!: IStorage["recordPaymentOperationFailedTerminal"];
  finalizePaymentOperationSuccess!: IStorage["finalizePaymentOperationSuccess"];
  finalizeRefundPaymentOperationSuccess!: IStorage["finalizeRefundPaymentOperationSuccess"];
  reconcilePaymentOperationSuccess!: IStorage["reconcilePaymentOperationSuccess"];
  getNextPaymentOperationWake!: IStorage["getNextPaymentOperationWake"];
  recordExpiredPaymentOperationAttemptExhausted!: IStorage["recordExpiredPaymentOperationAttemptExhausted"];
  hasNonterminalScheduledPaymentOperation!: IStorage["hasNonterminalScheduledPaymentOperation"];
  cancelPaymentOperation!: IStorage["cancelPaymentOperation"];

  createOrGetAutopaySetupRequest!: IStorage["createOrGetAutopaySetupRequest"];
  getAutopaySetupRequestForOrganization!: IStorage["getAutopaySetupRequestForOrganization"];
  getAutopaySetupRequestByOperationForOrganization!: IStorage["getAutopaySetupRequestByOperationForOrganization"];
  completeAutopaySetupRequest!: IStorage["completeAutopaySetupRequest"];
  cancelAutopaySetupRequest!: IStorage["cancelAutopaySetupRequest"];

  getGames!: IStorage["getGames"];
  getGame!: IStorage["getGame"];
  createGame!: IStorage["createGame"];
  updateGame!: IStorage["updateGame"];
  deleteGame!: IStorage["deleteGame"];
  getScores!: IStorage["getScores"];
  getScore!: IStorage["getScore"];
  getScoresByGameIds!: IStorage["getScoresByGameIds"];
  getScoresByLeagueAndWeek!: IStorage["getScoresByLeagueAndWeek"];
  getBowlerScores!: IStorage["getBowlerScores"];
  createScore!: IStorage["createScore"];
  updateScore!: IStorage["updateScore"];
  deleteScore!: IStorage["deleteScore"];
  createBatchScores!: IStorage["createBatchScores"];
  getGameScores!: IStorage["getGameScores"];

  getUser!: IStorage["getUser"];
  getUserByEmail!: IStorage["getUserByEmail"];
  getUsers!: IStorage["getUsers"];
  createUser!: IStorage["createUser"];
  updateUser!: IStorage["updateUser"];
  updateUserRole!: IStorage["updateUserRole"];
  deleteUser!: IStorage["deleteUser"];
  linkUserToBowler!: IStorage["linkUserToBowler"];
  getLinkedBowlerIds!: IStorage["getLinkedBowlerIds"];
  isBowlerLinked!: IStorage["isBowlerLinked"];
  getUserByBowlerId!: IStorage["getUserByBowlerId"];
  hasAdminUsers!: IStorage["hasAdminUsers"];
  countOrgAdmins!: IStorage["countOrgAdmins"];
  getOrgAdmins!: IStorage["getOrgAdmins"];
  setUserLocation!: IStorage["setUserLocation"];
  getUserByInviteToken!: IStorage["getUserByInviteToken"];
  setUserInviteToken!: IStorage["setUserInviteToken"];
  clearUserInviteToken!: IStorage["clearUserInviteToken"];
  recordFailedPasswordChangeAttempt!: IStorage["recordFailedPasswordChangeAttempt"];
  resetFailedPasswordChangeAttempts!: IStorage["resetFailedPasswordChangeAttempts"];

  getOrganizations!: IStorage["getOrganizations"];
  getOrganization!: IStorage["getOrganization"];
  getOrganizationBySlug!: IStorage["getOrganizationBySlug"];
  getOrganizationBySubdomain!: IStorage["getOrganizationBySubdomain"];
  createOrganization!: IStorage["createOrganization"];
  updateOrganization!: IStorage["updateOrganization"];
  deleteOrganization!: IStorage["deleteOrganization"];
  archiveOrganization!: IStorage["archiveOrganization"];
  restoreOrganization!: IStorage["restoreOrganization"];
  getUserOrganizations!: IStorage["getUserOrganizations"];
  setUserOrganization!: IStorage["setUserOrganization"];
  getOrganizationUsers!: IStorage["getOrganizationUsers"];
  getLocations!: IStorage["getLocations"];
  getAllLocationsSystemAdmin!: IStorage["getAllLocationsSystemAdmin"];
  getLocation!: IStorage["getLocation"];
  createLocation!: IStorage["createLocation"];
  updateLocation!: IStorage["updateLocation"];
  deleteLocation!: IStorage["deleteLocation"];
  archiveLocation!: IStorage["archiveLocation"];
  restoreLocation!: IStorage["restoreLocation"];
  getLocationSquareConfig!: IStorage["getLocationSquareConfig"];
  updateLocationSquareConfig!: IStorage["updateLocationSquareConfig"];
  getFirstSquareConfiguredLocation!: IStorage["getFirstSquareConfiguredLocation"];
  getAllSquareConfiguredLocations!: IStorage["getAllSquareConfiguredLocations"];
  getFirstPaymentConfiguredLocation!: IStorage["getFirstPaymentConfiguredLocation"];

  getEmailTemplates!: IStorage["getEmailTemplates"];
  getEmailTemplate!: IStorage["getEmailTemplate"];
  getEmailTemplateBySlug!: IStorage["getEmailTemplateBySlug"];
  updateEmailTemplate!: IStorage["updateEmailTemplate"];

  createDeletionRequest!: IStorage["createDeletionRequest"];
  listDeletionRequests!: IStorage["listDeletionRequests"];
  countDeletionRequests!: IStorage["countDeletionRequests"];
  getDeletionRequest!: IStorage["getDeletionRequest"];
  updateDeletionRequestStatus!: IStorage["updateDeletionRequestStatus"];
  completeDeletionRequestWithExecution!: IStorage["completeDeletionRequestWithExecution"];
  countDeletionRequestsForEmailSince!: IStorage["countDeletionRequestsForEmailSince"];

  createEmailChangeRequest!: IStorage["createEmailChangeRequest"];
  getEmailChangeRequestByTokenHash!: IStorage["getEmailChangeRequestByTokenHash"];
  consumeEmailChangeRequest!: IStorage["consumeEmailChangeRequest"];
  claimEmailChangeRequest!: IStorage["claimEmailChangeRequest"];
  invalidatePendingEmailChangeRequestsForUser!: IStorage["invalidatePendingEmailChangeRequestsForUser"];

  bootstrapFirstAdmin!: IStorage["bootstrapFirstAdmin"];
  promoteFirstAdmin!: IStorage["promoteFirstAdmin"];

  createApplePayJob!: IStorage["createApplePayJob"];
  getApplePayJob!: IStorage["getApplePayJob"];
  listApplePayJobs!: IStorage["listApplePayJobs"];
  countApplePayJobsNeedingAttention!: IStorage["countApplePayJobsNeedingAttention"];
  getApplePayJobsRecoveredItemTotals!: IStorage["getApplePayJobsRecoveredItemTotals"];
  claimNextApplePayJob!: IStorage["claimNextApplePayJob"];
  recoverInterruptedApplePayJobs!: IStorage["recoverInterruptedApplePayJobs"];
  countApplePayJobItems!: IStorage["countApplePayJobItems"];
  claimApplePayJobItemForProcessing!: IStorage["claimApplePayJobItemForProcessing"];
  claimAndCompleteApplePayJobItem!: IStorage["claimAndCompleteApplePayJobItem"];
  getApplePayJobItemCounts!: IStorage["getApplePayJobItemCounts"];
  insertApplePayJobItems!: IStorage["insertApplePayJobItems"];
  setApplePayJobTotal!: IStorage["setApplePayJobTotal"];
  getPendingApplePayJobItems!: IStorage["getPendingApplePayJobItems"];
  getApplePayJobItems!: IStorage["getApplePayJobItems"];
  getRegisteredApplePayDomainsForOrg!: IStorage["getRegisteredApplePayDomainsForOrg"];
  updateApplePayJobItem!: IStorage["updateApplePayJobItem"];
  finalizeApplePayJob!: IStorage["finalizeApplePayJob"];
  reopenApplePayJobForRetry!: IStorage["reopenApplePayJobForRetry"];
  getApplePayJobStatus!: IStorage["getApplePayJobStatus"];
  cancelApplePayJob!: IStorage["cancelApplePayJob"];
  deleteApplePayJob!: IStorage["deleteApplePayJob"];
  retryApplePayJob!: IStorage["retryApplePayJob"];
  retryApplePayJobItem!: IStorage["retryApplePayJobItem"];

  tryClaimAlerterSlot!: IStorage["tryClaimAlerterSlot"];
  recordAlerterSummary!: IStorage["recordAlerterSummary"];
  getRecentAlerterEvent!: IStorage["getRecentAlerterEvent"];
  listRecentAlerterEventsByPrefix!: IStorage["listRecentAlerterEventsByPrefix"];

  constructor() {
    Object.assign(this, {
      ...leagueStorage,
      ...teamStorage,
      ...bowlerStorage,
      getBowlerLeagues: bowlerStorage.getBowlerLeaguesFiltered,
      ...paymentStorage,
      ...paymentOperationStorage,
      ...autopaySetupRequestStorage,
      ...gameScoreStorage,
      ...userStorage,
      ...orgStorage,
      ...locationStorage,
      ...emailTemplateStorage,
      ...deletionRequestStorage,
      ...emailChangeRequestStorage,
      ...applePayJobStorage,
      ...alerterStateStorage,
    });
  }
}

export const storage = new DatabaseStorage();
