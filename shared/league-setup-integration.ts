import { z } from "zod";
import type { FallDraftApplyResult } from "./fall-draft-generation";
import type { League } from "./schema/leagues";

export const LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION = "league-setup-integration-request/1";
export const LEAGUE_SETUP_INTEGRATION_RESULT_VERSION = "league-setup-integration-result/1";

export const leagueSetupIntegrationIntentSchema = z.object({
  contractVersion: z.literal(LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION),
  idempotencyKey: z.string().uuid(),
}).strict();

export type LeagueSetupIntegrationIntent = z.infer<typeof leagueSetupIntegrationIntentSchema>;

export interface LeagueSetupIntegrationResult extends League {
  setupIntegration: {
    resultContractVersion: typeof LEAGUE_SETUP_INTEGRATION_RESULT_VERSION;
    requestContractVersion: typeof LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION;
    mode: "created" | "idempotent_retry" | "not_applicable";
    writesPerformed: boolean;
  };
  canonicalDraftGeneration: FallDraftApplyResult | null;
}
