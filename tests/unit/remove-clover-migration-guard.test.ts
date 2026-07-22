import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(process.cwd(), 'migrations/0003_remove_clover_integration.sql'),
  'utf8',
);

describe('retired payment-provider migration', () => {
  it('checks all unexpected Clover state before dropping any columns', () => {
    const firstDrop = migration.indexOf('DROP COLUMN');
    expect(firstDrop).toBeGreaterThan(0);

    for (const preflight of [
      'payments.type contains clover rows',
      'payments.clover_charge_id contains data',
      'bowlers.clover_customer_id contains data',
      'a location is not configured for Square',
      'an active schedule belongs to a Clover location',
    ]) {
      const check = migration.indexOf(preflight);
      expect(check, `missing preflight: ${preflight}`).toBeGreaterThan(0);
      expect(check, `preflight must run before destructive DDL: ${preflight}`).toBeLessThan(firstDrop);
    }
  });

  it('drops only the retired provider columns', () => {
    const drops = migration.match(/ALTER TABLE[^;]+DROP COLUMN[^;]+/g) ?? [];
    expect(drops).toHaveLength(4);
    expect(drops.join('\n')).toContain('clover_customer_id');
    expect(drops.join('\n')).toContain('clover_credentials');
    expect(drops.join('\n')).toContain('payment_provider');
    expect(drops.join('\n')).toContain('clover_charge_id');
  });
});
