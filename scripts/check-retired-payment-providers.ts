/**
 * Prevent retired payment providers from returning to active application code.
 * Historical migrations and documentation are intentionally outside this scan.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SOURCE_ROOTS = ['client/src', 'server', 'shared'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.json']);
const RETIRED_PROVIDER_PATTERN = /\b(?:clover|card\s*pointe)\b/i;

function collectFiles(directory: string): string[] {
  if (!statSync(directory, { throwIfNoEntry: false })) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectFiles(path);
    return entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  });
}

export function findRetiredPaymentProviderReferences(root = process.cwd()): string[] {
  return SOURCE_ROOTS.flatMap((sourceRoot) => collectFiles(resolve(root, sourceRoot)))
    .flatMap((file) => readFileSync(file, 'utf8').split(/\r?\n/).flatMap((line, index) => (
      RETIRED_PROVIDER_PATTERN.test(line)
        ? [`${relative(root, file)}:${index + 1}: ${line.trim()}`]
        : []
    )));
}

export function runRetiredPaymentProviderCheck(root = process.cwd()): boolean {
  const violations = findRetiredPaymentProviderReferences(root);
  if (violations.length > 0) {
    console.error('[check-retired-payment-providers] FAIL — retired provider references found in active source:');
    for (const violation of violations) console.error(`  ${violation}`);
    return false;
  }

  console.log('[check-retired-payment-providers] OK — active source is Square-only.');
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!runRetiredPaymentProviderCheck()) process.exitCode = 1;
}
