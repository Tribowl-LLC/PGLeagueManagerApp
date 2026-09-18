import { describe, expect, it } from 'vitest';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  applePayVerificationFileCandidates,
  APPLE_PAY_DOMAIN_VERIFICATION_FILENAME,
} from '../../server/utils/apple-pay-verification';
import { copyApplePayVerificationFile } from '../../scripts/copy-apple-pay-verification';

describe('Apple Pay verification file resolution', () => {
  it('checks the deployment root before bundled server-chunk paths', () => {
    const candidates = applePayVerificationFileCandidates({
      cwd: '/opt/render/project/src',
      moduleDir: '/opt/render/project/src/dist/server-chunks',
    });

    expect(candidates).toEqual([
      path.resolve(
        '/opt/render/project/src/.well-known',
        APPLE_PAY_DOMAIN_VERIFICATION_FILENAME,
      ),
      path.resolve(
        '/opt/render/project/src/dist/.well-known',
        APPLE_PAY_DOMAIN_VERIFICATION_FILENAME,
      ),
    ]);
  });

  it('resolves the checked-in file from the current deployment root', () => {
    const [candidate] = applePayVerificationFileCandidates();
    expect(candidate).toBe(
      path.resolve(
        process.cwd(),
        '.well-known',
        APPLE_PAY_DOMAIN_VERIFICATION_FILENAME,
      ),
    );
  });

  it('copies an identical artifact into dist for the bundled server layout', async () => {
    const testRoot = await mkdtemp(path.join(tmpdir(), 'leaguevault-apple-pay-'));
    const sourcePath = path.join(
      testRoot,
      '.well-known',
      APPLE_PAY_DOMAIN_VERIFICATION_FILENAME,
    );

    try {
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await copyFile(
        path.resolve(
          process.cwd(),
          '.well-known',
          APPLE_PAY_DOMAIN_VERIFICATION_FILENAME,
        ),
        sourcePath,
      );

      const destinationPath = await copyApplePayVerificationFile(testRoot);
      expect(await readFile(destinationPath)).toEqual(await readFile(sourcePath));

      const bundledCandidate = applePayVerificationFileCandidates({
        cwd: testRoot,
        moduleDir: path.join(testRoot, 'dist', 'server-chunks'),
      }).find((candidate) => candidate === destinationPath);
      expect(bundledCandidate).toBe(destinationPath);
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  });
});
