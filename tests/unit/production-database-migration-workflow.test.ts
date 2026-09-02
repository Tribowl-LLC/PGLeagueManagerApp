import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  resolve('.github/workflows/production-database-migration.yml'),
  'utf8',
);

describe('production database migration workflow', () => {
  it('keeps migration dispatch manual and validates the protected production target', () => {
    expect(workflow).toMatch(/^on:\n {2}workflow_dispatch:/m);
    expect(workflow).not.toMatch(/^ {2}(push|pull_request|schedule):/m);
    expect(workflow).toContain(
      '.default == true and .protected == true',
    );
  });

  it('creates and verifies an unprotected pre-migration recovery branch', () => {
    expect(workflow).toContain('--no-compute');
    expect(workflow).toContain('--no-secrets');
    expect(workflow).toContain('--no-protected');
    expect(workflow).toContain('.parent_id == $parent and .protected == false');
    expect(workflow).not.toMatch(/^\s+--protected(?:\s|\\)/m);
  });
});
