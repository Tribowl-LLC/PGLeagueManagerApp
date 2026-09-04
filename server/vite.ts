import express, { type Express } from "express";
import fs from "fs";
import path, { dirname } from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer, createLogger } from "vite";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { type Server } from "http";
import viteConfig from "../vite.config";
import { nanoid } from "nanoid";
import { setStaticCacheHeaders } from "./static-cache-policy";

const viteLogger = createLogger();

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

export async function setupVite(app: Express, server: Server) {
  const serverOptions: import('vite').ServerOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true,
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    customLogger: {
      ...viteLogger,
      error: (msg, options) => {
        viteLogger.error(msg, options);
        console.error('[Vite] Transform error:', msg);
        // Don't exit on transform errors during development
        if (!msg.includes('Transform') && !msg.includes('Failed to load')) {
          process.exit(1);
        }
      },
    },
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);
  // Keep missing module requests out of the development SPA fallback too.
  // Vite's middleware serves real source/assets first; only an unresolved
  // `/assets/*` request reaches this guard.
  app.get('/assets/{*splat}', (_req, res) => {
    res
      .status(404)
      .set({
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
      })
      .send('Asset not found');
  });
  // Express 5 requires a named wildcard; include the root path as well.
  app.use("/{*splat}", async (req, res, next) => {
    const url = req.originalUrl;

    try {
      const clientTemplate = path.resolve(
        __dirname,
        "..",
        "client",
        "index.html",
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`,
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");

  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  app.use(express.static(distPath, {
    maxAge: '1y',
    immutable: true,
    setHeaders: setStaticCacheHeaders,
  }));

  // Hashed Vite chunks are JavaScript module requests. If a chunk is removed
  // during a rolling deploy, letting this request fall through to the SPA
  // index returns HTML with a 200 status; browsers then report a misleading
  // module MIME error and cache the broken response. Return a real, uncached
  // 404 instead so the client asset-recovery path can refresh once safely.
  app.get('/assets/{*splat}', (_req, res) => {
    res
      .status(404)
      .set({
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
      })
      .send('Asset not found');
  });

  // fall through to index.html if the file doesn't exist
  app.use("/{*splat}", (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
