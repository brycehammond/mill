import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "hono";

// Static asset handler for the built UI bundle. The bundle lives at
// `dist/web/` relative to the repo root, produced by `vite build` in
// the `web/` subproject. We resolve it once at startup; if the dir
// is missing (typical during dev when only the daemon is built), the
// factory returns null and the server skips registering the routes.
//
// SPA fallback: any path that doesn't map to a real file under
// `dist/web/` falls back to `index.html`. The router on the client
// then resolves the path. We never serve `index.html` for paths under
// `/assets/*` — those must be real files (with hashed names) or 404,
// otherwise a stale client requesting an old hash would silently get
// a fresh HTML document and break.
//
// MIME types are kept minimal — Vite emits .js, .css, .svg, .png,
// .woff2, .ico, .json. Anything else falls through to
// application/octet-stream which is fine for the niche cases (.map).

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function mimeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return MIME[path.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

function resolveWebRoot(): string | null {
  // Walk up from this file looking for a `dist/web/index.html`. Both
  // layouts hit it: src/daemon/static.ts in dev resolves to the repo
  // root's dist/web/, and dist/daemon/static.js in prod walks up one
  // dir to find dist/web/ as a sibling. We deliberately do NOT match
  // a bare web/index.html — that's the Vite source entry, not a
  // built artifact, and serving it would 404 on the /src/main.tsx
  // module reference.
  const here = fileURLToPath(import.meta.url);
  let dir = dirname(here);
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, "dist", "web");
    if (existsSync(join(candidate, "index.html"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const cwdGuess = resolve(process.cwd(), "dist", "web");
  if (existsSync(join(cwdGuess, "index.html"))) return cwdGuess;
  return null;
}

export function buildStaticHandler():
  | ((c: Context) => Promise<Response>)
  | null {
  const root = resolveWebRoot();
  if (!root) return null;

  const indexPath = join(root, "index.html");

  return async (c: Context): Promise<Response> => {
    const url = new URL(c.req.url);
    const requestPath = decodeURIComponent(url.pathname);
    // Disallow path traversal: resolve against root, then verify the
    // resolved path stays inside.
    const requestRel = normalize(requestPath).replace(/^\/+/, "");
    const candidate = resolve(root, requestRel);
    if (!candidate.startsWith(root)) {
      return c.text("forbidden", 403);
    }

    // Direct file hit.
    if (requestRel && existsSync(candidate)) {
      const st = statSync(candidate);
      if (st.isFile()) {
        return serveFile(candidate);
      }
    }

    // /assets/* must be a real file. Returning index.html here would
    // mask deploy bugs (stale hashes look like working pages).
    if (requestRel.startsWith("assets/")) {
      return c.text("not found", 404);
    }

    // SPA fallback.
    return serveFile(indexPath);
  };
}

async function serveFile(path: string): Promise<Response> {
  const data = await readFile(path);
  const headers: Record<string, string> = {
    "content-type": mimeFor(path),
  };
  // Long cache for hashed assets, no cache for the entry document.
  if (path.includes("/assets/")) {
    headers["cache-control"] = "public, max-age=31536000, immutable";
  } else {
    headers["cache-control"] = "no-cache";
  }
  return new Response(new Uint8Array(data), { headers });
}
