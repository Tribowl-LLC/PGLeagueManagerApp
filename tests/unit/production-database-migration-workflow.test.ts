import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  resolve('.github/workflows/production-database-migration.yml'),
  'utf8',
);
const repairWorkflow = readFileSync(
  resolve('.github/workflows/production-schema-repair-0049.yml'),
  'utf8',
);
const repairRehearsalWorkflow = readFileSync(
  resolve('.github/workflows/production-schema-repair-rehearsal.yml'),
  'utf8',
);
const incidentCleanupWorkflow = readFileSync(
  resolve('.github/workflows/production-schema-rehearsal-cleanup-35838463508.yml'),
  'utf8',
);
const repairScript = readFileSync(resolve('scripts/repair-production-show-db-tree.ts'), 'utf8');
const rehearsalCatalogCheck = readFileSync(
  resolve('scripts/check-rehearsal-catalog-security.ts'),
  'utf8',
);

describe('production database migration workflow', () => {
  it('keeps migration dispatch manual and validates the protected production target', () => {
    expect(workflow).toMatch(/^on:\n {2}workflow_dispatch:/m);
    expect(workflow).not.toMatch(/^ {2}(push|pull_request|schedule):/m);
    expect(workflow).toContain(
      '.default == true and .protected == true',
    );
  });

  it('creates and verifies an unprotected pre-migration recovery branch', () => {
    expect(workflow).toContain('--no-compute');
    expect(workflow).toContain('--no-secrets');
    expect(workflow).toContain('--no-protected');
    expect(workflow).toContain('.parent_id == $parent and .protected == false');
    expect(workflow).not.toMatch(/^\s+--protected(?:\s|\\)/m);
  });

  it('keeps the one-time 0049 repair manual, incident-confirmed, certified-main-only, and production-approved', () => {
    expect(repairWorkflow).toMatch(/^on:\n {2}workflow_dispatch:/m);
    expect(repairWorkflow).not.toMatch(/^ {2}(push|pull_request|schedule):/m);
    expect(repairWorkflow).toContain('environment: production');
    expect(repairWorkflow).toContain('REPAIR_LEAGUEVAULT_0049_SHOW_DB_TREE_35824851019');
    expect(repairWorkflow).toContain('exact-main-certification.yml');
    expect(repairWorkflow).toContain('test "$(git rev-parse origin/main)" = "$EXPECTED_SHA"');
    expect(repairWorkflow).toContain('group: production-database-migration');
  });

  it('creates a verified no-compute recovery branch before acquiring the connection or running repair', () => {
    const backupStep = repairWorkflow.indexOf('- name: Create and verify no-compute recovery backup');
    const connectionStep = repairWorkflow.indexOf('- name: Acquire and mask the direct TLS database URL');
    const repairStep = repairWorkflow.indexOf('- name: Run the single-purpose 0049 repair transaction');
    expect(backupStep).toBeGreaterThan(-1);
    expect(connectionStep).toBeGreaterThan(backupStep);
    expect(repairStep).toBeGreaterThan(connectionStep);
    expect(repairWorkflow).toContain('--no-compute');
    expect(repairWorkflow).toContain('--no-secrets');
    expect(repairWorkflow).toContain('length == 0');
    expect(repairWorkflow).toContain('echo "::add-mask::$database_url"');
    expect(repairWorkflow).toContain('--ssl verify-full');
    expect(repairWorkflow).toContain(
      'DB_PRODUCTION_SCHEMA_REPAIR_EXPECTED_HOST_FINGERPRINT: ${{ steps.target.outputs.host_fingerprint }}',
    );
    expect(repairScript).toContain('assertExpectedConnectionUrlTarget(connectionString, expectedTarget)');
    expect(repairWorkflow.match(/steps\.connection\.outputs\.database_url/g)).toHaveLength(1);
  });

  it('keeps Neon API credentials out of the repair script process and retains the recovery backup', () => {
    const repairStepStart = repairWorkflow.indexOf('- name: Run the single-purpose 0049 repair transaction');
    const summaryStepStart = repairWorkflow.indexOf('- name: Record repair evidence');
    const repairStep = repairWorkflow.slice(repairStepStart, summaryStepStart);
    expect(repairStep).not.toContain('NEON_API_KEY');
    expect(repairWorkflow.match(/NEON_API_KEY: \$\{\{ secrets\.NEON_API_KEY \}\}/g)).toHaveLength(3);
    expect(repairWorkflow).toContain('retain through normal migration and release verification');
    expect(repairWorkflow).not.toContain('neon branches delete');
    expect(repairWorkflow).not.toContain('npm run db:migrate');
    expect(repairScript).not.toContain('NEON_API_KEY=');
  });

  it('reports journal state only after repair succeeds and marks failures unconfirmed', () => {
    expect(repairWorkflow).toContain(
      'if [ "$REPAIR_OUTCOME" = success ]; then\n              echo \'- Production migration journal: repair script confirmed unchanged at 0049; 0050 remains pending\'\n            else\n              echo \'- Production migration journal and 0050 pending status: unconfirmed because the repair step failed\'\n            fi',
    );
    expect(repairWorkflow).not.toContain(
      "echo '- Production migration journal: unchanged; 0050 remains pending'",
    );
  });

  it('requires a matching successful rehearsal run ID before Neon target, backup, or connection steps', () => {
    expect(repairWorkflow).toContain('rehearsal_run_id:');
    expect(repairWorkflow).toContain('REHEARSAL_RUN_ID: ${{ inputs.rehearsal_run_id }}');
    expect(repairWorkflow).toContain("grep -Eq '^[0-9]+$'");
    expect(repairWorkflow).toContain(
      'actions/workflows?per_page=100',
    );
    expect(repairWorkflow).toContain(
      '.path == ".github/workflows/production-schema-repair-rehearsal.yml"',
    );
    expect(repairWorkflow).toContain('actions/runs/$REHEARSAL_RUN_ID');
    expect(repairWorkflow).toContain('.workflow_id == $workflow_id');
    expect(repairWorkflow).toContain('.conclusion == "success"');
    expect(repairWorkflow).toContain('.head_sha == $expected_sha');
    expect(repairWorkflow).toContain('.head_branch == "main"');
    expect(repairWorkflow).toContain('.event == "workflow_dispatch"');
    expect(repairWorkflow).toContain('Required rehearsal run ID:');
    expect(repairWorkflow).toContain(
      'printf -- \'- Required rehearsal run ID: `%s` (`%s`)\\n\' \\\n              "$REHEARSAL_RUN_ID" "$REHEARSAL_OUTCOME"',
    );
    expect(repairWorkflow).not.toContain(
      'echo "- Required rehearsal run ID: \\`$REHEARSAL_RUN_ID\\` (`$REHEARSAL_OUTCOME`)"',
    );

    const rehearsalCheck = repairWorkflow.indexOf(
      '- name: Verify the successful rehearsal run for this exact SHA',
    );
    const targetCheck = repairWorkflow.indexOf('- name: Verify pinned Neon production target');
    const backup = repairWorkflow.indexOf('- name: Create and verify no-compute recovery backup');
    const connection = repairWorkflow.indexOf('- name: Acquire and mask the direct TLS database URL');
    expect(rehearsalCheck).toBeGreaterThan(-1);
    expect(targetCheck).toBeGreaterThan(rehearsalCheck);
    expect(backup).toBeGreaterThan(targetCheck);
    expect(connection).toBeGreaterThan(backup);
  });

  it('requires a certified protected clone-only repair rehearsal before production repair', () => {
    expect(repairRehearsalWorkflow).toMatch(/^on:\n {2}workflow_dispatch:/m);
    expect(repairRehearsalWorkflow).not.toMatch(/^ {2}(push|pull_request|schedule):/m);
    expect(repairRehearsalWorkflow).toContain('environment: production');
    expect(repairRehearsalWorkflow).toContain('REHEARSE_LEAGUEVAULT_0049_SHOW_DB_TREE_35824851019');
    expect(repairRehearsalWorkflow).toContain('exact-main-certification.yml');
    expect(repairRehearsalWorkflow).toContain('test "$EXPECTED_SHA" = "$GITHUB_SHA"');
    expect(repairRehearsalWorkflow).toContain('git ls-remote origin refs/heads/main');
    expect(repairRehearsalWorkflow).toContain('NEON_RECOVERY_BRANCH_ID: br-sweet-base-aqm07odq');
    expect(repairRehearsalWorkflow).toContain('--parent "$NEON_RECOVERY_BRANCH_ID"');
    expect(repairRehearsalWorkflow).toContain('Run the same guarded 0049 repair against the disposable child');
    expect(repairRehearsalWorkflow).toContain('EXPECTED_MIGRATION: 0050_rotating_team_payments');
    expect(repairRehearsalWorkflow).toContain('DB_MIGRATION_EXPECTED_PENDING: none');
    expect(repairRehearsalWorkflow).toContain('if: ${{ always() }}');
    expect(repairRehearsalWorkflow).toContain('[ "$branch_id" = "$NEON_RECOVERY_BRANCH_ID" ]');
    expect(repairRehearsalWorkflow).toContain('[ "$branch_id" = "$NEON_PRODUCTION_BRANCH_ID" ]');
    expect(repairRehearsalWorkflow).toContain('Verified cleanup of disposable branch');
    expect(repairRehearsalWorkflow).toContain('No production database connection or mutation ran.');
    expect(repairRehearsalWorkflow).not.toContain('neon connection-string "$NEON_PRODUCTION_BRANCH_ID"');

    const cleanupStepStart = repairRehearsalWorkflow.indexOf(
      '- name: Remove only the disposable child endpoint and branch',
    );
    const cleanupSummaryStart = repairRehearsalWorkflow.indexOf(
      '- name: Record rehearsal and cleanup disposition',
    );
    const cleanupStep = repairRehearsalWorkflow.slice(cleanupStepStart, cleanupSummaryStart);
    expect(cleanupStep).toContain('api_request GET "/projects/$NEON_PROJECT_ID/branches/$branch_id"');
    expect(cleanupStep).toContain('api_request GET "/projects/$NEON_PROJECT_ID/endpoints/$endpoint_id"');
    expect(cleanupStep).toContain('api_request DELETE "/projects/$NEON_PROJECT_ID/endpoints/$endpoint_id"');
    expect(cleanupStep).toContain('api_request DELETE "/projects/$NEON_PROJECT_ID/branches/$branch_id"');
    expect(cleanupStep).toContain('--connect-timeout 5 --max-time 15');
    expect(cleanupStep).toContain('.project_id == $project');
    expect(cleanupStep).toContain('.parent_id == $parent');
    expect(cleanupStep).toContain('The child creation request was sent, but its ID is unresolved');
    expect(cleanupStep).toContain('No child creation request or resource ID was recorded; no cleanup was needed.');
    expect(cleanupStep).toContain('The recorded child name does not match this run');
    expect(cleanupStep).toContain('api_status" != 404');
    expect(cleanupStep).not.toContain('branches list');
    expect(cleanupStep).not.toContain('rm -rf');
    expect(cleanupStep).toContain('rm -f -- "$auth_file" "$response_file"');
    expect(cleanupStep.indexOf('api_request DELETE "/projects/$NEON_PROJECT_ID/endpoints/$endpoint_id"')).toBeLessThan(
      cleanupStep.indexOf('api_request DELETE "/projects/$NEON_PROJECT_ID/branches/$branch_id"'),
    );

    const repairStep = repairRehearsalWorkflow.indexOf(
      '- name: Run the same guarded 0049 repair against the disposable child',
    );
    const migrationStep = repairRehearsalWorkflow.indexOf('- name: Apply exactly migration 0050 to the disposable child');
    const verifyStep = repairRehearsalWorkflow.indexOf('- name: Verify no migrations remain pending on the disposable child');
    const cleanupStepPosition = cleanupStepStart;
    expect(repairStep).toBeGreaterThan(-1);
    expect(migrationStep).toBeGreaterThan(repairStep);
    expect(verifyStep).toBeGreaterThan(migrationStep);
    expect(cleanupStepPosition).toBeGreaterThan(verifyStep);
  });

  it('limits retained-run cleanup to exact IDs after a read-only catalog guard', () => {
    expect(incidentCleanupWorkflow).toMatch(/^on:\n {2}workflow_dispatch:/m);
    expect(incidentCleanupWorkflow).not.toMatch(/^ {2}(push|pull_request|schedule):/m);
    expect(incidentCleanupWorkflow).toContain('environment: production');
    expect(incidentCleanupWorkflow).toContain('CLEANUP_SCHEMA_REPAIR_REHEARSAL_35838463508');
    expect(incidentCleanupWorkflow).toContain('test "$EXPECTED_SHA" = "$GITHUB_SHA"');
    expect(incidentCleanupWorkflow).toContain('exact-main-certification.yml');
    expect(incidentCleanupWorkflow).toContain('INCIDENT_REHEARSAL_RUN_ID: 35838463508');
    expect(incidentCleanupWorkflow).toContain('INCIDENT_CERTIFIED_SHA: 4872871868f235b077b87af86e759c16fb5a04f8');
    expect(incidentCleanupWorkflow).toContain('TARGET_BRANCH_ID: br-floral-brook-aq6y24el');
    expect(incidentCleanupWorkflow).toContain('TARGET_BRANCH_NAME: schema-repair-rehearsal-35838463508-1');
    expect(incidentCleanupWorkflow).toContain('TARGET_ENDPOINT_ID: ep-long-union-aqus2pg5');
    expect(incidentCleanupWorkflow).toContain('NEON_RECOVERY_BRANCH_ID: br-sweet-base-aqm07odq');
    expect(incidentCleanupWorkflow).toContain('NEON_PRODUCTION_BRANCH_ID: br-late-glitter-aqm4u4fc');
    expect(incidentCleanupWorkflow).toContain('NEON_PROJECT_ID: dark-firefly-25282046');
    expect(incidentCleanupWorkflow).toContain('Verify retained child catalog evidence in a read-only transaction');
    expect(incidentCleanupWorkflow).toContain('if: ${{ steps.catalog.outcome == \'success\' }}');
    expect(incidentCleanupWorkflow).toContain('./node_modules/.bin/tsx scripts/check-rehearsal-catalog-security.ts');
    expect(incidentCleanupWorkflow).toContain('api_request GET "/projects/$NEON_PROJECT_ID/branches/$TARGET_BRANCH_ID"');
    expect(incidentCleanupWorkflow).toContain('api_request GET "/projects/$NEON_PROJECT_ID/endpoints/$TARGET_ENDPOINT_ID"');
    expect(incidentCleanupWorkflow).toContain('api_request DELETE "/projects/$NEON_PROJECT_ID/endpoints/$TARGET_ENDPOINT_ID"');
    expect(incidentCleanupWorkflow).toContain('api_request DELETE "/projects/$NEON_PROJECT_ID/branches/$TARGET_BRANCH_ID"');
    expect(incidentCleanupWorkflow.match(/--connect-timeout 5 --max-time 15/g)).toHaveLength(2);
    expect(incidentCleanupWorkflow).toContain('test "$api_status" = 404');
    expect(incidentCleanupWorkflow).not.toContain('branches list');
    expect(incidentCleanupWorkflow).not.toContain('rm -rf');
    expect(incidentCleanupWorkflow).toContain('rm -f -- "$auth_file" "$response_file"');
    expect(incidentCleanupWorkflow.indexOf('api_request DELETE "/projects/$NEON_PROJECT_ID/endpoints/$TARGET_ENDPOINT_ID"')).toBeLessThan(
      incidentCleanupWorkflow.indexOf('api_request DELETE "/projects/$NEON_PROJECT_ID/branches/$TARGET_BRANCH_ID"'),
    );

    const catalogStepStart = incidentCleanupWorkflow.indexOf(
      '- name: Verify retained child catalog evidence in a read-only transaction',
    );
    const deleteStepStart = incidentCleanupWorkflow.indexOf(
      '- name: Remove only the verified incident endpoint and branch',
    );
    expect(catalogStepStart).toBeGreaterThan(-1);
    expect(deleteStepStart).toBeGreaterThan(catalogStepStart);
    expect(incidentCleanupWorkflow).not.toContain('neon connection-string "$NEON_PRODUCTION_BRANCH_ID"');

    expect(rehearsalCatalogCheck).toContain('process.env.NEON_API_KEY !== undefined');
    expect(rehearsalCatalogCheck).toContain('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(rehearsalCatalogCheck).toContain('assertExpectedConnectionUrlTarget(connectionString, expectedTarget)');
    expect(rehearsalCatalogCheck).toContain('assertShowDbTreeCatalogSecurityState(actual)');
    expect(rehearsalCatalogCheck).toContain('pg_catalog.pg_get_functiondef(procedure.oid)');
    expect(rehearsalCatalogCheck).toContain('target_function.proacl IS NOT NULL');
    expect(rehearsalCatalogCheck).toContain('pg_catalog.aclexplode');
    expect(rehearsalCatalogCheck).toContain('pg_catalog.pg_depend');
    expect(rehearsalCatalogCheck).toContain('[catalog-precheck] fail field=${field}');
    expect(rehearsalCatalogCheck).not.toContain('console.log');
    expect(rehearsalCatalogCheck).not.toContain('process.stdout.write(row.definition');
  });

  it('uses one serializable repair transaction with RESTRICT and unchanged journal verification', () => {
    expect(repairScript).toContain('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    expect(repairScript).toContain('pg_advisory_lock');
    expect(repairScript).toContain('LOCK TABLE');
    expect(repairScript).toContain('IN ACCESS SHARE MODE');
    expect(repairScript).toContain('assertJournalPrefix');
    expect(repairScript).toContain('DROP FUNCTION public.show_db_tree() RESTRICT');
    expect(repairScript).toContain('verifyApprovedSchemaStateOnClient');
    expect(repairScript).toContain('assertJournalUnchanged');
    expect(repairScript).not.toMatch(/DROP\s+FUNCTION[^;]*CASCADE/i);
    expect(repairScript).not.toContain('INSERT INTO drizzle.__drizzle_migrations');
  });
});
