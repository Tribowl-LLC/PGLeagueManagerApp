import { z } from "zod";
import type { FallDraftApplyResult } from "./fall-draft-generation";
import type { FutureSeasonDraftGenerationResult } from "./future-season-draft-generation";
import type { League } from "./schema/leagues";
import type { CanonicalCollectionGroupEvidence } from "./canonical-collection-groups";

export const LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION = "league-setup-integration-request/1";
export const LEAGUE_SETUP_INTEGRATION_RESULT_VERSION = "league-setup-integration-result/1";
export const LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION_2 = "league-setup-integration-request/2";
export const LEAGUE_SETUP_INTEGRATION_RESULT_VERSION_2 = "league-setup-integration-result/2";
export const LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION_3 = "league-setup-integration-request/3";
export const LEAGUE_SETUP_INTEGRATION_RESULT_VERSION_3 = "league-setup-integration-result/3";
export const LEAGUE_ROLLOVER_SOURCE_CONTRACT_VERSION = "league-rollover-source/1";
export const LEAGUE_ROLLOVER_SOURCE_FINGERPRINT_VERSION = "league-rollover-source-fingerprint/1";

export const leagueSetupIntegrationIntentSchema = z.object({
  contractVersion: z.literal(LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION),
  idempotencyKey: z.string().uuid(),
}).strict();

export type LeagueSetupIntegrationIntent = z.infer<typeof leagueSetupIntegrationIntentSchema>;

export const leagueSetupIntegrationIntentV2Schema = z.object({
  contractVersion: z.literal(LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION_2),
  idempotencyKey: z.string().uuid(),
}).strict();

export type LeagueSetupIntegrationIntentV2 = z.infer<typeof leagueSetupIntegrationIntentV2Schema>;
export const leagueSetupIntegrationIntentV3Schema = z.object({
  contractVersion: z.literal(LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION_3),
  idempotencyKey: z.string().uuid(),
}).strict();

export type LeagueSetupIntegrationIntentV3 = z.infer<typeof leagueSetupIntegrationIntentV3Schema>;
export type AnyLeagueSetupIntegrationIntent = LeagueSetupIntegrationIntent | LeagueSetupIntegrationIntentV2 | LeagueSetupIntegrationIntentV3;

export const leagueRolloverSourceConfirmationSchema = z.object({
  contractVersion: z.literal(LEAGUE_ROLLOVER_SOURCE_CONTRACT_VERSION),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  confirmed: z.literal(true),
}).strict();

export type LeagueRolloverSourceConfirmation = z.infer<typeof leagueRolloverSourceConfirmationSchema>;

export interface LeagueRolloverCarriedConfiguration {
  name: string;
  description: string | null;
  locationId: number;
  timezone: string;
  practiceStartTime: string | null;
  competitionStartTime: string;
  weeklyFee: number;
  lineageFee: number | null;
  prizeFundFee: number | null;
}

export interface LeagueRolloverSourceContract {
  contractVersion: typeof LEAGUE_ROLLOVER_SOURCE_CONTRACT_VERSION;
  fingerprintVersion: typeof LEAGUE_ROLLOVER_SOURCE_FINGERPRINT_VERSION;
  fingerprint: string;
  organizationId: number;
  sourceLeagueId: number;
  carriedConfiguration: LeagueRolloverCarriedConfiguration;
}

export interface LeagueSetupIntegrationResult extends League {
  setupIntegration: {
    resultContractVersion: typeof LEAGUE_SETUP_INTEGRATION_RESULT_VERSION;
    requestContractVersion: typeof LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION;
    mode: "created" | "idempotent_retry" | "not_applicable";
    writesPerformed: boolean;
  };
  canonicalDraftGeneration: FallDraftApplyResult | FutureSeasonDraftGenerationResult | null;
}

export interface LeagueSetupIntegrationResultV2 extends League {
  setupIntegration: {
    resultContractVersion: typeof LEAGUE_SETUP_INTEGRATION_RESULT_VERSION_2;
    requestContractVersion: typeof LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION_2;
    mode: "created" | "idempotent_retry";
    writesPerformed: boolean;
  };
  canonicalDraftGeneration: FutureSeasonDraftGenerationResult;
}

export interface LeagueSetupIntegrationResultV3 extends League {
  setupIntegration: {
    resultContractVersion: typeof LEAGUE_SETUP_INTEGRATION_RESULT_VERSION_3;
    requestContractVersion: typeof LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION_3;
    mode: "created" | "idempotent_retry";
    writesPerformed: boolean;
    reviewAvailable: false;
  };
  canonicalDraftGeneration: FutureSeasonDraftGenerationResult;
  canonicalSchedule: {
    state: "published";
    approvalCommandId: string;
    publicationCommandId: string;
    collectionGroups: CanonicalCollectionGroupEvidence[];
  };
}

export type AnyLeagueSetupIntegrationResult = LeagueSetupIntegrationResult | LeagueSetupIntegrationResultV2 | LeagueSetupIntegrationResultV3;
