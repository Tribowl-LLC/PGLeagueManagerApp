import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findRetiredPaymentProviderReferences } from '../../scripts/check-retired-payment-providers';
const temporaryDirectories: string[] = [];

function fixture(source: string): string {
  const root = mkdtempSync(join(tmpdir(), 'retired-payment-providers-'));
  temporaryDirectories.push(root);
  mkdirSync(join(root, 'server'), { recursive: true });
  writeFileSync(join(root, 'server', 'payment.ts'), source);
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('retired payment provider source guard', () => {
  it('passes Square-only active source', () => {
    const cwd = fixture("export const provider = 'square';\n");
    expect(findRetiredPaymentProviderReferences(cwd)).toEqual([]);
  });

  it.each(['clover', 'cardpointe', 'Card Pointe'])(
    'rejects a reintroduced %s reference',
    (provider) => {
      const cwd = fixture(`export const provider = '${provider}';\n`);
      expect(findRetiredPaymentProviderReferences(cwd)).toEqual([
        expect.stringContaining(provider),
      ]);
    },
  );
});
