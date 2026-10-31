import { constants, createReadStream } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import { Readable } from "node:stream";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./middleware.ts";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
};

/**
 * Everything the page may load is same-origin. No inline or eval'd script, no
 * framing, no plugins, no base-tag rewrites. `blob:` workers and `data:`/`blob:`
 * images are what three.js texture and worker loaders use.
 */
export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Vite fingerprints everything under `assets/`, so those files never change under one name. */
const IMMUTABLE_PREFIX = "assets/";

/**
 * Serves the built web client from `root`, and nothing else.
 *
 * - GET and HEAD only; anything else falls through.
 * - The request path is split and decoded one segment at a time. A segment that is empty,
 *   `.`, `..`, hidden (starts with a dot), or that decodes to contain a separator, a
 *   backslash or a NUL is refused, so encoded and double-encoded traversal never reaches the
 *   file system.
 * - The resolved real path (symlinks followed) must stay inside the real root and must not pass
 *   through a hidden segment, so a link in the web directory can lead neither out of it nor to
 *   a hidden file inside it. The file is then opened with `O_NOFOLLOW` and
 *   checked to be a regular file. Anyone who can already write to the web directory can
 *   swap a parent directory between the check and the open; that is outside the threat
 *   model (ARCHITECTURE.md section 13), same as editing Claude Code settings.
 * - A directory is never listed. `/` and `/dir/` serve that directory's `index.html`.
 * - Missing and refused files are the same 404, so probing reveals nothing.
 */
export function staticFiles(root: string): MiddlewareHandler<AppEnv> {
  let realRoot: Promise<string> | undefined;
  const rootPath = () => {
    realRoot ??= realpath(root);
    return realRoot;
  };

  return async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
    const relative = toRelativePath(new URL(c.req.url).pathname);
    if (relative === null) return next();

    let base: string;
    try {
      base = await rootPath();
    } catch {
      realRoot = undefined;
      return next();
    }

    let real: string;
    try {
      real = await realpath(join(base, relative));
    } catch {
      return next();
    }
    if (real !== base && !real.startsWith(base + sep)) return next();
    // A public-looking name can be a link to a hidden file or directory inside the root.
    if (
      real
        .slice(base.length)
        .split(sep)
        .some((part) => part.startsWith("."))
    )
      return next();

    const file = await openRegularFile(real).catch(() => null);
    if (file === null) {
      // A directory with an index serves it; everything else is not found.
      const index = await openRegularFile(join(real, "index.html")).catch(() => null);
      if (index === null) return next();
      return respond(c.req.method, index, "index.html", join(relative, "index.html"));
    }
    return respond(c.req.method, file, real, relative);
  };
}

type Opened = { path: string; size: number };

async function openRegularFile(path: string): Promise<Opened | null> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    return { path, size: stat.size };
  } finally {
    await handle.close();
  }
}

function respond(method: string, file: Opened, nameForType: string, relative: string): Response {
  const headers = new Headers();
  const extension = extname(nameForType).toLowerCase();
  headers.set("Content-Type", CONTENT_TYPES[extension] ?? "application/octet-stream");
  headers.set("Content-Length", String(file.size));
  const immutable = relative.startsWith(IMMUTABLE_PREFIX);
  headers.set("Cache-Control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
  if (extension === ".html") headers.set("Content-Security-Policy", PAGE_CSP);
  if (method === "HEAD") return new Response(null, { status: 200, headers });
  const body = Readable.toWeb(createReadStream(file.path)) as ReadableStream<Uint8Array>;
  return new Response(body, { status: 200, headers });
}

/**
 * Turns a URL pathname into a safe relative file path, or null when the path must not be
 * served. An empty result means the root directory.
 */
export function toRelativePath(pathname: string): string | null {
  if (!pathname.startsWith("/")) return null;
  const segments: string[] = [];
  for (const raw of pathname.slice(1).split("/")) {
    if (raw === "") continue;
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (segment === "." || segment === ".." || segment.startsWith(".") || /[/\\\0]/.test(segment)) {
      return null;
    }
    segments.push(segment);
  }
  return segments.join("/");
}
