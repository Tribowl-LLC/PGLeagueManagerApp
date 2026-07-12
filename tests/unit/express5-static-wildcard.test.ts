import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync(
  path.join(process.cwd(), 'server', 'app.ts'),
  'utf8',
);

describe('Express 5 static SPA fallbacks', () => {
  it('uses named braced wildcards for test and production fallbacks', () => {
    // Express 4 accepted `app.get('*', ...)`; Express 5's path-to-regexp
    // rejects that pattern during production boot. Keep this guard close to
    // the CI unit suite because the normal health check exercises dev/Vite
    // startup and does not mount either static fallback.
    expect(appSource).not.toMatch(/app\.get\(\s*['"]\*['"]/);
    expect(
      (appSource.match(/app\.get\(\s*['"]\/\{\*splat\}['"]/g) ?? []).length,
    ).toBe(2);
  });
});
