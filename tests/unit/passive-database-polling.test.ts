import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const PASSIVE_QUERY_FILES = [
  'client/src/components/layout.tsx',
  'client/src/components/apple-pay-recovery-banner.tsx',
  'client/src/components/league-square-missing-banner.tsx',
  'client/src/components/square-catalog-cap-banner.tsx',
];

describe('passive database-backed UI queries', () => {
  it.each(PASSIVE_QUERY_FILES)('%s refreshes on focus without an interval', (file) => {
    const source = readFileSync(resolve(file), 'utf8');
    expect(source).toContain('refetchOnWindowFocus: true');
    expect(source).not.toContain('refetchInterval:');
  });

  it('keeps rapid polling scoped to active Apple Pay jobs', () => {
    const listSource = readFileSync(
      resolve('client/src/pages/apple-pay-jobs-page.tsx'),
      'utf8',
    );
    const detailSource = readFileSync(
      resolve('client/src/pages/apple-pay-jobs-page/job-detail-dialog.tsx'),
      'utf8',
    );
    expect(listSource).toContain('refetchInterval: (query) =>');
    expect(listSource).toContain('isActive(j.status)');
    expect(detailSource).toContain('refetchInterval: (query) =>');
    expect(detailSource).toContain('isActive(status)');
  });

  it('refreshes payment-linked disputes only on Payments page load or focus', () => {
    const source = readFileSync(resolve('client/src/pages/payments-page.tsx'), 'utf8');
    expect(source).toContain('includeDisputes=true');
    expect(source).toContain('const includeDisputes = !isPaymentManager');
    expect(source).toContain('enabled: !!userResponse?.data');
    expect(source).toContain('includeDisputes ? "with-disputes" : "without-disputes"');
    expect(source).toContain('refetchOnWindowFocus: "always"');
    expect(source).not.toContain('refetchInterval:');
  });
});
