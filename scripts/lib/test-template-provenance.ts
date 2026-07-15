import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export interface TemplateHashInput {
  root: string;
  kind: 'file' | 'directory';
  recursive?: boolean;
  pattern?: RegExp;
}

export const TEMPLATE_HASH_INPUTS: readonly TemplateHashInput[] = [
  { root: 'migrations', kind: 'directory', pattern: /\.sql$/ },
  { root: 'migrations/meta', kind: 'directory', recursive: true, pattern: /\.json$/ },
  { root: 'migrations/migration-checksums.json', kind: 'file' },
  { root: 'migrations/baseline-fingerprint.json', kind: 'file' },
  { root: 'scripts/lib/db-baseline-fingerprint.ts', kind: 'file' },
  { root: 'scripts/lib/db-migration-assets.ts', kind: 'file' },
  { root: 'scripts/lib/db-migration-journal.ts', kind: 'file' },
  { root: 'scripts/lib/db-migration-runner.ts', kind: 'file' },
  { root: 'scripts/lib/db-schema-inventory.ts', kind: 'file' },
  { root: 'scripts/lib/sql-definition-normalization.ts', kind: 'file' },
  { root: 'scripts/lib/test-template-provenance.ts', kind: 'file' },
  { root: 'shared/schema', kind: 'directory', recursive: true },
  { root: 'shared/schema.ts', kind: 'file' },
  { root: 'shared/database-invariants.ts', kind: 'file' },
  { root: 'server/db-invariants.ts', kind: 'file' },
  { root: 'tests/setup/seed-test-users.ts', kind: 'file' },
  { root: 'tests/setup/per-worker-lock.ts', kind: 'file' },
  { root: 'scripts/build-test-template.ts', kind: 'file' },
  { root: 'package-lock.json', kind: 'file' },
];

/** Exact tracked inputs that determine whether the migrated template is stale. */
export function computeTemplateHash(repositoryRoot = process.cwd()): string {
  const hasher = createHash('sha256');
  const files: string[] = [];

  for (const input of TEMPLATE_HASH_INPUTS) {
    const absoluteRoot = resolve(repositoryRoot, input.root);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(absoluteRoot);
    } catch {
      throw new Error(`Required test-template hash input is missing: ${input.root}`);
    }

    if (input.kind === 'file') {
      if (!stat.isFile()) {
        throw new Error(`Required test-template hash input is not a file: ${input.root}`);
      }
      files.push(absoluteRoot);
      continue;
    }

    if (!stat.isDirectory()) {
      throw new Error(`Required test-template hash input is not a directory: ${input.root}`);
    }
    const matched: string[] = [];
    collect(absoluteRoot, matched, input.recursive === true, input.pattern);
    if (matched.length === 0) {
      throw new Error(`Required test-template hash input is empty: ${input.root}`);
    }
    files.push(...matched);
  }

  files.sort((a, b) => a.localeCompare(b));
  for (const file of files) {
    hasher.update(relative(repositoryRoot, file).replaceAll('\\', '/'));
    hasher.update('\0');
    hasher.update(readFileSync(file));
    hasher.update('\0');
  }
  return hasher.digest('hex');
}

function collect(
  dir: string,
  out: string[],
  recursive: boolean,
  pattern?: RegExp,
): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && recursive) collect(path, out, true, pattern);
    else if (entry.isFile() && (!pattern || pattern.test(entry.name))) out.push(path);
  }
}
