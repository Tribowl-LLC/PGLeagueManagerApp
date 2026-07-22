import type { Server } from "http";
import type { Request, Response, NextFunction } from "express";
import { cleanup as dbCleanup } from "../db";
import { paymentScheduler } from "../services/payment-scheduler";
import { stopPaymentSyncRetrySweep } from "../services/payment-sync-retry";
import { createLogger } from "../logger";

const log = createLogger("Shutdown");

const DRAIN_POLL_INTERVAL_MS = 100;
const DRAIN_TIMEOUT_MS = 10_000;
const SERVER_CLOSE_TIMEOUT_MS = 5_000;

let activeRequests = 0;

/**
 * Express middleware that tracks in-flight requests so graceful shutdown can
 * wait for them to complete before tearing down the server.
 */
export function requestTracker(_req: Request, res: Response, next: NextFunction): void {
  activeRequests++;
  res.on('finish', () => { activeRequests--; });
  next();
}

/**
 * Registers SIGTERM/SIGINT/SIGHUP handlers and uncaught error handlers that
 * gracefully drain in-flight requests, stop background schedulers, close DB
 * pools, and shut down the HTTP server.
 */
export function registerShutdownHandlers(server: Server): void {
  async function shutdown() {
    log.info('Shutting down...');
    const startTime = Date.now();

    try {
      paymentScheduler?.cancelAllJobs();
      stopPaymentSyncRetrySweep();

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          log.warn(`Forcing shutdown with ${activeRequests} active requests`);
          resolve();
        }, DRAIN_TIMEOUT_MS);

        const waitForDrain = () => {
          if (activeRequests <= 0) {
            clearTimeout(timeout);
            resolve();
          } else {
            setTimeout(waitForDrain, DRAIN_POLL_INTERVAL_MS);
          }
        };
        waitForDrain();
      });

      await dbCleanup();

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Server close timeout')), SERVER_CLOSE_TIMEOUT_MS);
        server.close((err) => {
          clearTimeout(timeout);
          if (err) reject(err);
          else resolve();
        });
      });

      log.info(`Shutdown completed in ${Date.now() - startTime}ms`);
      process.exit(0);
    } catch (error) {
      log.error('Error during shutdown:', error);
      process.exit(1);
    }
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGHUP', shutdown);

  process.on('uncaughtException', (error) => {
    log.error('Uncaught exception:', error);
    shutdown();
  });

  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection:', reason);
    shutdown();
  });
}
