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

describe('Express 5 auth aliases', () => {
  it('rewrites aliases and forwards them through the canonical auth mount', () => {
    const routesSource = readFileSync(
      path.join(process.cwd(), 'server', 'routes', 'index.ts'),
      'utf8',
    );

    expect(routesSource).not.toContain('app._router.handle');
    expect(routesSource).not.toContain('app.router.handle');

    const aliasStart = routesSource.indexOf("app.get('/api/user'");
    const canonicalMount = routesSource.indexOf('registerAuthRoutes(app);');
    expect(aliasStart).toBeGreaterThanOrEqual(0);
    expect(canonicalMount).toBeGreaterThan(aliasStart);

    const aliases = routesSource.slice(aliasStart, canonicalMount);
    expect(aliases).toContain("req.url = '/api/auth/user';");
    expect(aliases).toContain("req.url = '/api/auth/logout';");
    expect((aliases.match(/next\(\);/g) ?? []).length).toBe(2);
  });
});

describe('Render liveness health check', () => {
  it('uses a database-free endpoint and keeps the deep probe separate', () => {
    const livenessStart = appSource.indexOf("app.get('/healthz'");
    const deepHealthStart = appSource.indexOf("app.get('/api/health'");

    expect(livenessStart).toBeGreaterThanOrEqual(0);
    expect(deepHealthStart).toBeGreaterThan(livenessStart);

    const livenessSource = appSource.slice(livenessStart, deepHealthStart);
    expect(livenessSource).toContain("type('text/plain').send('ok')");
    expect(livenessSource).not.toContain('testConnection');
  });
});
