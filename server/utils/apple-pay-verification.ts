import path from 'node:path';
import { readFile } from 'node:fs/promises';

export const APPLE_PAY_DOMAIN_VERIFICATION_FILENAME =
  'apple-developer-merchantid-domain-association';

/**
 * Return the locations in which the Apple Pay association file may exist.
 *
 * The production server is bundled into `dist/server-chunks`, while the
 * checked-in verification file lives at the deployment root. Resolving from
 * `process.cwd()` first keeps the deployed layout independent of the chunk
 * filename and still allows the development and non-split bundle layouts to
 * work through the module-relative fallbacks.
 */
export function applePayVerificationFileCandidates(options: {
  cwd?: string;
  moduleDir?: string;
} = {}): string[] {
  const cwd = options.cwd ?? process.cwd();
  const moduleDir = options.moduleDir ?? import.meta.dirname;
  const candidates = [
    path.join(cwd, '.well-known', APPLE_PAY_DOMAIN_VERIFICATION_FILENAME),
    path.join(cwd, 'dist', '.well-known', APPLE_PAY_DOMAIN_VERIFICATION_FILENAME),
    path.join(moduleDir, '..', '.well-known', APPLE_PAY_DOMAIN_VERIFICATION_FILENAME),
    path.join(moduleDir, '..', '..', '.well-known', APPLE_PAY_DOMAIN_VERIFICATION_FILENAME),
  ];

  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

/**
 * Read the first available association artifact from the supported deployment
 * layouts. Reading the bytes directly avoids Express `sendFile()` resolving a
 * path differently from the existence check in bundled Render deployments.
 */
export async function readApplePayVerificationFile(options: {
  cwd?: string;
  moduleDir?: string;
} = {}): Promise<Buffer | undefined> {
  for (const candidate of applePayVerificationFileCandidates(options)) {
    try {
      return await readFile(candidate);
    } catch {
      // Try the next deployment layout before falling back to configuration.
    }
  }
  return undefined;
}
