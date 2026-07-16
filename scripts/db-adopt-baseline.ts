import { pathToFileURL } from 'node:url';
import {
  adoptExistingDatabaseBaseline,
  parseAdoptionEnvironment,
} from './lib/db-baseline-adoption';
import { redactConnectionDetails } from './lib/db-schema-inventory';
import { redactNeonControlPlaneDetails } from './lib/neon-rehearsal-verifier';

export async function adoptConfiguredDatabaseBaseline(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const connectionString = environment.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required for db:adopt-baseline.');
  const request = parseAdoptionEnvironment(environment);
  const neonApiKey = request.environmentClass === 'neon-rehearsal'
    ? environment.NEON_API_KEY?.trim()
    : undefined;
  const result = await adoptExistingDatabaseBaseline(connectionString, request, {}, neonApiKey);
  const verifiedState = `verified state=${result.verificationState}`;
  process.stdout.write(
    result.status === 'adopted'
      ? `[db:adopt-baseline] registered ${result.baselineTag}; ${verifiedState}; baseline DDL was not executed\n`
      : `[db:adopt-baseline] ${result.baselineTag} already registered exactly; ${verifiedState}; no-op\n`,
  );
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  adoptConfiguredDatabaseBaseline().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const neonExpectation = {
      apiKey: process.env.NEON_API_KEY,
      projectId: process.env.DB_ADOPTION_NEON_EXPECTED_PROJECT_ID,
      targetBranchId: process.env.DB_ADOPTION_NEON_EXPECTED_TARGET_BRANCH_ID,
      productionBranchId: process.env.DB_ADOPTION_NEON_EXPECTED_PRODUCTION_BRANCH_ID,
      endpointId: process.env.DB_ADOPTION_NEON_EXPECTED_ENDPOINT_ID,
    };
    process.stderr.write(
      `[db:adopt-baseline] failed: ${redactNeonControlPlaneDetails(
        redactConnectionDetails(message, process.env.DATABASE_URL),
        neonExpectation,
      )}\n`,
    );
    process.exitCode = 1;
  });
}
