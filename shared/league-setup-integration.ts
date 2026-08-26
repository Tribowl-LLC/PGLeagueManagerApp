import { z } from "zod";
import type { FutureSeasonDraftGenerationResult } from "./future-season-draft-generation";
import type { League } from "./schema/leagues";
import type { CanonicalCollectionGroupEvidence } from "./canonical-collection-groups";

/** Current setup is always one atomic canonical create/rollover operation. */
export const LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION = "league-setup-integration-request/3" as const;
export const LEAGUE_SETUP_INTEGRATION_RESULT_VERSION = "league-setup-integration-result/3" as const;
export const LEAGUE_ROLLOVER_SOURCE_CONTRACT_VERSION = "league-rollover-source/1" as const;
export const LEAGUE_ROLLOVER_SOURCE_FINGERPRINT_VERSION = "league-rollover-source-fingerprint/1" as const;

export const leagueSetupIntegrationIntentSchema = z.object({
  contractVersion: z.literal(LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION),
  idempotencyKey: z.string().uuid(),
}).strict();

export type LeagueSetupIntegrationIntent = z.infer<typeof leagueSetupIntegrationIntentSchema>;

export const leagueRolloverSourceConfirmationSchema = z.object({
  contractVersion: z.literal(LEAGUE_ROLLOVER_SOURCE_CONTRACT_VERSION),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  confirmed: z.literal(true),
}).strict();

export type LeagueRolloverSourceConfirmation = z.infer<typeof leagueRolloverSourceConfirmationSchema>;

export interface LeagueRolloverCarriedConfiguration {
  name: string;
  description: string | null;
  payingLineupSize: 3 | 4;
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
    mode: "created" | "idempotent_retry";
    writesPerformed: boolean;
  };
  canonicalGeneration: FutureSeasonDraftGenerationResult;
  canonicalSchedule: {
    state: "published";
    approvalCommandId: string;
    publicationCommandId: string;
    collectionGroups: CanonicalCollectionGroupEvidence[];
  };
}
