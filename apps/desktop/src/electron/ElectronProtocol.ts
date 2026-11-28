// Lifted from GOAT v1 apps/desktop/src/electron/ElectronProtocol.ts (adapted: Effect services
// removed, legacy T3 schemes, origin migration, Clerk and the dev-server proxy dropped).
// The renderer is served from <scheme>://app/ out of the packaged apps/web build.
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { protocol } from "electron";

export const DESKTOP_HOST = "app";
// GOAT 2 (Dev) must share nothing with GOAT v1 ("goat" / "goat-dev"); release GOAT 2 gets "goat2" later.
const DESKTOP_PRODUCTION_SCHEME = "goat2";
const DESKTOP_DEVELOPMENT_SCHEME = "goat2-dev";

/** The scheme the renderer is served from. */
export function getDesktopScheme(isDevelopment: boolean): string {
  return isDevelopment ? DESKTOP_DEVELOPMENT_SCHEME : DESKTOP_PRODUCTION_SCHEME;
}

export function getDesktopOrigin(isDevelopment: boolean): string {
  return `${getDesktopScheme(isDevelopment)}://${DESKTOP_HOST}`;
}

export function getDesktopUrl(isDevelopment: boolean): string {
  return `${getDesktopOrigin(isDevelopment)}/`;
}

export function makeDesktopContentSecurityPolicy(scheme: string): string {
  const scriptSources = ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'"];

  // User-configured environment origins are unknown here, so allow supported network schemes.
  // GLTFLoader fetches embedded textures through blob URLs.
  const connectSources = ["'self'", "blob:", "http:", "https:", "ws:", "wss:"];

  return [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    `connect-src ${connectSources.join(" ")}`,
    `img-src 'self' ${scheme}: blob: data: http: https:`,
    `media-src 'self' ${scheme}: blob: http: https:`,
    // GOAT 2: the Paper UI loads Inter / Geist Mono from Google Fonts (apps/web/index.html).
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    `font-src 'self' ${scheme}: data: https://fonts.gstatic.com`,
    "worker-src 'self' blob:",
    "frame-src 'self' blob: http: https:",
    "object-src 'self' blob: http: https:",
    "form-action 'self'",
  ].join("; ");
}

function withContentSecurityPolicy(response: Response, policy: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", policy);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Must run synchronously during process bootstrap, before Electron emits `ready`.
 */
export function registerDesktopSchemePrivilegesSync(): void {
  const privileges = {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  };
  protocol.registerSchemesAsPrivileged([
    // Custom schemes skip Chromium's V8 code cache unless they opt in.
    // Dev stays off: Vite serves changing code at stable URLs.
    { scheme: DESKTOP_PRODUCTION_SCHEME, privileges: { ...privileges, codeCache: true } },
    { scheme: DESKTOP_DEVELOPMENT_SCHEME, privileges },
  ]);
}

// v1 resolves content types with effect/http/Mime; GOAT 2 lists what the vite build emits.
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

export async function serveDesktopAsset(request: Request, assetDirectory: string): Promise<Response> {
  const url = new URL(request.url);
  if (url.host !== DESKTOP_HOST) return new Response(null, { status: 404 });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405 });
  }
  let pathname: string | null;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    pathname = null;
  }
  if (pathname === null || pathname.includes("\0")) return new Response(null, { status: 400 });
  const root = resolve(assetDirectory);
  const assetPath = resolve(root, `.${pathname}`);
  if (assetPath !== root && !assetPath.startsWith(root + sep)) {
    return new Response(null, { status: 404 });
  }
  const info = await stat(assetPath).catch(() => null);
  let filePath = assetPath;
  if (!info?.isFile()) {
    const wantsHtml = request.headers.get("accept")?.includes("text/html") ?? false;
    if (extname(assetPath) !== "" && !wantsHtml) {
      return new Response(null, { status: 404 });
    }
    filePath = join(root, "index.html");
  }
  const contents = await readFile(filePath).catch(() => null);
  if (contents === null) return new Response(null, { status: 404 });
  return new Response(request.method === "HEAD" ? null : new Uint8Array(contents), {
    headers: {
      "content-type": CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
    },
  });
}

/** Serves the packaged renderer from `assetDirectory` with v1's content security policy. */
export function registerDesktopProtocol(scheme: string, assetDirectory: string): void {
  const contentSecurityPolicy = makeDesktopContentSecurityPolicy(scheme);
  protocol.handle(scheme, async (request) =>
    withContentSecurityPolicy(await serveDesktopAsset(request, assetDirectory), contentSecurityPolicy),
  );
}
