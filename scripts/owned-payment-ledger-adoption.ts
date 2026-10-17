import { createHash } from "node:crypto";
import { readFile, writeFile, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { OwnedPaymentAdoptionPreflight } from "../server/services/owned-payment-ledger-adoption.js";

type Mode = "preflight" | "apply";
const orderedAdoptionMigrations = "0052_weekly_admin_payments_ledger,0053_owned_payment_refund_support,0054_weekly_standing_account_funding,0055_owned_account_refunds_v3";
type ExpectedPendingMigrations = typeof orderedAdoptionMigrations | "none";

interface CliArguments {
  mode: Mode;
  organizationId: number;
  leagueId: number;
  actorUserId: number;
  expectedDatabaseHost: string;
  expectedDatabaseName: string;
  expectedRenderCommit: string;
  evidenceFile?: string;
  backupProofFile?: string;
  expectedSourceFingerprint?: string;
  expectedResultFingerprint?: string;
}

export interface ProtectedBackupWorkflowEvidence {
  workflow_path: ".github/workflows/production-database-migration.yml";
  workflow_run_url: string;
  run_id: number;
  run_attempt: number;
  run_conclusion: "success";
  expected_sha: string;
  expected_pending_migrations: ExpectedPendingMigrations;
  backup_outcome: "success";
  migration_outcome: "success";
  verification: "checked migration completed and immediate rerun reported no pending migrations";
  neon_project_id: "dark-firefly-25282046";
  neon_production_branch_id: "br-late-glitter-aqm4u4fc";
  neon_production_branch_name: "production";
  neon_database_name: "neondb";
  neon_role_name: "neondb_owner";
  host_fingerprint: string;
  backup_id: string;
  backup_name: string;
  backup_parent_id: "br-late-glitter-aqm4u4fc";
  backup_protected: false;
}

const usage = `Usage:
  node dist/owned-payment-ledger-adoption.js preflight \\
    --expected-db-host HOST --expected-db-name NAME --expected-render-git-commit SHA \\
    --organization-id ID --league-id ID --actor-user-id ID --evidence-file PATH
  node dist/owned-payment-ledger-adoption.js apply \\
    --expected-db-host HOST --expected-db-name NAME --expected-render-git-commit SHA \\
    --organization-id ID --league-id ID --actor-user-id ID \\
    --expected-source-fingerprint FINGERPRINT --expected-result-fingerprint FINGERPRINT \\
    --backup-proof-file PATH

The CLI reads DATABASE_URL, FIELD_ENCRYPTION_KEY, and RENDER_GIT_COMMIT from the
protected runtime environment. Preflight is read-only. Apply requires a local
reviewed transcription of a successful protected production database migration
run and its verified unprotected Neon recovery branch. The transcription is not
independent cryptographic proof.`;

const noPendingMigrationSummary = "checked migration completed and immediate rerun reported no pending migrations";

const flagNames = new Set([
  "--expected-db-host",
  "--expected-db-name",
  "--expected-render-git-commit",
  "--organization-id",
  "--league-id",
  "--actor-user-id",
  "--evidence-file",
  "--backup-proof-file",
  "--expected-source-fingerprint",
  "--expected-result-fingerprint",
]);

function parsePositiveInteger(value: string | undefined, label: string): number {
  if (!value || !/^[1-9][0-9]*$/.test(value)) throw new Error(`invalid ${label}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 2_147_483_647) throw new Error(`invalid ${label}`);
  return parsed;
}

export function parseArguments(argv: readonly string[]): CliArguments | null {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return null;
  const mode = argv[0];
  if (mode !== "preflight" && mode !== "apply") throw new Error("mode must be preflight or apply");
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !flagNames.has(flag) || !value || value.startsWith("--") || values.has(flag)) {
      throw new Error("invalid or duplicate command-line option");
    }
    values.set(flag, value);
  }
  const expectedDatabaseHost = values.get("--expected-db-host")?.trim();
  const expectedDatabaseName = values.get("--expected-db-name")?.trim();
  const expectedRenderCommit = values.get("--expected-render-git-commit")?.trim().toLowerCase();
  if (!expectedDatabaseHost || !expectedDatabaseName || !expectedRenderCommit
    || !/^[0-9a-f]{40}$/.test(expectedRenderCommit)) throw new Error("required target guard is missing or invalid");
  const common = {
    mode,
    organizationId: parsePositiveInteger(values.get("--organization-id"), "organization ID"),
    leagueId: parsePositiveInteger(values.get("--league-id"), "league ID"),
    actorUserId: parsePositiveInteger(values.get("--actor-user-id"), "actor user ID"),
    expectedDatabaseHost,
    expectedDatabaseName,
    expectedRenderCommit,
  } as const;
  if (mode === "preflight") {
    const evidenceFile = values.get("--evidence-file")?.trim();
    if (!evidenceFile || values.has("--backup-proof-file") || values.has("--expected-source-fingerprint")
      || values.has("--expected-result-fingerprint")) throw new Error("preflight requires only its local evidence-file option");
    return { ...common, mode, evidenceFile };
  }
  const backupProofFile = values.get("--backup-proof-file")?.trim();
  const expectedSourceFingerprint = values.get("--expected-source-fingerprint")?.trim();
  const expectedResultFingerprint = values.get("--expected-result-fingerprint")?.trim();
  if (!backupProofFile || !expectedSourceFingerprint || !expectedResultFingerprint || values.has("--evidence-file")) {
    throw new Error("apply requires the reviewed backup proof and both preflight fingerprints");
  }
  if (!/^lvweeklyadoptpre:v1:[0-9a-f]{64}$/.test(expectedSourceFingerprint)
    || !/^lvweeklyadopt:v1:[0-9a-f]{64}$/.test(expectedResultFingerprint)) {
    throw new Error("invalid preflight fingerprint");
  }
  return { ...common, mode, backupProofFile, expectedSourceFingerprint, expectedResultFingerprint };
}

export function requireRuntimeGuards(args: CliArguments, environment: NodeJS.ProcessEnv): {
  databaseHost: string;
  directDatabaseHost: string;
  databaseName: string;
  hostFingerprint: string;
} {
  const connectionString = environment.DATABASE_URL?.trim();
  const actualCommit = environment.RENDER_GIT_COMMIT?.trim().toLowerCase();
  const fieldEncryptionKey = environment.FIELD_ENCRYPTION_KEY?.trim();
  if (!connectionString || !actualCommit || !fieldEncryptionKey || !/^[0-9a-f]{64}$/i.test(fieldEncryptionKey)) {
    throw new Error("required protected runtime configuration is missing");
  }
  if (!/^[0-9a-f]{40}$/.test(actualCommit) || actualCommit !== args.expectedRenderCommit) {
    throw new Error("running application commit does not match the reviewed target");
  }
  let target: URL;
  try {
    target = new URL(connectionString);
  } catch {
    throw new Error("runtime database target cannot be parsed");
  }
  const databaseHost = target.hostname.toLowerCase();
  if (!/^postgres(ql)?:$/.test(target.protocol) || (target.port && target.port !== "5432")) {
    throw new Error("runtime database endpoint does not match the protected production target");
  }
  let databaseName = "";
  try {
    databaseName = decodeURIComponent(target.pathname.replace(/^\//, ""));
  } catch {
    throw new Error("runtime database target cannot be parsed");
  }
  if (!databaseHost || !databaseName || databaseHost !== args.expectedDatabaseHost.toLowerCase()
    || databaseName !== args.expectedDatabaseName) {
    throw new Error("runtime database target does not match the reviewed target");
  }
  let databaseRole = "";
  try {
    databaseRole = decodeURIComponent(target.username);
  } catch {
    throw new Error("runtime database target cannot be parsed");
  }
  const labels = databaseHost.split(".");
  const endpointLabel = labels[0] ?? "";
  const isPoolerEndpoint = endpointLabel.endsWith("-pooler");
  const directEndpointLabel = isPoolerEndpoint ? endpointLabel.slice(0, -"-pooler".length) : endpointLabel;
  if (!/^ep-[a-z0-9][a-z0-9-]*$/.test(directEndpointLabel)
    || !/^(?:c-[0-9]+\.)?[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+\.aws\.neon\.tech$/.test(labels.slice(1).join("."))
    || databaseRole !== "neondb_owner") {
    throw new Error("runtime database endpoint does not match the protected Neon production target");
  }
  if (isPoolerEndpoint) labels[0] = directEndpointLabel;
  const directDatabaseHost = labels.join(".");
  const hostFingerprint = `sha256:${createHash("sha256").update(`${directDatabaseHost}:5432`, "utf8").digest("hex")}`;
  return { databaseHost, directDatabaseHost, databaseName, hostFingerprint };
}

export function parseProtectedBackupWorkflowEvidence(
  value: unknown,
  target: { databaseHost: string; directDatabaseHost: string; databaseName: string; hostFingerprint: string },
  expectedCommit: string,
): ProtectedBackupWorkflowEvidence {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid protected backup workflow evidence");
  const candidate = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "workflow_path", "run_id", "run_attempt", "run_conclusion", "expected_sha", "expected_pending_migrations",
    "workflow_run_url",
    "backup_outcome", "migration_outcome", "verification", "neon_project_id", "neon_production_branch_id",
    "neon_production_branch_name", "neon_database_name", "neon_role_name", "host_fingerprint",
    "backup_id", "backup_name", "backup_parent_id", "backup_protected",
  ]);
  if (Object.keys(candidate).some((key) => !allowedKeys.has(key))
    || candidate.workflow_path !== ".github/workflows/production-database-migration.yml"
    || typeof candidate.workflow_run_url !== "string"
    || !Number.isSafeInteger(candidate.run_id) || Number(candidate.run_id) <= 0
    || !Number.isSafeInteger(candidate.run_attempt) || Number(candidate.run_attempt) <= 0
    || candidate.run_conclusion !== "success"
    || candidate.expected_sha !== expectedCommit
    || (candidate.expected_pending_migrations !== orderedAdoptionMigrations
      && candidate.expected_pending_migrations !== "none")
    || candidate.backup_outcome !== "success"
    || candidate.migration_outcome !== "success"
    || candidate.verification !== noPendingMigrationSummary
    || candidate.neon_project_id !== "dark-firefly-25282046"
    || candidate.neon_production_branch_id !== "br-late-glitter-aqm4u4fc"
    || candidate.neon_production_branch_name !== "production"
    || candidate.neon_database_name !== "neondb"
    || candidate.neon_role_name !== "neondb_owner"
    || candidate.host_fingerprint !== target.hostFingerprint
    || typeof candidate.backup_id !== "string"
    || !/^br-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate.backup_id)
    || typeof candidate.backup_name !== "string"
    || candidate.backup_name !== `backup-pre-migration-${expectedCommit.slice(0, 12)}-${candidate.run_id}-${candidate.run_attempt}`
    || candidate.backup_parent_id !== "br-late-glitter-aqm4u4fc"
    || candidate.backup_protected !== false
    || target.databaseName !== "neondb") throw new Error("protected backup workflow evidence does not match the target or required release record");
  let runUrl: URL;
  try {
    runUrl = new URL(candidate.workflow_run_url);
  } catch {
    throw new Error("protected workflow run URL is invalid");
  }
  const runPath = `/Tribowl-LLC/PGLeagueManagerApp/actions/runs/${candidate.run_id}`;
  if (runUrl.origin !== "https://github.com" || runUrl.href !== candidate.workflow_run_url
    || runUrl.username || runUrl.password || runUrl.search || runUrl.hash
    || (runUrl.pathname !== runPath && runUrl.pathname !== `${runPath}/attempts/${candidate.run_attempt}`)
    || (runUrl.pathname.includes("/attempts/") && candidate.run_attempt === 1
      && runUrl.pathname !== `${runPath}/attempts/1`)) {
    throw new Error("protected workflow run URL does not match its run ID and attempt");
  }
  return {
    workflow_path: ".github/workflows/production-database-migration.yml",
    workflow_run_url: candidate.workflow_run_url,
    run_id: Number(candidate.run_id),
    run_attempt: Number(candidate.run_attempt),
    run_conclusion: "success",
    expected_sha: expectedCommit,
    expected_pending_migrations: candidate.expected_pending_migrations,
    backup_outcome: "success",
    migration_outcome: "success",
    verification: noPendingMigrationSummary,
    neon_project_id: "dark-firefly-25282046",
    neon_production_branch_id: "br-late-glitter-aqm4u4fc",
    neon_production_branch_name: "production",
    neon_database_name: "neondb",
    neon_role_name: "neondb_owner",
    host_fingerprint: target.hostFingerprint,
    backup_id: candidate.backup_id,
    backup_name: candidate.backup_name,
    backup_parent_id: "br-late-glitter-aqm4u4fc",
    backup_protected: false,
  };
}

function summarizePlan(plan: OwnedPaymentAdoptionPreflight) {
  return {
    organizationId: plan.organizationId,
    leagueId: plan.leagueId,
    timezone: plan.timezone,
    localToday: plan.localToday,
    adoptedThroughLocalDate: plan.adoptedThroughLocalDate,
    ready: plan.ready,
    sourceFingerprint: plan.sourceFingerprint,
    resultFingerprint: plan.resultFingerprint,
    counts: plan.counts,
    blockers: plan.blockers.map(({ code, count }) => ({ code, count })),
  };
}

async function writePreflightEvidence(
  path: string,
  args: CliArguments,
  target: { databaseHost: string; directDatabaseHost: string; databaseName: string; hostFingerprint: string },
  plan: OwnedPaymentAdoptionPreflight,
): Promise<string> {
  const artifact = {
    version: 1,
    mode: "owned-payment-ledger-adoption-preflight",
    generatedAt: new Date().toISOString(),
    target,
    runtimeCommit: args.expectedRenderCommit,
    actorUserId: args.actorUserId,
    plan,
  };
  const contents = `${JSON.stringify(artifact, null, 2)}\n`;
  const artifactPath = resolve(path);
  await writeFile(artifactPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(artifactPath, 0o600);
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

export async function runOwnedPaymentLedgerAdoptionCli(argv: readonly string[], environment: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(`${usage}\n`);
    return 0;
  }
  const args = parseArguments(argv);
  if (!args) return 0;
  const target = requireRuntimeGuards(args, environment);
  let backupEvidence: ProtectedBackupWorkflowEvidence | undefined;
  let backupEvidenceSha256: string | undefined;
  if (args.mode === "apply") {
    const backupBytes = await readFile(args.backupProofFile ?? "");
    backupEvidence = parseProtectedBackupWorkflowEvidence(
      JSON.parse(backupBytes.toString("utf8")) as unknown,
      target,
      args.expectedRenderCommit,
    );
    backupEvidenceSha256 = createHash("sha256").update(backupBytes).digest("hex");
  }
  const [{ db, cleanup }, adoption] = await Promise.all([
    import("../server/db.js"),
    import("../server/services/owned-payment-ledger-adoption.js"),
  ]);
  try {
    if (args.mode === "preflight") {
      const plan = await adoption.preflightOwnedPaymentLedgerAdoption({
        organizationId: args.organizationId,
        leagueId: args.leagueId,
      }, db);
      const evidenceArtifactSha256 = await writePreflightEvidence(args.evidenceFile ?? "", args, target, plan);
      process.stdout.write(`${JSON.stringify({
        mode: "preflight",
        target,
        runtimeCommit: args.expectedRenderCommit,
        actorUserId: args.actorUserId,
        evidenceArtifactSha256,
        ...summarizePlan(plan),
      }, null, 2)}\n`);
      return plan.ready ? 0 : 2;
    }
    if (!backupEvidence || !backupEvidenceSha256) throw new Error("protected backup workflow evidence is missing");
    const result = await adoption.applyOwnedPaymentLedgerAdoption({
      organizationId: args.organizationId,
      leagueId: args.leagueId,
      actorUserId: args.actorUserId,
      expectedSourceFingerprint: args.expectedSourceFingerprint ?? "",
      expectedResultFingerprint: args.expectedResultFingerprint ?? "",
    }, db);
    process.stdout.write(`${JSON.stringify({
      mode: "apply",
      target,
      runtimeCommit: args.expectedRenderCommit,
      actorUserId: args.actorUserId,
      backupEvidenceSha256,
      backupWorkflowRunId: backupEvidence.run_id,
      backupWorkflowRunAttempt: backupEvidence.run_attempt,
      backupName: backupEvidence.backup_name,
      adoption: result,
    }, null, 2)}\n`);
    return 0;
  } finally {
    await cleanup();
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  runOwnedPaymentLedgerAdoptionCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error: unknown) => {
    const rawCode = error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "PREFLIGHT_OR_APPLY_REFUSED";
    const code = /^[A-Z0-9_]{1,48}$/.test(rawCode) ? rawCode : "PREFLIGHT_OR_APPLY_REFUSED";
    process.stderr.write(`[owned-payment-ledger-adoption] refused (${code}); see the protected local workflow record for details.\n`);
    process.exitCode = 1;
  });
}
