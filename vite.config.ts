import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import path, { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const release = process.env.SENTRY_RELEASE ?? process.env.RENDER_GIT_COMMIT ?? "development";
const uploadSentrySourceMaps = Boolean(process.env.SENTRY_AUTH_TOKEN) && release !== "development";

export default defineConfig({
  plugins: [
    react(),
    ...(uploadSentrySourceMaps
      ? [sentryVitePlugin({
          org: process.env.SENTRY_ORG ?? "perfect-game",
          project: process.env.SENTRY_PROJECT ?? "javascript-react",
          authToken: process.env.SENTRY_AUTH_TOKEN,
          telemetry: false,
          release: { name: release },
          sourcemaps: {
            filesToDeleteAfterUpload: ["./dist/public/**/*.map"],
          },
        })]
      : []),
  ],
  define: {
    __APP_RELEASE__: JSON.stringify(release),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "client", "src"),
      "@shared": path.resolve(__dirname, "shared"),
    },
  },
  root: path.resolve(__dirname, "client"),
  build: {
    // Preserve the established browser baseline during the Vite 8 upgrade.
    target: ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14'],
    outDir: path.resolve(__dirname, "dist/public"),
    emptyOutDir: true,
    // Production maps are uploaded by the Sentry plugin and deleted before
    // the Render artifact is published. Local/CI builds without an upload
    // token do not emit maps.
    sourcemap: uploadSentrySourceMaps ? "hidden" : false,
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
    allowedHosts: true
  }
});
