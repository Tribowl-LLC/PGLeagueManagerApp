import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { describe, it } from "vitest";
import {
  parseArguments,
  parseProtectedBackupWorkflowEvidence,
  requireRuntimeGuards,
} from "../../scripts/owned-payment-ledger-adoption.js";

const sha = "a".repeat(40);
const sourceFingerprint = `lvweeklyadoptpre:v1:${"b".repeat(64)}`;
const resultFingerprint = `lvweeklyadopt:v1:${"c".repeat(64)}`;
const directHost = "ep-cli-adoption-123456.c-8.us-east-1.aws.neon.tech";
const poolerHost = "ep-cli-adoption-123456-pooler.c-8.us-east-1.aws.neon.tech";
const directHostWithoutComputeProxy = "ep-cli-adoption-123456.us-east-1.aws.neon.tech";
const expectedMigrations = "0052_weekly_admin_payments_ledger,0053_owned_payment_refund_support,0054_weekly_standing_account_funding,0055_owned_account_refunds_v3";
const verification = "checked migration completed and immediate rerun reported no pending migrations";

function runtimeEnvironment(host: string): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: `postgresql://neondb_owner:cli-test-only@${host}/neondb?sslmode=require`,
    RENDER_GIT_COMMIT: sha,
    FIELD_ENCRYPTION_KEY: "d".repeat(64),
  };
}

function parsePreflightArguments(host = directHost) {
  const args = parseArguments([
    "preflight",
    "--expected-db-host", host,
    "--expected-db-name", "neondb",
    "--expected-render-git-commit", sha,
    "--organization-id", "1",
    "--league-id", "2",
    "--actor-user-id", "3",
    "--evidence-file", "/tmp/owned-adoption-test.json",
  ]);
  assert.ok(args);
  return args;
}

function backupEvidence(hostFingerprint: string, overrides: Record<string, unknown> = {}) {
  return {
    workflow_path: ".github/workflows/production-database-migration.yml",
    workflow_run_url: "https://github.com/Tribowl-LLC/PGLeagueManagerApp/actions/runs/123456/attempts/2",
    run_id: 123456,
    run_attempt: 2,
    run_conclusion: "success",
    expected_sha: sha,
    expected_pending_migrations: expectedMigrations,
    backup_outcome: "success",
    migration_outcome: "success",
    verification,
    neon_project_id: "dark-firefly-25282046",
    neon_production_branch_id: "br-late-glitter-aqm4u4fc",
    neon_production_branch_name: "production",
    neon_database_name: "neondb",
    neon_role_name: "neondb_owner",
    host_fingerprint: hostFingerprint,
    backup_id: "br-cli-adoption-backup-123456",
    backup_name: `backup-pre-migration-${sha.slice(0, 12)}-123456-2`,
    backup_parent_id: "br-late-glitter-aqm4u4fc",
    backup_protected: false,
    ...overrides,
  };
}

describe("owned payment adoption CLI", () => {
  it("maps only the exact Neon pooler suffix to the workflow's direct host fingerprint", () => {
    const direct = requireRuntimeGuards(parsePreflightArguments(directHost), runtimeEnvironment(directHost));
    const pooler = requireRuntimeGuards(parsePreflightArguments(poolerHost), runtimeEnvironment(poolerHost));

    assert.equal(direct.directDatabaseHost, directHost);
    assert.equal(pooler.directDatabaseHost, directHost);
    assert.equal(pooler.hostFingerprint, direct.hostFingerprint);
    assert.equal(
      requireRuntimeGuards(
        parsePreflightArguments(directHostWithoutComputeProxy),
        runtimeEnvironment(directHostWithoutComputeProxy),
      ).directDatabaseHost,
      directHostWithoutComputeProxy,
    );
    assert.throws(() => requireRuntimeGuards(
      parsePreflightArguments("ep-cli-adoption-123456-pooler.other.example"),
      runtimeEnvironment("ep-cli-adoption-123456-pooler.other.example"),
    ));
    const arbitraryExtraLabel = "ep-cli-adoption-123456.extra.c-8.us-east-1.aws.neon.tech";
    assert.throws(() => requireRuntimeGuards(
      parsePreflightArguments(arbitraryExtraLabel),
      runtimeEnvironment(arbitraryExtraLabel),
    ));
  });

  it("accepts the actual ordered migration input and requires the workflow's no-pending verification", () => {
    const target = requireRuntimeGuards(parsePreflightArguments(directHost), runtimeEnvironment(directHost));
    const accepted = parseProtectedBackupWorkflowEvidence(backupEvidence(target.hostFingerprint), target, sha);
    assert.equal(accepted.expected_pending_migrations, expectedMigrations);
    assert.equal(accepted.verification, verification);

    const verifiedNoOp = parseProtectedBackupWorkflowEvidence(
      backupEvidence(target.hostFingerprint, { expected_pending_migrations: "none" }),
      target,
      sha,
    );
    assert.equal(verifiedNoOp.expected_pending_migrations, "none");
    assert.throws(() => parseProtectedBackupWorkflowEvidence(
      backupEvidence(target.hostFingerprint, { verification: "" }), target, sha,
    ));
    assert.throws(() => parseProtectedBackupWorkflowEvidence(
      backupEvidence(target.hostFingerprint, { expected_pending_migrations: `${expectedMigrations},0056_unreviewed` }), target, sha,
    ));
  });

  it("rejects URL credentials, another repository, query/hash data, and run or attempt mismatches", () => {
    const target = requireRuntimeGuards(parsePreflightArguments(directHost), runtimeEnvironment(directHost));
    const invalidUrls = [
      "https://reviewer:token@github.com/Tribowl-LLC/PGLeagueManagerApp/actions/runs/123456/attempts/2",
      "https://github.com/Tribowl-LLC/OtherRepo/actions/runs/123456/attempts/2",
      "https://github.com/Tribowl-LLC/PGLeagueManagerApp/actions/runs/123456/attempts/2?view=logs",
      "https://github.com/Tribowl-LLC/PGLeagueManagerApp/actions/runs/123456/attempts/2#summary",
      "https://github.com/Tribowl-LLC/PGLeagueManagerApp/actions/runs/123457/attempts/2",
      "https://github.com/Tribowl-LLC/PGLeagueManagerApp/actions/runs/123456/attempts/1",
    ];
    for (const workflow_run_url of invalidUrls) {
      assert.throws(() => parseProtectedBackupWorkflowEvidence(
        backupEvidence(target.hostFingerprint, { workflow_run_url }),
        target,
        sha,
      ));
    }
  });

  it("rejects malformed apply fingerprints before runtime setup", () => {
    assert.throws(() => parseArguments([
      "apply",
      "--expected-db-host", directHost,
      "--expected-db-name", "neondb",
      "--expected-render-git-commit", sha,
      "--organization-id", "1",
      "--league-id", "2",
      "--actor-user-id", "3",
      "--expected-source-fingerprint", "source",
      "--expected-result-fingerprint", resultFingerprint,
      "--backup-proof-file", "/tmp/proof.json",
    ]));
  });

  it("keeps built-artifact help and invalid-proof refusals free of secrets", async () => {
    const buildDirectory = resolve(".local/agent-tasks/payments_ci_contracts");
    await mkdir(buildDirectory, { recursive: true });
    const artifactDirectory = await mkdtemp(join(buildDirectory, "owned-payment-adoption-cli-"));
    const artifact = join(artifactDirectory, "owned-payment-ledger-adoption.js");
    try {
      await build({
        entryPoints: [resolve("scripts/owned-payment-ledger-adoption.ts")],
        bundle: true,
        packages: "external",
        platform: "node",
        format: "esm",
        outfile: artifact,
        logLevel: "silent",
      });

      const help = spawnSync(process.execPath, [artifact, "--help"], { encoding: "utf8" });
      assert.equal(help.status, 0);
      assert.match(help.stdout, /preflight/);
      assert.doesNotMatch(help.stdout + help.stderr, /DATABASE_URL=.*@|FIELD_ENCRYPTION_KEY=/);

      const directory = await mkdtemp(join(tmpdir(), "owned-payment-adoption-cli-"));
      const proofPath = join(directory, "proof.json");
      const fakeSecret = "CLI_TEST_SECRET_MUST_NOT_ESCAPE";
      await writeFile(proofPath, JSON.stringify({ unexpected: fakeSecret }), { mode: 0o600 });
      try {
        const environment = {
          ...process.env,
          ...runtimeEnvironment(directHost),
        };
        const refused = spawnSync(process.execPath, [
          artifact,
          "apply",
          "--expected-db-host", directHost,
          "--expected-db-name", "neondb",
          "--expected-render-git-commit", sha,
          "--organization-id", "1",
          "--league-id", "2",
          "--actor-user-id", "3",
          "--expected-source-fingerprint", sourceFingerprint,
          "--expected-result-fingerprint", resultFingerprint,
          "--backup-proof-file", proofPath,
        ], { encoding: "utf8", env: environment });
        const output = `${refused.stdout}${refused.stderr}`;
        assert.equal(refused.status, 1);
        assert.match(refused.stderr, /refused \(PREFLIGHT_OR_APPLY_REFUSED\)/);
        assert.doesNotMatch(output, new RegExp(fakeSecret));
        assert.doesNotMatch(output, /SQLSTATE|select\s|insert\s|database_url|password/i);
        assert.equal(refused.stdout, "");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }

      const invalidTarget = spawnSync(process.execPath, [
        artifact,
        "preflight",
        "--expected-db-host", directHost,
        "--expected-db-name", "neondb",
        "--expected-render-git-commit", sha,
        "--organization-id", "1",
        "--league-id", "2",
        "--actor-user-id", "3",
        "--evidence-file", "/tmp/unused-owned-adoption-evidence.json",
      ], {
        encoding: "utf8",
        env: { ...process.env, ...runtimeEnvironment(poolerHost) },
      });
      assert.equal(invalidTarget.status, 1);
      assert.match(invalidTarget.stderr, /refused \(PREFLIGHT_OR_APPLY_REFUSED\)/);
      assert.doesNotMatch(`${invalidTarget.stdout}${invalidTarget.stderr}`, /cli-test-only|FIELD_ENCRYPTION_KEY|DATABASE_URL/);
      assert.equal(invalidTarget.stdout, "");
    } finally {
      await rm(artifactDirectory, { recursive: true, force: true });
    }
  });
});
