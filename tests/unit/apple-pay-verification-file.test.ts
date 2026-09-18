import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  applePayVerificationFileCandidates,
  APPLE_PAY_DOMAIN_VERIFICATION_FILENAME,
} from '../../server/utils/apple-pay-verification';

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
});
