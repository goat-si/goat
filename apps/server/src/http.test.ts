import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ORCHESTRATION_PROTOCOL_HEADER } from "@goat/contracts";
import {
  GOAT_ACTIVITY_PATH,
  GOAT_ENVIRONMENT_PATH,
  LEGACY_ACTIVITY_PATH,
  LEGACY_ENVIRONMENT_PATH,
  LEGACY_ORCHESTRATION_PROTOCOL_HEADER,
} from "@goat/contracts/legacyT3Names";
import {
  injectMcpAppCookieBootstrap,
  injectMcpAppCsp,
  injectMcpAppThemeBootstrap,
  MCP_APP_MAX_HTML_BYTES,
} from "@goat/shared/mcpApp";
import * as GitHubCredentials from "@goat/source-control-github/server/GitHubCredentials";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as TestClock from "effect/testing/TestClock";
import { describe, vi } from "vite-plus/test";
import { openMediaFile } from "./assets/MediaFile.ts";
import * as NativeAppIconResolver from "./assets/NativeAppIconResolver.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import { base64UrlEncode, signPayload } from "./auth/utils.ts";
import * as ServerConfig from "./config.ts";
import * as ServerHttp from "./http.ts";
import {
  assetFileResponse,
  assetResponseHeaders,
  downloadContentDisposition,
  isLoopbackHostname,
} from "./http.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";

describe("MCP app asset responses", () => {
  it.effect(
    "transforms existing snapshots only with explicit render intent and fresh metadata",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-mcp-theme-" });
        const file = path.join(directory, "app.html");
        const html = injectMcpAppCsp(
          "<html><head><script>vendor()</script></head><body>☃</body></html>",
          undefined,
        );
        yield* fs.writeFileString(file, html);
        for (const method of ["GET", "HEAD"] as const) {
          const response = HttpServerResponse.toWeb(
            yield* assetFileResponse(
              { path: file, mimeType: "text/html", renderIntent: "mcp-app" },
              "bytes=0-1",
              undefined,
              method,
            ),
          );
          const expected = injectMcpAppCookieBootstrap(injectMcpAppThemeBootstrap(html));
          expect(response.status).toBe(200);
          expect(response.headers.get("content-length")).toBe(
            String(new TextEncoder().encode(expected).byteLength),
          );
          expect(response.headers.get("etag")).toBeNull();
          expect(response.headers.get("last-modified")).toBeNull();
          expect(response.headers.get("content-security-policy")).toBe(
            "sandbox allow-scripts allow-forms allow-popups allow-downloads",
          );
          expect(yield* Effect.promise(() => response.text())).toBe(
            method === "HEAD" ? "" : expected,
          );
        }
        for (const download of [false, true]) {
          const response = HttpServerResponse.toWeb(
            yield* assetFileResponse({
              path: file,
              mimeType: "text/html",
              download,
              ...(download ? { renderIntent: "mcp-app" as const } : {}),
            }),
          );
          expect(yield* Effect.promise(() => response.text())).toBe(html);
        }
      }).pipe(Effect.provide(layerFileResponse)),
  );

  it.effect("rejects oversized captures before transforming them", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-mcp-theme-size-" });
      const file = path.join(directory, "app.html");
      yield* fs.writeFileString(file, "x".repeat(MCP_APP_MAX_HTML_BYTES + 128 * 1024 + 1));
      const response = yield* assetFileResponse({ path: file, renderIntent: "mcp-app" });
      expect(response.status).toBe(413);
    }).pipe(Effect.provide(layerFileResponse)),
  );
});

describe("browser API CORS", () => {
  it.each(["goat://app", "t3code://app", "goat-dev://app", "t3code-dev://app"])(
    "accepts credentialed desktop preflight and GET from %s in dev",
    async (origin) => {
      const layerRoute = Layer.effectDiscard(
        Effect.gen(function* () {
          const router = yield* HttpRouter.HttpRouter;
          yield* router.add("GET", "/api/environment", HttpServerResponse.empty());
        }),
      );
      const config = Layer.effect(
        ServerConfig.ServerConfig,
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          return { ...config, devUrl: new URL("http://localhost:5733") };
        }),
      ).pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "http-desktop-cors-" })),
      );
      const layerApp = Layer.merge(layerRoute, ServerHttp.layerBrowserApiCors).pipe(
        Layer.provide(config),
        Layer.provide(NodeServices.layer),
      );
      const { handler, dispose } = HttpRouter.toWebHandler(layerApp, { disableLogger: true });
      try {
        for (const method of ["OPTIONS", "GET"]) {
          const response = await handler(
            new Request("http://localhost:3773/api/environment", {
              method,
              headers: {
                origin,
                ...(method === "OPTIONS"
                  ? {
                      "access-control-request-method": "GET",
                      "access-control-request-headers": "authorization, dpop",
                    }
                  : {}),
              },
            }),
          );
          expect(response.status).toBe(204);
          expect(response.headers.get("access-control-allow-origin")).toBe(origin);
          expect(response.headers.get("access-control-allow-credentials")).toBe("true");
        }
      } finally {
        await dispose();
      }
    },
  );

  it("accepts protocol negotiation with authenticated browser headers", async () => {
    const layerRoute = Layer.effectDiscard(
      Effect.gen(function* () {
        const router = yield* HttpRouter.HttpRouter;
        yield* router.add("GET", "/api/environment", HttpServerResponse.empty());
      }),
    );
    const layerApp = Layer.merge(layerRoute, ServerHttp.layerBrowserApiCors).pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "http-cors-test-" })),
      Layer.provide(NodeServices.layer),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(layerApp, { disableLogger: true });

    try {
      const response = await handler(
        new Request("https://backend.example/api/environment", {
          method: "OPTIONS",
          headers: {
            origin: "https://app.exa.test",
            "access-control-request-method": "GET",
            "access-control-request-headers": [
              ORCHESTRATION_PROTOCOL_HEADER,
              LEGACY_ORCHESTRATION_PROTOCOL_HEADER,
              "authorization",
              "dpop",
            ].join(", "),
          },
        }),
      );

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      const allowedHeaders = new Set(
        (response.headers.get("access-control-allow-headers") ?? "")
          .split(",")
          .map((header) => header.trim().toLowerCase()),
      );
      expect(allowedHeaders.has(ORCHESTRATION_PROTOCOL_HEADER)).toBe(true);
      expect(allowedHeaders.has(LEGACY_ORCHESTRATION_PROTOCOL_HEADER)).toBe(true);
      expect(allowedHeaders.has("authorization")).toBe(true);
      expect(allowedHeaders.has("dpop")).toBe(true);
    } finally {
      await dispose();
    }
  });
});

const layerFileResponse = Layer.mergeAll(NodeHttpPlatform.layer, NodeServices.layer);

const makeStaticRequest = Effect.fn("HttpTest.makeStaticRequest")(function* (staticDir: string) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const layerApp = Layer.merge(
    ServerHttp.layerStaticAndDevRoute,
    ServerHttp.layerHttpCompression,
  ).pipe(Layer.provideMerge(NodeHttpPlatform.layer));
  // HttpRouter.serve reuses services from the layers around it before the
  // app's own, and NodeHttpServer.layerTest brings a real FileSystem, so the
  // caller's FileSystem and static directory go between the two.
  const services = yield* Layer.build(
    HttpRouter.serve(layerApp, { disableListenLog: true }).pipe(
      Layer.provideMerge(ServerConfig.layer({ ...config, staticDir })),
      Layer.provideMerge(Layer.succeed(FileSystem.FileSystem, fileSystem)),
      Layer.provideMerge(NodeHttpServer.layerTest),
    ),
  );
  const client = Context.get(services, HttpClient.HttpClient);
  return (resource: string, options?: HttpClientRequest.Options) =>
    client.execute(HttpClientRequest.make(options?.method ?? "GET")(resource, options));
});

it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "goat-static-http-test-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
)("static HTTP responses", (it) => {
  it.effect("revalidates non-HTML files and returns changed contents", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-static-cache-" });
      const assetPath = path.join(staticDir, "app.js");
      yield* fs.writeFileString(assetPath, 'export const build = "first";');
      const request = yield* makeStaticRequest(staticDir);

      const initial = yield* request("/app.js");
      expect(initial.status).toBe(200);
      expect(yield* initial.text).toContain("first");
      const etag = initial.headers["etag"]!;
      const lastModified = initial.headers["last-modified"]!;
      expect(etag).toBeTruthy();
      expect(lastModified).toBeTruthy();
      for (const headers of [
        { "if-none-match": etag },
        { "if-none-match": etag.replace(/^W\//, "") },
        { "if-none-match": `"other", ${etag}` },
        { "if-none-match": "*" },
        { "if-modified-since": lastModified },
      ]) {
        const response = yield* request("/app.js", { headers });
        expect(response.status).toBe(304);
        expect(response.headers["etag"]).toBe(etag);
        expect(response.headers["cache-control"]).toBe("no-cache");
        expect(yield* response.text).toBe("");
      }
      const mismatched = yield* request("/app.js", {
        headers: { "if-none-match": '"another-build"', "if-modified-since": lastModified },
      });
      expect(mismatched.status).toBe(200);
      expect(yield* mismatched.text).toContain("first");

      yield* fs.writeFileString(assetPath, 'export const build = "the next build";');
      const changed = yield* request("/app.js", { headers: { "if-none-match": etag } });
      expect(changed.status).toBe(200);
      expect(changed.headers["etag"]).not.toBe(etag);
      expect(yield* changed.text).toContain("next build");
    }),
  );

  it.effect("serves static files without handles and skips fallback reads for HEAD and 304", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-static-no-open-" });
      const filePath = path.join(staticDir, "app.txt");
      const body = "packaged asset";
      yield* fs.writeFileString(filePath, body);
      let reads = 0;
      // Electron asar files can be statted and read even when opening a handle fails.
      const fileSystem = FileSystem.FileSystem.of({
        ...fs,
        open: (candidate, options) =>
          candidate === filePath
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "NotFound",
                  module: "FileSystem",
                  method: "open",
                  pathOrDescriptor: candidate,
                }),
              )
            : fs.open(candidate, options),
        readFile: (candidate) =>
          Effect.gen(function* () {
            if (candidate === filePath) reads += 1;
            return yield* fs.readFile(candidate);
          }),
      });
      const request = yield* makeStaticRequest(staticDir).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      );

      const get = yield* request("/app.txt");
      expect(get.status).toBe(200);
      expect(yield* get.text).toBe(body);
      expect(reads).toBeGreaterThan(0);
      const readsAfterGet = reads;
      const head = yield* request("/app.txt", { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(yield* head.text).toBe("");
      expect(reads).toBe(readsAfterGet);
      const unchanged = yield* request("/app.txt", {
        headers: { "if-none-match": get.headers["etag"]! },
      });
      expect(unchanged.status).toBe(304);
      expect(yield* unchanged.text).toBe("");
      expect(reads).toBe(readsAfterGet);
    }),
  );

  it.effect("serves replacement bytes with matching static fallback length and validators", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-static-replaced-" });
      const filePath = path.join(staticDir, "app.txt");
      const before = DateTime.toDateUtc(DateTime.makeUnsafe("1985-10-26T08:15:00.000Z"));
      const after = DateTime.toDateUtc(DateTime.makeUnsafe("2015-10-21T16:29:00.000Z"));
      const replacement = "the replacement asset";
      const replacementPath = path.join(staticDir, "replacement.txt");
      yield* fs.writeFileString(filePath, "old");
      yield* fs.utimes(filePath, before, before);
      yield* fs.writeFileString(replacementPath, replacement);
      yield* fs.utimes(replacementPath, after, after);
      let replaceOnOpen = false;
      const fileSystem = FileSystem.FileSystem.of({
        ...fs,
        open: (candidate, options) =>
          Effect.gen(function* () {
            if (candidate !== filePath) return yield* fs.open(candidate, options);
            if (replaceOnOpen) {
              yield* fs.rename(replacementPath, filePath);
              replaceOnOpen = false;
            }
            return yield* PlatformError.systemError({
              _tag: "NotFound",
              module: "FileSystem",
              method: "open",
              pathOrDescriptor: candidate,
            });
          }),
      });
      const request = yield* makeStaticRequest(staticDir).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      );
      const initial = yield* request("/app.txt", { headers: { "accept-encoding": "identity" } });
      expect(yield* initial.text).toBe("old");

      replaceOnOpen = true;
      const response = yield* request("/app.txt", { headers: { "accept-encoding": "identity" } });
      expect(response.status).toBe(200);
      expect(response.headers).toMatchObject({
        "content-length": String(Buffer.byteLength(replacement)),
        "last-modified": after.toUTCString(),
      });
      expect(response.headers["etag"]).not.toBe(initial.headers["etag"]);
      expect(yield* response.text).toBe(replacement);
    }),
  );

  it.effect("serves changed HTML when deployments preserve its size and timestamp", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-static-html-" });
      const indexPath = path.join(staticDir, "index.html");
      const modifiedAt = DateTime.toDateUtc(DateTime.makeUnsafe("1985-10-26T08:15:00.000Z"));
      yield* fs.writeFileString(indexPath, "<html>old build</html>");
      yield* fs.utimes(indexPath, modifiedAt, modifiedAt);
      const request = yield* makeStaticRequest(staticDir);
      const initial = yield* request("/");
      expect(yield* initial.text).toBe("<html>old build</html>");
      const previousEtag = initial.headers["etag"] ?? '"previous-html"';
      const nextHtml = "<html>new build</html>";
      yield* fs.writeFileString(indexPath, nextHtml);
      yield* fs.utimes(indexPath, modifiedAt, modifiedAt);

      for (const [resource, headers] of [
        ["/", { "if-none-match": previousEtag }],
        ["/threads/example", { "if-modified-since": modifiedAt.toUTCString() }],
        ["/", { "if-none-match": "*" }],
      ] as const) {
        const response = yield* request(resource, { headers });
        expect(response.status).toBe(200);
        expect(yield* response.text).toBe(nextHtml);
        expect(response.headers["cache-control"]).toBe("no-cache");
        expect(response.headers["etag"]).toBeUndefined();
        expect(response.headers["last-modified"]).toBeUndefined();
      }
      const head = yield* request("/", {
        method: "HEAD",
        headers: { "if-none-match": previousEtag, "accept-encoding": "identity" },
      });
      expect(head.status).toBe(200);
      expect(head.headers["content-length"]).toBe(String(Buffer.byteLength(nextHtml)));
      expect(yield* head.text).toBe("");
    }),
  );

  it.effect("closes static descriptors after GET, HEAD, 304, and request cancellation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-static-close-" });
      const filePath = path.join(staticDir, "app.txt");
      const body = "file content\n".repeat(1024);
      yield* fs.writeFileString(filePath, body);
      const closed = yield* Queue.unbounded<FileSystem.File>();
      const blocked = yield* Deferred.make<void>();
      const active = new Set<FileSystem.File>();
      let blockAfterOpen = false;
      let bodyReads = 0;
      const trackedFileSystem = FileSystem.FileSystem.of({
        ...fs,
        open: (candidate, options) =>
          Effect.gen(function* () {
            if (candidate !== filePath) return yield* fs.open(candidate, options);
            let opened: FileSystem.File | undefined;
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                if (opened === undefined) return;
                active.delete(opened);
                yield* Queue.offer(closed, opened);
              }),
            );
            const file = yield* fs.open(candidate, options);
            opened = file;
            active.add(file);
            if (blockAfterOpen) {
              yield* Deferred.succeed(blocked, undefined);
              return yield* Effect.never;
            }
            return new Proxy(file, {
              get(target, key) {
                if (key === "readAlloc") {
                  return (size: number) => {
                    bodyReads += 1;
                    return target.readAlloc(size);
                  };
                }
                return Reflect.get(target, key, target);
              },
            });
          }),
      });
      const request = yield* makeStaticRequest(staticDir).pipe(
        Effect.provideService(FileSystem.FileSystem, trackedFileSystem),
      );

      const get = yield* request("/app.txt");
      expect(yield* get.text).toBe(body);
      yield* Queue.take(closed);
      expect(active.size).toBe(0);
      expect(bodyReads).toBeGreaterThan(0);
      const readsAfterGet = bodyReads;
      const head = yield* request("/app.txt", {
        method: "HEAD",
        headers: { "accept-encoding": "gzip" },
      });
      expect(head.status).toBe(200);
      expect(head.headers["content-encoding"]).toBe("gzip");
      expect(yield* head.text).toBe("");
      yield* Queue.take(closed);
      expect(active.size).toBe(0);
      expect(bodyReads).toBe(readsAfterGet);
      const unchanged = yield* request("/app.txt", {
        headers: { "if-none-match": get.headers["etag"]! },
      });
      expect(unchanged.status).toBe(304);
      yield* Queue.take(closed);
      expect(active.size).toBe(0);
      expect(bodyReads).toBe(readsAfterGet);

      blockAfterOpen = true;
      const cancelled = yield* request("/app.txt").pipe(Effect.forkChild);
      yield* Deferred.await(blocked);
      expect(active.size).toBe(1);
      yield* Fiber.interrupt(cancelled);
      yield* Queue.take(closed);
      expect(active.size).toBe(0);
    }),
  );
});

describe("signed media HTTP route", () => {
  it.effect(
    "authenticates before revalidation and derives cache freshness from the signed claims",
    () => {
      const signingKey = new Uint8Array(32).fill(7);
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-media-http-" });
        const filePath = path.join(directory, "clip.mp4");
        yield* fs.writeFileString(filePath, "0123456789");
        yield* TestClock.setTime(1_800_000_000_000);
        const canonicalPath = yield* fs.realPath(filePath);
        const file = yield* openMediaFile(canonicalPath);
        if (!file) throw new Error("Expected an opened media file");
        const makeUrl = (expiresAt: number, validSignature = true) => {
          const payload = base64UrlEncode(
            JSON.stringify({
              version: 1,
              kind: "media-file-exact",
              filePath: canonicalPath,
              device: file.info.dev.toString(),
              inode: file.info.ino.toString(),
              expiresAt,
            }),
          );
          const signature = signPayload(payload, validSignature ? signingKey : new Uint8Array(32));
          return `http://localhost/api/assets/${payload}.${signature}/clip.mp4`;
        };
        const app = yield* HttpRouter.toHttpEffect(ServerHttp.layerAssetRoute);
        const request = (url: string, method = "GET", headers: Record<string, string> = {}) =>
          app.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(new Request(url, { method, headers })),
            ),
            Effect.map(HttpServerResponse.toWeb),
          );
        const url = makeUrl(1_800_000_005_900);
        const initial = yield* request(url);
        expect(initial.status).toBe(200);
        expect(initial.headers.get("cache-control")).toBe("private, max-age=5, must-revalidate");
        const etag = initial.headers.get("etag")!;
        const lastModified = initial.headers.get("last-modified")!;
        expect(yield* Effect.promise(() => initial.text())).toBe("0123456789");
        for (const method of ["GET", "HEAD"]) {
          for (const headers of [
            { "if-none-match": etag },
            { "if-modified-since": lastModified },
          ]) {
            const unchanged = yield* request(url, method, headers);
            expect(unchanged.status).toBe(304);
            expect(unchanged.headers.get("etag")).toBe(etag);
            expect(yield* Effect.promise(() => unchanged.text())).toBe("");
          }
        }
        yield* TestClock.adjust("2 seconds");
        const partial = yield* request(url, "GET", { range: "bytes=2-4" });
        expect(partial.status).toBe(206);
        expect(partial.headers.get("cache-control")).toBe("private, max-age=3, must-revalidate");
        expect(yield* Effect.promise(() => partial.text())).toBe("234");
        for (const deniedUrl of [makeUrl(1_800_000_000_000), makeUrl(1_800_000_060_000, false)]) {
          const denied = yield* request(deniedUrl, "GET", { "if-none-match": "*" });
          expect(denied.status).toBe(404);
          expect(denied.headers.get("etag")).toBeNull();
        }
        yield* TestClock.adjust("4 seconds");
        const expired = yield* request(url, "GET", { "if-none-match": etag });
        expect(expired.status).toBe(404);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            FetchHttpClient.layer,
            ServerConfig.layerTest(process.cwd(), { prefix: "goat-media-http-config-" }),
            Layer.mock(ServerSecretStore.ServerSecretStore)({
              getOrCreateRandom: () => Effect.succeed(signingKey),
            }),
            Layer.mock(Orchestrator.OrchestratorV2)({}),
            Layer.mock(WorkspacePaths.WorkspacePaths)({}),
            Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({}),
            Layer.mock(NativeAppIconResolver.NativeAppIconResolver)({}),
            Layer.mock(GitHubCredentials.GitHubCredentials)({}),
          ).pipe(Layer.provide(NodeServices.layer), Layer.provideMerge(layerFileResponse)),
        ),
      );
    },
  );
});

/** A guarded response closes its descriptor, so each request opens a fresh one, as the server does. */
const mediaAsset = (
  path: string,
  guarded: boolean,
  extra: { readonly mimeType: string; readonly expiresAt?: number },
) =>
  Effect.gen(function* () {
    if (!guarded) return { path, ...extra };
    const file = yield* openMediaFile(path);
    if (!file) throw new Error("Expected an opened media file");
    return { path, file, ...extra };
  });

describe("video asset byte ranges", () => {
  it.effect("uses current descriptor metadata after an in-place truncate or extension", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-guarded-current-stat-" });
      const filePath = path.join(directory, "clip.mp4");
      for (const [contents, range, method, expected, status, contentRange] of [
        ["1234", undefined, "GET", "1234", 200, null],
        ["0123456789abcdef", undefined, "GET", "0123456789abcdef", 200, null],
        ["1234", "bytes=4-", "GET", "", 416, "bytes */4"],
        ["1234", "bytes=1-20", "GET", "234", 206, "bytes 1-3/4"],
        ["0123456789abcdef", "bytes=10-", "GET", "abcdef", 206, "bytes 10-15/16"],
        ["0123456789abcdef", undefined, "HEAD", "", 200, null],
        ["", undefined, "GET", "", 200, null],
        ["", "bytes=0-1", "GET", "", 416, "bytes */0"],
      ] as const) {
        yield* fs.writeFileString(filePath, "0123456789");
        const canonicalPath = yield* fs.realPath(filePath);
        const file = yield* openMediaFile(canonicalPath);
        if (!file) throw new Error("Expected an opened media file");
        yield* fs.writeFileString(filePath, contents);
        const response = HttpServerResponse.toWeb(
          yield* assetFileResponse(
            { path: canonicalPath, file, mimeType: "video/mp4" },
            range,
            undefined,
            method,
          ),
        );
        expect(response.status).toBe(status);
        expect(response.headers.get("content-range")).toBe(contentRange);
        if (status !== 416) {
          expect(response.headers.get("content-length")).toBe(
            String(method === "HEAD" ? contents.length : expected.length),
          );
        }
        expect(yield* Effect.promise(() => response.text())).toBe(expected);
      }
    }).pipe(Effect.provide(layerFileResponse)),
  );

  it.effect(
    "rejects unaddressable ranges before streaming and preserves small ranges on large files",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "goat-guarded-offset-limit-",
        });
        const filePath = path.join(directory, "clip.mp4");
        yield* fs.writeFileString(filePath, "0123456789");
        const canonicalPath = yield* fs.realPath(filePath);
        const unsafeOffset = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
        const size = unsafeOffset + 32n;
        for (const [range, status] of [
          [`bytes=${unsafeOffset}-${unsafeOffset}`, 416],
          [`bytes=0-${unsafeOffset}`, 416],
          ["bytes=-1", 416],
          [undefined, 413],
          ["bytes=0-1", 206],
        ] as const) {
          const file = yield* openMediaFile(canonicalPath);
          if (!file) throw new Error("Expected an opened media file");
          const info = yield* Effect.promise(() => file.handle.stat({ bigint: true }));
          info.size = size;
          const statSpy = vi.spyOn(file.handle, "stat").mockResolvedValue(info);
          yield* Effect.addFinalizer(() => Effect.sync(() => statSpy.mockRestore()));
          const response = HttpServerResponse.toWeb(
            yield* assetFileResponse({ path: canonicalPath, file, mimeType: "video/mp4" }, range),
          );
          expect(response.status).toBe(status);
          if (status === 416) {
            expect(response.headers.get("content-range")).toBe(`bytes */${size}`);
            expect(yield* Effect.promise(() => response.text())).toBe("");
          } else if (status === 206) {
            expect(response.headers.get("content-range")).toBe(`bytes 0-1/${size}`);
            expect(yield* Effect.promise(() => response.text())).toBe("01");
          } else {
            expect(yield* Effect.promise(() => response.text())).toBe(
              "File is too large to preview.",
            );
          }
        }
      }).pipe(Effect.provide(layerFileResponse)),
  );

  it.effect("keeps attachment media out of the cache once its signed URL expires", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-attachment-media-" });
      const filePath = path.join(directory, "audio.wav");
      yield* fs.writeFileString(filePath, "RIFF");
      const canonicalPath = yield* fs.realPath(filePath);
      const response = HttpServerResponse.toWeb(
        yield* assetFileResponse({ path: canonicalPath, mimeType: "audio/wav" }),
      );
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("accept-ranges")).toBe("bytes");
    }).pipe(Effect.provide(layerFileResponse)),
  );

  it.effect("bounds full and partial media freshness by the signed expiry", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-media-cache-" });
      const filePath = path.join(directory, "clip.mp4");
      yield* fs.writeFileString(filePath, "0123456789");
      yield* TestClock.setTime(1_800_000_000_000);
      for (const guarded of [false, true]) {
        const canonicalPath = yield* fs.realPath(filePath);
        for (const range of [undefined, "bytes=2-4"]) {
          const asset = yield* mediaAsset(canonicalPath, guarded, {
            mimeType: "video/mp4",
            expiresAt: 1_800_000_005_900,
          });
          const response = HttpServerResponse.toWeb(yield* assetFileResponse(asset, range));
          expect(response.status).toBe(range ? 206 : 200);
          expect(response.headers.get("cache-control")).toBe("private, max-age=5, must-revalidate");
          expect(response.headers.get("etag")).toMatch(
            guarded ? /^"[\da-f]+(?:-[\da-f]+){3}"$/ : /^W\/"[\da-f]+-[\da-f]+"$/,
          );
          expect(response.headers.get("last-modified")).not.toBeNull();
          expect(yield* Effect.promise(() => response.text())).toBe(range ? "234" : "0123456789");
        }
      }
      for (const expiresAt of [1_799_999_999_000, 1_800_000_000_000, 1_800_000_000_999]) {
        const response = HttpServerResponse.toWeb(
          yield* assetFileResponse({ path: filePath, mimeType: "audio/wav", expiresAt }),
        );
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(yield* Effect.promise(() => response.text())).toBe("0123456789");
      }
    }).pipe(Effect.provide(layerFileResponse)),
  );

  it.effect("revalidates GET and HEAD before processing ranges or reading the media body", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-media-conditional-" });
      const filePath = path.join(directory, "clip.mp4");
      yield* fs.writeFileString(filePath, "0123456789");
      yield* fs.utimes(
        filePath,
        DateTime.toDateUtc(DateTime.makeUnsafe(1_700_000_000_000)),
        DateTime.toDateUtc(DateTime.makeUnsafe(1_700_000_000_000)),
      );
      yield* TestClock.setTime(1_800_000_000_000);
      for (const guarded of [false, true]) {
        const canonicalPath = yield* fs.realPath(filePath);
        const open = () =>
          mediaAsset(canonicalPath, guarded, {
            mimeType: "video/mp4",
            expiresAt: 1_800_000_060_000,
          });
        const initial = HttpServerResponse.toWeb(yield* assetFileResponse(yield* open()));
        const etag = initial.headers.get("etag")!;
        // The same tag in the other strength still matches under weak comparison.
        const otherStrength = etag.startsWith("W/") ? etag.slice(2) : `W/${etag}`;
        expect(yield* Effect.promise(() => initial.text())).toBe("0123456789");
        let bodyReads = 0;
        const mtime = "Tue, 14 Nov 2023 22:13:20 GMT";
        for (const method of ["GET", "HEAD"] as const) {
          for (const [conditions, status] of [
            [{ ifNoneMatch: etag }, 304],
            [{ ifNoneMatch: otherStrength }, 304],
            [{ ifNoneMatch: `"other", ${etag}` }, 304],
            [{ ifNoneMatch: "*" }, 304],
            [{ ifNoneMatch: etag, ifModifiedSince: "Mon, 13 Nov 2023 22:13:20 GMT" }, 304],
            [{ ifModifiedSince: mtime }, 304],
            [{ ifModifiedSince: "Wed, 15 Nov 2023 22:13:20 GMT" }, 304],
            [{ ifNoneMatch: '"other"', ifModifiedSince: mtime }, method === "HEAD" ? 200 : 416],
            [{ ifModifiedSince: "Mon, 13 Nov 2023 22:13:20 GMT" }, method === "HEAD" ? 200 : 416],
            [{ ifModifiedSince: "invalid" }, method === "HEAD" ? 200 : 416],
          ] as const) {
            const asset = yield* open();
            const readSpy =
              "file" in asset ? vi.spyOn(asset.file.handle, "createReadStream") : undefined;
            const response = HttpServerResponse.toWeb(
              yield* assetFileResponse(asset, "bytes=100-", undefined, method, conditions),
            );
            bodyReads += readSpy?.mock.calls.length ?? 0;
            expect(response.status).toBe(status);
            expect(response.headers.get("etag")).toBe(etag);
            expect(response.headers.get("last-modified")).toBe(mtime);
            if (status === 304) {
              expect(response.headers.get("content-range")).toBeNull();
              expect(response.headers.get("content-length")).toBeNull();
              expect(response.headers.get("cache-control")).toBe(
                "private, max-age=60, must-revalidate",
              );
            }
            expect(yield* Effect.promise(() => response.text())).toBe("");
          }
        }
        expect(bodyReads).toBe(0);
      }
    }).pipe(Effect.provide(layerFileResponse)),
  );

  it.effect("joins ranges only on an exact strong ETag for the same file revision", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-media-if-range-" });
      const filePath = path.join(directory, "clip.mp4");
      yield* fs.writeFileString(filePath, "0123456789");
      yield* fs.utimes(
        filePath,
        DateTime.toDateUtc(DateTime.makeUnsafe(1_700_000_000_000)),
        DateTime.toDateUtc(DateTime.makeUnsafe(1_700_000_000_000)),
      );
      yield* TestClock.setTime(1_800_000_000_000);
      for (const guarded of [false, true]) {
        const canonicalPath = yield* fs.realPath(filePath);
        const open = () => mediaAsset(canonicalPath, guarded, { mimeType: "video/mp4" });
        const initial = HttpServerResponse.toWeb(yield* assetFileResponse(yield* open()));
        const etag = initial.headers.get("etag")!;
        const lastModified = initial.headers.get("last-modified")!;
        expect(yield* Effect.promise(() => initial.text())).toBe("0123456789");
        expect(etag.startsWith("W/")).toBe(!guarded);
        if (guarded) {
          const joined = HttpServerResponse.toWeb(
            yield* assetFileResponse(yield* open(), "bytes=0-1", etag),
          );
          expect(joined.status).toBe(206);
          expect(joined.headers.get("content-range")).toBe("bytes 0-1/10");
          expect(yield* Effect.promise(() => joined.text())).toBe("01");
        }
        const mismatches = guarded
          ? [`W/${etag}`, lastModified, '"old"', "invalid", ""]
          : [etag, etag.slice(2), lastModified, '"old"', "invalid", ""];
        for (const ifRange of mismatches) {
          const response = HttpServerResponse.toWeb(
            yield* assetFileResponse(yield* open(), "bytes=0-1", ifRange),
          );
          expect(response.status).toBe(200);
          expect(response.headers.get("content-range")).toBeNull();
          expect(yield* Effect.promise(() => response.text())).toBe("0123456789");
        }
        yield* fs.writeFileString(filePath, "changed");
        yield* fs.utimes(
          filePath,
          DateTime.toDateUtc(DateTime.makeUnsafe(1_700_000_001_000)),
          DateTime.toDateUtc(DateTime.makeUnsafe(1_700_000_001_000)),
        );
        const changed = HttpServerResponse.toWeb(
          yield* assetFileResponse(yield* open(), undefined, undefined, "GET", {
            ifNoneMatch: etag,
          }),
        );
        expect(changed.status).toBe(200);
        expect(changed.headers.get("etag")).not.toBe(etag);
        expect(yield* Effect.promise(() => changed.text())).toBe("changed");
        yield* fs.writeFileString(filePath, "0123456789");
        yield* fs.utimes(
          filePath,
          DateTime.toDateUtc(DateTime.makeUnsafe(1_700_000_000_000)),
          DateTime.toDateUtc(DateTime.makeUnsafe(1_700_000_000_000)),
        );
      }
    }).pipe(Effect.provide(layerFileResponse)),
  );

  it.effect("closes guarded descriptors after full, HEAD, rejected, and cancelled responses", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-guarded-cleanup-" });
      const filePath = path.join(directory, "clip.mp4");
      const bytes = new Uint8Array(1024 * 1024).fill(42);
      yield* fs.writeFile(filePath, bytes);
      const canonicalPath = yield* fs.realPath(filePath);
      for (const mode of ["full", "HEAD", "rejected", "cancelled"] as const) {
        const file = yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* openMediaFile(canonicalPath);
            if (!file) throw new Error("Expected an opened media file");
            const response = HttpServerResponse.toWeb(
              yield* assetFileResponse(
                { path: canonicalPath, file, mimeType: "video/mp4" },
                mode === "rejected" ? `bytes=${bytes.length}-` : "bytes=0-",
                undefined,
                mode === "HEAD" ? "HEAD" : "GET",
              ),
            );
            if (mode === "HEAD") {
              expect(response.status).toBe(200);
              expect(response.headers.get("content-length")).toBe(String(bytes.length));
              expect(response.headers.get("content-range")).toBeNull();
              expect(yield* Effect.promise(() => response.text())).toBe("");
            } else if (mode === "rejected") {
              expect(response.status).toBe(416);
              expect(yield* Effect.promise(() => response.text())).toBe("");
            } else if (mode === "cancelled") {
              const reader = response.body!.getReader();
              const first = yield* Effect.promise(() => reader.read());
              expect(first.done).toBe(false);
              expect(first.value!.byteLength).toBeLessThan(bytes.length);
              yield* Effect.promise(() => reader.cancel());
            } else {
              expect(yield* Effect.promise(() => response.arrayBuffer())).toEqual(bytes.buffer);
            }
            return file;
          }),
        );
        expect(file.handle.fd).toBe(-1);
      }
    }).pipe(Effect.provide(layerFileResponse)),
  );

  it.effect("streams exactly the requested bytes and leaves full downloads intact", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-video-range-" });
      const file = path.join(directory, "clip.mp4");
      yield* fs.writeFileString(file, "0123456789");
      const asset = { path: file, mimeType: "video/mp4" };
      for (const [header, expected, contentRange] of [
        ["bytes=0-1", "01", "bytes 0-1/10"],
        ["bytes=4-", "456789", "bytes 4-9/10"],
        ["bytes=-3", "789", "bytes 7-9/10"],
        ["bytes=-999999999999999999999999", "0123456789", "bytes 0-9/10"],
        ["bytes=8-999999999999999999999999", "89", "bytes 8-9/10"],
      ] as const) {
        const response = HttpServerResponse.toWeb(yield* assetFileResponse(asset, header));
        expect(response.status).toBe(206);
        expect(response.headers.get("accept-ranges")).toBe("bytes");
        expect(response.headers.get("content-range")).toBe(contentRange);
        expect(response.headers.get("content-length")).toBe(String(expected.length));
        expect(yield* Effect.promise(() => response.text())).toBe(expected);
      }
      for (const header of [
        undefined,
        "items=0-1",
        "bytes=0-1,4-5",
        "bytes=8-2",
        "bytes=-",
        "bytes=bad",
      ]) {
        const response = HttpServerResponse.toWeb(yield* assetFileResponse(asset, header));
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => response.text())).toBe("0123456789");
      }
      const conditional = HttpServerResponse.toWeb(
        yield* assetFileResponse(asset, "bytes=0-1", '"old-etag"'),
      );
      expect(conditional.status).toBe(200);
      expect(yield* Effect.promise(() => conditional.text())).toBe("0123456789");
      const uppercase = HttpServerResponse.toWeb(
        yield* assetFileResponse({ ...asset, mimeType: "Video/MP4" }, "bytes=0-1"),
      );
      expect(uppercase.status).toBe(206);
      expect(yield* Effect.promise(() => uppercase.text())).toBe("01");
      const image = HttpServerResponse.toWeb(
        yield* assetFileResponse({ path: file, mimeType: "image/png" }, "bytes=0-1"),
      );
      expect(image.status).toBe(200);
      expect(image.headers.has("accept-ranges")).toBe(false);
      expect(yield* Effect.promise(() => image.text())).toBe("0123456789");
    }).pipe(Effect.provide(layerFileResponse)),
  );

  it.effect(
    "supports native audio header probes and seeking without changing explicit downloads",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-audio-range-" });
        const file = path.join(directory, "recording.wav");
        yield* fs.writeFileString(file, "0123456789");
        const asset = { path: file, mimeType: "audio/wav" };
        for (const [header, expected] of [
          ["bytes=0-1", "01"],
          ["bytes=5-", "56789"],
        ] as const) {
          const response = HttpServerResponse.toWeb(yield* assetFileResponse(asset, header));
          expect(response.status).toBe(206);
          expect(response.headers.get("content-type")).toBe("audio/wav");
          expect(response.headers.get("accept-ranges")).toBe("bytes");
          expect(response.headers.get("content-length")).toBe(String(expected.length));
          expect(yield* Effect.promise(() => response.text())).toBe(expected);
        }
        const download = HttpServerResponse.toWeb(
          yield* assetFileResponse({ ...asset, download: true, fileName: "recording.wav" }),
        );
        expect(download.status).toBe(200);
        expect(download.headers.get("content-disposition")).toContain("attachment;");
        expect(yield* Effect.promise(() => download.text())).toBe("0123456789");
      }).pipe(Effect.provide(layerFileResponse)),
  );

  it.effect("rejects ranges outside the file, including empty files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-video-range-" });
      const file = path.join(directory, "clip.mp4");
      yield* fs.writeFileString(file, "0123456789");
      for (const header of ["bytes=10-", "bytes=-0", "bytes=999999999999999999999999-"]) {
        const response = HttpServerResponse.toWeb(
          yield* assetFileResponse({ path: file, mimeType: "video/mp4" }, header),
        );
        expect(response.status).toBe(416);
        expect(response.headers.get("content-range")).toBe("bytes */10");
        expect(yield* Effect.promise(() => response.text())).toBe("");
      }
      yield* fs.writeFileString(file, "");
      const empty = HttpServerResponse.toWeb(
        yield* assetFileResponse({ path: file, mimeType: "video/mp4" }, "bytes=0-1"),
      );
      expect(empty.status).toBe(416);
      expect(empty.headers.get("content-range")).toBe("bytes */0");
    }).pipe(Effect.provide(layerFileResponse)),
  );
});

describe("assetResponseHeaders", () => {
  it("sandboxes SVG assets", () => {
    expect(assetResponseHeaders("/attachments/user-image.svg")).toMatchObject({
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "X-Content-Type-Options": "nosniff",
    });
    expect(assetResponseHeaders("/attachments/user-image.SVG")).toHaveProperty(
      "Content-Security-Policy",
    );
  });
  it("serves inline attachment documents with their declared mime type", () => {
    expect(
      assetResponseHeaders("/attachments/upload.bin", { mimeType: "application/pdf" }),
    ).toMatchObject({
      "Content-Type": "application/pdf",
    });
    expect(
      assetResponseHeaders("/attachments/upload.bin", { mimeType: "text/html" }),
    ).toMatchObject({
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups allow-downloads",
    });
  });

  it("downloads uploaded documents without executing their content", () => {
    expect(assetResponseHeaders("/attachments/upload.html", { download: true })).toMatchObject({
      "Content-Disposition": "attachment",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Type": "application/octet-stream",
    });
  });

  it("serves the real filename and mime type when the claims carry them", () => {
    expect(
      assetResponseHeaders("/attachments/thread-1-abc-pdf.pdf", {
        download: true,
        fileName: "Q3 report.pdf",
        mimeType: "application/pdf",
      }),
    ).toMatchObject({
      "Content-Disposition": 'attachment; filename="Q3 report.pdf"',
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Type": "application/pdf",
    });
  });

  it("keeps renderable mime types as octet-stream downloads", () => {
    for (const mimeType of [
      "text/html",
      "text/xml",
      "image/svg+xml",
      "application/xhtml+xml",
      "application/rss+xml",
      "APPLICATION/XML",
      "IMAGE/SVG+XML",
      "application/xml-dtd",
      "application/xml-external-parsed-entity",
      "not a mime",
    ]) {
      expect(
        assetResponseHeaders("/attachments/upload.bin", { download: true, mimeType }),
      ).toHaveProperty("Content-Type", "application/octet-stream");
    }
  });
});

describe("downloadContentDisposition", () => {
  it("quotes plain names and strips quotes and control characters", () => {
    expect(downloadContentDisposition("report.pdf")).toBe('attachment; filename="report.pdf"');
    expect(downloadContentDisposition('we"ird\n.pdf')).toBe('attachment; filename="we_ird_.pdf"');
  });

  it("adds an RFC 5987 encoded name for non-ASCII filenames", () => {
    expect(downloadContentDisposition("répört.pdf")).toBe(
      `attachment; filename="r_p_rt.pdf"; filename*=UTF-8''r%C3%A9p%C3%B6rt.pdf`,
    );
    expect(downloadContentDisposition("résumé'(*).pdf")).toBe(
      `attachment; filename="r_sum_'(*).pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%27%28%2A%29.pdf`,
    );
  });

  it("does not throw on unpaired surrogates in the filename", () => {
    expect(downloadContentDisposition("bad\ud800name.pdf")).toBe(
      `attachment; filename="bad_name.pdf"; filename*=UTF-8''bad%EF%BF%BDname.pdf`,
    );
  });
});

describe("SSH activity HTTP", () => {
  it.each([
    { peer: "127.0.0.1", status: 200 },
    { peer: "192.0.2.1", status: 403 },
  ])(
    "returns the activity response for peer $peer with status $status",
    async ({ peer, status }) => {
      const Etag = await import("effect/http/Etag");
      const HttpApi = await import("effect/http-api/HttpApi");
      const HttpApiBuilder = await import("effect/http-api/HttpApiBuilder");
      const { EnvironmentHttpApi, EnvironmentId } = await import("@goat/contracts");
      const ServerEnvironment = await import("./environment/ServerEnvironment.ts");
      const Sqlite = await import("./persistence/Sqlite.ts");
      const descriptor = {
        environmentId: EnvironmentId.make("test"),
        label: "Test",
        platform: { os: "linux" as const, arch: "x64" as const },
        serverVersion: "1.0.0",
        capabilities: { repositoryIdentity: false },
      };
      const layerApp = HttpApiBuilder.layer(
        HttpApi.make("environment").add(EnvironmentHttpApi.groups.metadata),
      ).pipe(
        Layer.provide(ServerHttp.layerServerEnvironmentHttpApi),
        Layer.provide(
          Layer.succeed(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(EnvironmentId.make("test")),
            getDescriptor: Effect.succeed(descriptor),
          }),
        ),
        Layer.provide(Sqlite.layerMemory),
        Layer.provide(Etag.layer),
        Layer.provide(NodeHttpPlatform.layer),
        Layer.provide(NodeServices.layer),
      );
      const { HttpServerRequest } = await import("effect/http");
      const { handler, dispose } = HttpRouter.toWebHandler(layerApp, {
        disableLogger: true,
        middleware: (effect) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            return yield* effect.pipe(
              Effect.provideService(
                HttpServerRequest.HttpServerRequest,
                request.modify({ remoteAddress: Option.some(peer) }),
              ),
            );
          }),
      });
      try {
        for (const route of [LEGACY_ENVIRONMENT_PATH, GOAT_ENVIRONMENT_PATH]) {
          const response = await handler(new Request(`http://127.0.0.1${route}`), Context.empty());
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual(descriptor);
        }
        for (const route of [LEGACY_ACTIVITY_PATH, GOAT_ACTIVITY_PATH]) {
          const response = await handler(new Request(`http://127.0.0.1${route}`), Context.empty());
          expect(response.status).toBe(status);
          if (status === 403) {
            expect(await response.json()).toEqual({
              _tag: "EnvironmentHttpForbiddenError",
              message: "SSH activity requires a loopback peer.",
            });
            continue;
          }
          expect(await response.json()).toEqual({
            activity: "idle",
            blockers: [],
            serverVersion: (await import("../package.json", { with: { type: "json" } })).default
              .version,
            pid: process.pid,
          });
        }
      } finally {
        await dispose();
      }
    },
  );
});

it.effect("serves SSH activity to a real IPv4-mapped loopback peer", () =>
  Effect.gen(function* () {
    const HttpApi = yield* Effect.promise(() => import("effect/http-api/HttpApi"));
    const HttpApiBuilder = yield* Effect.promise(() => import("effect/http-api/HttpApiBuilder"));
    const { HttpServer, HttpServerRequest } = yield* Effect.promise(() => import("effect/http"));
    const { EnvironmentHttpApi, EnvironmentId } = yield* Effect.promise(
      () => import("@goat/contracts"),
    );
    const ServerEnvironment = yield* Effect.promise(
      () => import("./environment/ServerEnvironment.ts"),
    );
    const Sqlite = yield* Effect.promise(() => import("./persistence/Sqlite.ts"));
    const { readSshServerActivity } = yield* Effect.promise(() => import("./cli/sshHelper.ts"));
    const peers: string[] = [];
    const capturePeer = HttpRouter.middleware(
      (effect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          peers.push(Option.getOrElse(request.remoteAddress, () => "unknown"));
          return yield* effect;
        }),
      { global: true },
    );
    const layerApp = HttpApiBuilder.layer(
      HttpApi.make("environment").add(EnvironmentHttpApi.groups.metadata),
    ).pipe(
      Layer.provide(ServerHttp.layerServerEnvironmentHttpApi),
      Layer.provide(
        Layer.succeed(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("native-activity-test")),
          getDescriptor: Effect.die("unused descriptor"),
        }),
      ),
      Layer.provide(Sqlite.layerMemory),
    );
    const services = yield* Layer.build(
      HttpRouter.serve(Layer.merge(layerApp, capturePeer), { disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
      ),
    );
    const server = Context.get(services, HttpServer.HttpServer);
    const origin = new URL(HttpServer.formatAddress(server.address));
    origin.hostname = "127.0.0.1";
    const client = HttpClient.mapRequest(
      Context.get(services, HttpClient.HttpClient),
      HttpClientRequest.setUrl(new URL("/.well-known/t3/activity", origin)), // goat-rename: legacy
    );
    const response = yield* client.get("/.well-known/t3/activity"); // goat-rename: legacy
    expect(response.status).toBe(200);
    expect(yield* response.json).toMatchObject({
      activity: "idle",
      pid: process.pid,
    });
    expect(peers).toEqual(["::ffff:127.0.0.1"]);
    expect(
      yield* Effect.promise(() => readSshServerActivity(Number(origin.port), process.pid)),
    ).toBe("idle");
  }).pipe(Effect.scoped),
);

it.each(["::ffff:127.0.0.1", "::ffff:127.2.3.4", "::1", "127.9.8.7"])(
  "accepts loopback peer %s",
  (peer) => {
    expect(isLoopbackHostname(peer)).toBe(true);
  },
);
it.each(["::ffff:128.0.0.1", "::ffff:127.0.0.999", "192.0.2.1", "2001:db8::1"])(
  "rejects non-loopback peer %s",
  (peer) => {
    expect(isLoopbackHostname(peer)).toBe(false);
  },
);
