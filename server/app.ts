/**
 * App factory (Task #699).
 *
 * Extracts the body of `server/index.ts` into a reusable
 * `createApp(...)` so the test harness can spawn isolated Express
 * instances per vitest worker without inheriting the production
 * boot's background workers, scheduler timers, or third-party HTTP
 * probes. The dev/prod entry point still funnels through this
 * factory, so `npm run dev` behavior is unchanged.
 *
 * `suppressBackgroundWorkers: true` skips the heavy boot-time work
 * that has no business running in a unit-test process: schedulers,
 * sync sweeps, the Apple-Pay worker resume, the Square catalog
 * audit, the third-party pin verifier sweep, the Square
 * custom-attribute bootstrap, the avatar/double-pay/missing-customer
 * migrations, and the Vite dev middleware. `installDbInvariants`
 * still runs (idempotent + cheap) so a freshly-cloned worker DB
 * lands on the same trigger/tables as production.
 */
import express, { type Express, type Request, Response, NextFunction } from "express";
import compression from "compression";
import { createServer, type Server as HttpServer } from 'http';
import path from 'path';
import fs from 'fs';
import type { AddressInfo } from 'net';
import { appEnv, env, isDev, scheduledPaymentExecutionMode } from "./config";
import { commitSha } from './utils/build-info';
import { registerRoutes } from "./routes/index";
import { setupVite } from "./vite";
import {
  testConnection,
  db as defaultDb,
  createDbClient,
  type DbClient,
} from "./db";
import { installDbInvariants } from "./db-invariants";
import { setupAuth } from "./auth";
import { paymentOperationRetryExecutor } from './services/payment-operation-retry-executor';
import { rosterStandingAutopayOperationExecutor } from './services/roster-standing-autopay-executor';
import { configureStandingAutopayRuntime } from './services/roster-standing-autopay';
import { configurePaymentOperationRuntime } from './services/payment-operation-runtime';
import { startPaymentSyncRetrySweep } from './services/payment-sync-retry';
import { bootstrapAllSquareCustomAttributeDefinitions } from './services/square-startup-bootstrap';
import { verifySquareSdkVersion } from './services/square-provider';
import { verifyAllThirdPartyPins } from './services/third-party-pin-verifier';
// Side-effect import: registers SendGrid and Square pin verifiers so
// `verifyAllThirdPartyPins()` below sees a fully-populated registry.
import './services/third-party-pins';
import { applePayWorker } from './services/apple-pay-worker';
import { startLeagueSquareCatalogAudit } from './services/league-square-catalog-audit';
import { ensureAvatarsDirectory, migrateAvatarsFromDBToDisk, migrateDiskUrlsToApiUrls } from './migrations/migrate-avatars';
import { backfillMissingPaymentCustomers } from './migrations/backfill-missing-payment-customers';
import { seedDefaultEmailTemplates } from './migrations/seed-email-templates';
import { createLogger } from './logger';
import { csrfProtection, csrfTokenEndpoint } from './middleware/csrf';
import { subdomainDetection, orgSessionGuard } from './middleware/subdomain';
import { securityHeaders, apiHeaders } from './middleware/security';
import { requestTracker, registerShutdownHandlers } from './lib/shutdown';
import manifestRouter from './routes/manifest';
import { assertTrustProxyAtBoot } from './lib/trust-proxy-check';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@shared/schema';
import { registerSquareWebhookReceiver } from './routes/payments-provider/square-webhook';

const log = createLogger("Server");

export interface CreateAppOptions {
  /**
   * Override `process.env.DATABASE_URL` for this app instance.
   *
   * When provided, a fresh `pg.Pool` + Drizzle wrapper is built and:
   *   - `installDbInvariants` runs against it,
   *   - `testConnection` (boot probe) runs against it,
   *   - the `/api/health` endpoint probes it,
   *   - the returned `db` / `close` use it.
   *
   * The singleton in `server/db.ts` is left untouched so the dev/prod
   * process keeps owning its lifecycle (and `npm run dev` is unchanged).
   *
   * **Phase 1 boundary (Task #699):** the rest of the application
   * (storage layer, route handlers) still imports the singleton `db`
   * directly. Phase 2 of the parent epic (#697) plumbs the per-instance
   * `db` into the storage layer so request-handling on this instance
   * actually targets the override DB. Until then, Phase 2 callers
   * (vitest globalSetup, `server/test-entry.ts`) achieve isolation by
   * setting `DATABASE_URL` in the spawned child's environment so the
   * singleton itself is bound to the per-worker DB at module-load
   * time. The `databaseUrl` parameter exists today for the connection
   * surface above and to lock in the API shape the test harness will
   * adopt in Phase 2.
   *
   * If unset, the singleton `db` is reused (current production path).
   */
  databaseUrl?: string;
  /**
   * Listen port. Defaults to `env.PORT`. Pass `0` to let the kernel
   * pick a free port (the resolved port is returned in the result).
   */
  port?: number;
  /**
   * When true: skip the schedulers, retry sweeps, Apple Pay worker
   * resume, league/Square catalog audit, third-party pin verifier
   * sweep, Square custom-attribute bootstrap, the boot-time
   * avatar/double-pay/missing-customer migrations, and Vite dev
   * middleware. Designed for the per-worker test harness.
   */
  suppressBackgroundWorkers?: boolean;
  /**
   * When true: mount `express.static('dist/public')` + an SPA
   * catch-all that serves `dist/public/index.html` for non-`/api/*`
   * routes. Used by the per-worker test harness's e2e Playwright
   * tests, which need the prebuilt React bundle but must NOT incur
   * the cost of `setupVite()`. Independent of
   * `suppressBackgroundWorkers` so the test harness can skip the
   * heavy boot-time work AND still serve the frontend.
   * Requires `npm run build` to have produced `dist/public/`.
   */
  serveStaticFrontend?: boolean;
}

export interface CreatedApp {
  app: Express;
  server: HttpServer;
  port: number;
  db: NodePgDatabase<typeof schema>;
  close: () => Promise<void>;
}

export async function createApp(opts: CreateAppOptions = {}): Promise<CreatedApp> {
  const suppress = opts.suppressBackgroundWorkers === true;
  configureStandingAutopayRuntime({ rearm: () => rosterStandingAutopayOperationExecutor.rearm() });
  configurePaymentOperationRuntime({
    ledgerExecute: !suppress && scheduledPaymentExecutionMode === 'ledger_execute',
    rearm: () => paymentOperationRetryExecutor.rearm(),
  });

  log.info('Runtime envelope', {
    appEnv,
    nodeEnv: env.NODE_ENV,
    commit: commitSha,
    squareCreds:
      env.SQUARE_PROD_TOKEN || env.SQUARE_PRODUCTION_ACCESS_TOKEN
        ? 'production'
        : env.SQUARE_ACCESS_TOKEN
          ? 'sandbox/fallback'
          : 'unset',
  });

  // Per-instance DB client (Phase 1 — only constructed when an
  // override URL is supplied; otherwise the singleton is reused).
  let perInstanceClient: DbClient | null = null;
  let dbForApp: NodePgDatabase<typeof schema> = defaultDb;
  if (opts.databaseUrl !== undefined) {
    perInstanceClient = createDbClient(opts.databaseUrl);
    dbForApp = perInstanceClient.db;
  }
  const probePool = perInstanceClient?.pool;

  const app = express();
  app.set("trust proxy", 1);
  assertTrustProxyAtBoot(app, { isProduction: !isDev, log });
  const server = createServer(app);

  const HOST = '0.0.0.0';
  const PORT = opts.port ?? env.PORT;

  app.use(requestTracker);
  // Render sends health checks with a verified custom domain as the Host
  // header. Register liveness before tenant resolution so those probes cannot
  // perform an organization lookup and keep Neon awake.
  app.get('/healthz', (_req, res) => {
    res.set('Cache-Control', 'no-store').type('text/plain').send('ok');
  });
  // Register Square before tenant resolution and the global JSON parser. The
  // exact route owns raw-byte signature validation and remains disabled unless
  // the explicit Phase 4A-1 ingest-only mode is configured.
  registerSquareWebhookReceiver(app);
  app.use(subdomainDetection);
  app.use(compression());
  app.use(securityHeaders);

  // Admin email templates hold rich HTML bodies (and may carry inline
  // markup/base64) that can legitimately exceed the small global ceiling.
  // Mount a route-scoped 1 MB JSON parser BEFORE the global parser so it
  // claims the body first; the global parser then sees `req._body` set and
  // skips re-parsing. rawBody capture isn't needed here (only webhooks use
  // it), so this parser intentionally omits the verify hook.
  app.use('/api/admin/email-templates', express.json({ limit: '1mb' }));

  // Global body-parser ceilings are intentionally small (256 KB). Normal
  // auth/account/admin/payment JSON payloads are far below this;
  // oversized bodies are rejected early with a 413 before route handlers run.
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));
  await setupAuth(app);
  app.use(orgSessionGuard);

  app.use(manifestRouter);

  app.get('/loaderio-19ef38424d52907d2a5ef69f13f4794b.txt', (_req, res) => {
    res.type('text/plain').send('loaderio-19ef38424d52907d2a5ef69f13f4794b');
  });

  app.get('/.well-known/apple-app-site-association', (_req, res) => {
    res.set('Content-Type', 'application/json');
    res.json({
      applinks: {
        apps: [],
        details: [
          {
            appID: 'TEAM_ID.app.leaguevault.mobile',
            paths: ['*'],
          },
        ],
      },
    });
  });

  app.get('/.well-known/assetlinks.json', (_req, res) => {
    res.set('Content-Type', 'application/json');
    res.json([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'app.leaguevault.mobile',
          sha256_cert_fingerprints: [],
        },
      },
    ]);
  });

  app.get('/.well-known/apple-developer-merchantid-domain-association', async (_req, res) => {
    const staticPath = path.join(import.meta.dirname, '..', '.well-known', 'apple-developer-merchantid-domain-association');
    try {
      const { access } = await import('fs/promises');
      await access(staticPath);
      res.set('Content-Type', 'application/octet-stream');
      res.set('Content-Disposition', 'attachment; filename="apple-developer-merchantid-domain-association"');
      return res.sendFile(path.resolve(staticPath));
    } catch {
      // Fall back to env var if static file not present
    }
    const verification = process.env.APPLE_PAY_DOMAIN_VERIFICATION;
    if (verification) {
      res.set('Content-Type', 'application/octet-stream');
      res.set('Content-Disposition', 'attachment; filename="apple-developer-merchantid-domain-association"');
      res.send(verification);
      return;
    }
    res.status(404).type('text/plain').send('Not configured');
  });

  app.use('/api', apiHeaders);

  app.get('/api/csrf-token', csrfTokenEndpoint);
  app.use('/api', csrfProtection);

  app.get('/api/health', async (_req, res) => {
    try {
      await testConnection(3, 1000, probePool);
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      log.error('Health check error:', error);
      res.status(503).json({
        status: 'unhealthy',
      });
    }
  });

  registerRoutes(app);

  // Express 5 requires a named wildcard; the braced form also matches the
  // bare `/api/` path, preserving the previous catch-all behavior.
  app.all('/api/{*splat}', (req, res) => {
    res.status(404).json({
      success: false,
      error: {
        message: 'API endpoint not found',
        path: req.path,
        method: req.method
      }
    });
  });

  // Lazy-load `@sentry/node` (task #692). The package pulls a large
  // OpenTelemetry transitive tree; deferring keeps cold-start cheap.
  const Sentry = await import("@sentry/node");
  Sentry.setupExpressErrorHandler(app);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log.error('Unhandled express error:', err);
    if (!res.headersSent) {
      const errObj = (err && typeof err === 'object') ? err as { status?: unknown; message?: unknown } : {};
      const statusCode = (typeof errObj.status === 'number' && errObj.status >= 400 && errObj.status < 500)
        ? errObj.status
        : 500;
      const clientMessage = statusCode < 500
        ? (typeof errObj.message === 'string' ? errObj.message : "Bad request")
        : "An internal error occurred";
      res.status(statusCode).json({
        success: false,
        error: {
          code: statusCode < 500 ? 'BAD_REQUEST' : 'INTERNAL_ERROR',
          message: clientMessage,
        }
      });
    }
  });

  async function testDatabaseConnectionWithRetry(maxRetries = 3, backoffMs = 1000): Promise<boolean> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await testConnection(3, 1000, probePool);
        return true;
      } catch (error) {
        log.error(`Database connection attempt ${attempt}/${maxRetries} failed:`, error);
        if (attempt === maxRetries) return false;
        const delay = backoffMs * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    return false;
  }

  // Vite middleware (dev) or static catch-all (prod). Skipped for
  // the per-worker test harness — tests only hit /api routes,
  // unless `serveStaticFrontend` is set (e2e Playwright tests).
  if (opts.serveStaticFrontend === true) {
    // Test-harness path: serve the prebuilt React bundle directly
    // from disk. No Vite, no transform pipeline — just a static
    // middleware + SPA fallback. Adds ~0ms to boot. Gated on the
    // build artifact actually existing so callers that opt in
    // without a prior `npm run build` get API-only behaviour
    // instead of runtime ENOENT on every non-API GET.
    const distDir = path.join(process.cwd(), 'dist/public');
    const indexHtml = path.join(distDir, 'index.html');
    if (fs.existsSync(indexHtml)) {
      app.use(express.static(distDir, {
        maxAge: '1y',
        immutable: true,
        setHeaders(res, filePath) {
          if (filePath.endsWith('index.html')) {
            res.setHeader('Cache-Control', 'no-store');
          }
        }
      }));
      // Express 5 requires a named wildcard; include the root path for the
      // static SPA fallback used by the test harness.
      app.get('/{*splat}', (req, res) => {
        if (req.path.startsWith('/api/')) {
          return res.status(404).json({ error: 'API endpoint not found' });
        }
        res.setHeader('Cache-Control', 'no-store');
        res.sendFile(indexHtml);
      });
    } else {
      log.warn(
        'serveStaticFrontend requested but dist/public/index.html is missing — skipping static mount. Run `npm run build` first.',
      );
    }
  } else if (!suppress) {
    if (isDev) {
      try {
        await setupVite(app, server);
        log.info('Vite middleware ready');
      } catch (error) {
        log.error('Critical error setting up Vite:', error);
        process.exit(1);
      }
    } else {
      app.use(express.static(path.join(process.cwd(), 'dist/public'), {
        maxAge: '1y',
        immutable: true,
        setHeaders(res, filePath) {
          if (filePath.endsWith('index.html')) {
            res.setHeader('Cache-Control', 'no-store');
          }
        }
      }));
      // Express 5 requires a named wildcard; include the root path for the
      // production static SPA fallback.
      app.get('/{*splat}', (req, res) => {
        if (req.path.startsWith('/api/')) {
          return res.status(404).json({ error: 'API endpoint not found' });
        }
        res.setHeader('Cache-Control', 'no-store');
        res.sendFile(path.join(process.cwd(), 'dist/public/index.html'));
      });
    }
  }

  // Boot DB checks + invariants. Always-on (cheap, idempotent).
  const dbConnected = await testDatabaseConnectionWithRetry();
  if (!dbConnected) {
    log.error('Database connection failed after all retry attempts, refusing to start');
    process.exit(1);
  }
  log.info('Database connected');

  try {
    await installDbInvariants(dbForApp);
  } catch (error) {
    log.error('Failed to install database invariants:', error);
    process.exit(1);
  }

  if (!suppress) {
    ensureAvatarsDirectory();

    try {
      const dbMigrationOk = await migrateAvatarsFromDBToDisk();
      if (dbMigrationOk) {
        await migrateDiskUrlsToApiUrls();
      }
    } catch (error) {
      log.error('Error running avatar migration:', error);
    }

    try {
      await backfillMissingPaymentCustomers();
    } catch (error) {
      log.error('Error backfilling missing payment customers:', error);
    }

    try {
      await seedDefaultEmailTemplates();
    } catch (error) {
      log.error('Error seeding default email templates:', error);
    }
  }

  // Listen, then resolve port (kernel may have picked one if PORT=0).
  const actualPort: number = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: PORT, host: HOST }, () => {
      const addr = server.address() as AddressInfo | null;
      const p = addr && typeof addr === 'object' ? addr.port : PORT;
      log.info(`Running at http://${HOST}:${p}`);
      resolve(p);
    });
  });

  if (!suppress) {
    try {
      await paymentOperationRetryExecutor.start(scheduledPaymentExecutionMode);
      await rosterStandingAutopayOperationExecutor.start();
      log.info('Scheduled payment execution initialized', { mode: scheduledPaymentExecutionMode });

      await startPaymentSyncRetrySweep();

      verifySquareSdkVersion().catch((err) => {
        log.error('Square SDK version probe threw at boot:', err);
      });

      verifyAllThirdPartyPins().catch((err) => {
        log.error('Third-party pin verifier sweep threw at boot:', err);
      });

      bootstrapAllSquareCustomAttributeDefinitions().catch((err) => {
        log.error('Square custom-attribute bootstrap failed:', err);
      });

      applePayWorker.resumeOnStartup().catch((err) => {
        log.error('Apple Pay worker resume failed:', err);
      });

      startLeagueSquareCatalogAudit();
    } catch (error) {
      log.error('Error initializing schedulers:', error);
    }

    // Production / dev gets the SIGTERM/SIGINT shutdown hook. The
    // test harness owns its own SIGTERM handling in
    // `server/test-entry.ts` so we don't double-register here.
    registerShutdownHandlers(server);
  }

  const close = async (): Promise<void> => {
    paymentOperationRetryExecutor.stop();
    rosterStandingAutopayOperationExecutor.stop();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    if (perInstanceClient !== null) {
      await perInstanceClient.close();
    }
    // Never end the singleton pool here — the dev/prod process owns
    // its lifecycle via `registerShutdownHandlers` + `cleanup()`.
  };

  return { app, server, port: actualPort, db: dbForApp, close };
}
