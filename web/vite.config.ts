import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev: serve on 5173, proxy API + SSE traffic to the running daemon.
// In build: emit to ../dist/web/ so the daemon's static handler can find
// it without a separate publish step. Hashed assets land in /assets so
// the static handler's long cache headers apply automatically.

const DAEMON_HOST = process.env.MILL_DAEMON_HOST || "127.0.0.1";
const DAEMON_PORT = process.env.MILL_DAEMON_PORT || "7333";
const DAEMON_URL = `http://${DAEMON_HOST}:${DAEMON_PORT}`;

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // The daemon's API surface. We proxy each Phase 1 root path
      // explicitly rather than a single regex so the SPA dev server
      // still owns "/" for HMR.
      "/api": { target: DAEMON_URL, changeOrigin: false, ws: false },
      "/healthz": { target: DAEMON_URL, changeOrigin: false },
      "/projects": { target: DAEMON_URL, changeOrigin: false },
      "/runs": { target: DAEMON_URL, changeOrigin: false },
      "/findings": { target: DAEMON_URL, changeOrigin: false },
    },
  },
});
