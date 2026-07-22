/**
 * Cheap guard around `build-test-template.ts` (Task #699 / Phase 1,
 * extended for Neon-branches mode in Task #723).
 *
 * Decides whether to rebuild the test template:
 *
 *   1. If the schema-input hash differs from `.local/test-template-hash`,
 *      rebuild (covers schema/seed/invariants drift).
 *
 *   2. On a hash match, resolve the actual local template database or
 *      pre-existing Neon template branch and require its exact active
 *      migration journal. Missing or conflicting state is refused; this
 *      guard never applies migrations as a repair fallback.
 */
import { existsSync, readFileSync } from 'node:fs';
import { assertSafeDatabaseHost } from '../server/utils/db-safety';
import {
  assertMigratedTemplateReady,
  buildTestTemplate,
  computeTemplateHash,
  templateDatabaseUrl,
} from './build-test-template';
import {
  findBranchByName,
  getNeonConfig,
  resolveBranchUrl,
  TEMPLATE_BRANCH_NAME,
} from '../tests/setup/neon-branches';

const HASH_FILE = '.local/test-template-hash';

export async function ensureTestTemplate(): Promise<void> {
  const expected = computeTemplateHash();
  let actual: string | null = null;
  if (existsSync(HASH_FILE)) {
    actual = readFileSync(HASH_FILE, 'utf8').trim();
  }

  if (actual !== expected) {
    console.log('[ensure-test-template] hash drift detected; rebuilding template…');
    await buildTestTemplate();
    return;
  }

  // A matching local hash is only a cache hint. The template itself must still
  // contain the exact checked-in migration journal. This is deliberately a
  // read-only assertion: an absent or stale journal fails rather than being
  // silently repaired before behavioral tests.
  //
  // Host-allow-list rail (Task #723 review): refuse to talk to the
  // Neon control plane unless the connected DB host is on the dev
  // allow-list. `cleanupTestDbs` and `cloneTemplate` apply the same
  // guard; this fast path was previously bypassing it. Memoised once
  // per process inside `assertSafeDatabaseHost`.
  assertSafeDatabaseHost('ensure-test-template');
  const cfg = getNeonConfig();
  let templateUrl: string;
  if (cfg) {
    const branch = await findBranchByName(cfg, TEMPLATE_BRANCH_NAME);
    if (!branch) {
      throw new Error(
        `Cached Neon test-template branch "${TEMPLATE_BRANCH_NAME}" is missing; ` +
          'automatic Neon template construction is disabled because a branch is not an empty migration target.',
      );
    }
    templateUrl = await resolveBranchUrl(cfg, branch.id);
  } else {
    templateUrl = templateDatabaseUrl();
  }

  await assertMigratedTemplateReady(templateUrl);
  console.log(
    '[test-template-provenance] source=db:migrate cache=hit journal=exact current-invariants=exact rebuild=skipped',
  );
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  ensureTestTemplate().catch((err) => {
    console.error('[ensure-test-template] failed:', err);
    process.exit(1);
  });
}
