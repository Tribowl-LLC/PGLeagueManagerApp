import { pathToFileURL } from 'node:url';
import {
  parseAdoptionEnvironment,
  preflightProductionDatabaseBaseline,
} from './lib/db-baseline-adoption';
import { redactConnectionDetails } from './lib/db-schema-inventory';
import { redactNeonControlPlaneDetails } from './lib/neon-rehearsal-verifier';

export async function preflightConfiguredProductionBaseline(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const connectionString = environment.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for db:adopt-baseline:preflight.');
  }
  const request = parseAdoptionEnvironment(environment, 'preflight');
  if (request.environmentClass !== 'neon-production') {
    throw new Error('Production preflight requires DB_ADOPTION_ENVIRONMENT_CLASS=neon-production.');
  }
  const result = await preflightProductionDatabaseBaseline(
    connectionString,
    request,
    {},
    environment.NEON_API_KEY?.trim(),
  );
  process.stdout.write(`${JSON.stringify({
    recommendation: 'READY FOR FINAL PRODUCTION ADOPTION AUTHORIZATION',
    ...result,
    intendedJournalRegistration: {
      sql: 'INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)',
      parameters: [result.baselineHash, result.baselineCreatedAt],
      executesBaselineSql: false,
      altersSchema: false,
      touchesApplicationData: false,
      changesRls: false,
      runsLaterMigrations: false,
    },
    mutationsPerformed: false,
  }, null, 2)}\n`);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  preflightConfiguredProductionBaseline().catch((error: unknown) => {
    let message = error instanceof Error ? error.message : String(error);
    const approvalToken = process.env.DB_ADOPTION_APPROVAL_TOKEN;
    if (approvalToken) message = message.replaceAll(approvalToken, '[approval token redacted]');
    const neonExpectation = {
      apiKey: process.env.NEON_API_KEY,
      projectId: process.env.DB_ADOPTION_NEON_EXPECTED_PROJECT_ID,
      targetBranchId: process.env.DB_ADOPTION_NEON_EXPECTED_TARGET_BRANCH_ID,
      productionBranchId: process.env.DB_ADOPTION_NEON_EXPECTED_PRODUCTION_BRANCH_ID,
      endpointId: process.env.DB_ADOPTION_NEON_EXPECTED_ENDPOINT_ID,
    };
    process.stderr.write(
      `[db:adopt-baseline:preflight] failed: ${redactNeonControlPlaneDetails(
        redactConnectionDetails(message, process.env.DATABASE_URL),
        neonExpectation,
      )}\n`,
    );
    process.exitCode = 1;
  });
}
