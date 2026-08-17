import type { CanonicalNormalizedInput } from "./canonical-occurrence-generator";
import type { FallDraftDurableIds } from "./fall-draft-generation";
import type { PaymentMode } from "./schema/constants";
import type { ProductSeason } from "./season-utils";

export const FUTURE_SEASON_DRAFT_RESULT_VERSION = "future-season-draft-generation-result/1";
export const FUTURE_SEASON_DRAFT_IMPLEMENTATION_VERSION = "future-season-draft-generation/1";
export const FUTURE_SEASON_DRAFT_MAPPING_VERSION = "canonical-draft-mapping/1";
export const FUTURE_SEASON_DRAFT_INPUT_SNAPSHOT_VERSION = "future-season-draft-generation-input-snapshot/1";

export interface FutureSeasonDraftInputSnapshot {
  snapshotContractVersion: typeof FUTURE_SEASON_DRAFT_INPUT_SNAPSHOT_VERSION;
  setupRequestContractVersion: "league-setup-integration-request/2";
  setupConfirmationFingerprint: string;
  candidateSetFingerprint: string;
  seasonClassification: ProductSeason;
  paymentMode: PaymentMode;
  normalizedInput: CanonicalNormalizedInput;
}

export interface FutureSeasonDraftGenerationResult {
  resultContractVersion: typeof FUTURE_SEASON_DRAFT_RESULT_VERSION;
  implementationVersion: typeof FUTURE_SEASON_DRAFT_IMPLEMENTATION_VERSION;
  mappingVersion: typeof FUTURE_SEASON_DRAFT_MAPPING_VERSION;
  mode: "applied" | "idempotent_retry";
  organizationId: number;
  leagueId: number;
  seasonClassification: ProductSeason;
  setupConfirmationFingerprint: string;
  requestFingerprint: string;
  inputFingerprint: string;
  physicalScheduleFingerprint: string;
  candidateSetFingerprint: string;
  sourceScheduleRevision: number;
  durableIds: FallDraftDurableIds;
  counts: {
    commands: number;
    occurrences: number;
    scheduledOccurrences: number;
    cancelledOccurrences: number;
    billingTerms: number;
    exceptions: number;
    discrepancies: number;
  };
  writesPerformed: boolean;
  legacyWritesPerformed: false;
  relationshipsCreated: false;
  paymentObligationOrCollectionRowsCreated: false;
  currentLegacyScheduleMatchesGenerationInput: boolean;
}

export function isFutureSeasonDraftInputSnapshot(value: unknown): value is FutureSeasonDraftInputSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Partial<FutureSeasonDraftInputSnapshot>;
  return snapshot.snapshotContractVersion === FUTURE_SEASON_DRAFT_INPUT_SNAPSHOT_VERSION
    && snapshot.setupRequestContractVersion === "league-setup-integration-request/2"
    && typeof snapshot.setupConfirmationFingerprint === "string"
    && /^[0-9a-f]{64}$/.test(snapshot.setupConfirmationFingerprint)
    && typeof snapshot.candidateSetFingerprint === "string"
    && /^[0-9a-f]{64}$/.test(snapshot.candidateSetFingerprint)
    && (snapshot.seasonClassification === "Winter" || snapshot.seasonClassification === "Spring"
      || snapshot.seasonClassification === "Summer" || snapshot.seasonClassification === "Fall")
    && (snapshot.paymentMode === "weekly" || snapshot.paymentMode === "upfront")
    && !!snapshot.normalizedInput && typeof snapshot.normalizedInput === "object"
    && snapshot.normalizedInput.ambiguousFold === "reject"
    && snapshot.normalizedInput.currency === "USD"
    && snapshot.normalizedInput.regularSessionBillingPolicy === "eligible_bowlers"
    && snapshot.normalizedInput.billingOrdinalPolicy === "dense_billable";
}
