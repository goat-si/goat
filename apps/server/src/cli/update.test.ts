import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import { CLI_RELEASE_REPOSITORY } from "@goat/shared/cliRelease";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import {
  repointLauncher,
  resolveLauncherPath,
  resolveNewestRelease,
  resolveNewestVersion,
} from "./update.ts";

it.effect("authenticates each release page until the requested channel is found", () =>
  Effect.gen(function* () {
    const pages: string[] = [];
    const httpClient = HttpClient.make((request) => {
      const url = new URL(request.url);
      assert.equal(url.origin, "https://api.github.com");
      assert.equal(url.pathname, `/repos/${CLI_RELEASE_REPOSITORY}/releases`);
      assert.equal(request.headers.accept, "application/vnd.github+json");
      assert.equal(request.headers.authorization, "Bearer gh-token");
      const page = url.searchParams.get("page") ?? "";
      pages.push(page);
      const tag_name = page === "1" ? "v1.2.4-preview.20260101.1" : "v1.2.3";
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json([{ tag_name }])));
    });
    const version = yield* resolveNewestVersion({
      channel: "stable",
      baseDir: yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped(),
    }).pipe(
      Effect.provideService(HostProcess.Environment, { GH_TOKEN: "gh-token" }),
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    );
    assert.equal(version, "1.2.3");
    assert.deepStrictEqual(pages, ["1", "2"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.layer(NodeServices.layer)("goat update launcher", (it) => {
  it.effect("repoints a symlink that lives in a runtime versions tree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-update-" });
      const oldExe = path.join(root, "runtime/goat/versions/1.0.0/goat");
      const newExe = path.join(root, "runtime/goat/versions/2.0.0/goat");
      const launcher = path.join(root, "bin/goat");
      for (const file of [oldExe, newExe]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.symlink(oldExe, launcher);

      const repointed = yield* repointLauncher({
        launchedAs: launcher,
        versionsDir: path.join(root, "runtime/goat/versions"),
        targetEntryPath: newExe,
      });

      assert.deepStrictEqual(Option.getOrUndefined(repointed), launcher);
      assert.equal(yield* fs.readLink(launcher), newExe);
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("leaves a plain copy or a foreign symlink alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-update-" });
      const newExe = path.join(root, "runtime/goat/versions/2.0.0/goat");
      const copy = path.join(root, "copy/goat");
      const foreign = path.join(root, "foreign/goat");
      const elsewhere = path.join(root, "elsewhere/goat");
      const otherHome = path.join(root, "other/runtime/goat/versions/1.0.0/goat");
      const otherLauncher = path.join(root, "other/bin/goat");
      for (const file of [newExe, copy, elsewhere, otherHome]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      yield* fs.makeDirectory(path.dirname(foreign), { recursive: true });
      yield* fs.symlink(elsewhere, foreign);
      yield* fs.makeDirectory(path.dirname(otherLauncher), { recursive: true });
      yield* fs.symlink(otherHome, otherLauncher);

      for (const launchedAs of [copy, foreign, otherLauncher, undefined]) {
        const repointed = yield* repointLauncher({
          launchedAs,
          versionsDir: path.join(root, "runtime/goat/versions"),
          targetEntryPath: newExe,
        });
        assert.equal(repointed._tag, "None", launchedAs ?? "undefined");
      }
      assert.equal(yield* fs.readLink(foreign), elsewhere);
      assert.equal(yield* fs.readLink(otherLauncher), otherHome);
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("finds the launcher a bare command name resolved to on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-update-" });
      const launcher = path.join(root, "bin/t3");
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.writeFileString(launcher, "");

      const bare = yield* resolveLauncherPath.pipe(
        Effect.provideService(HostProcess.InvokedAs, "t3"),
        Effect.provideService(HostProcess.Environment, {
          PATH: `${path.join(root, "missing")}:${path.join(root, "bin")}`,
        }),
        Effect.provideService(HostProcess.WorkingDirectory, root),
      );
      const relative = yield* resolveLauncherPath.pipe(
        Effect.provideService(HostProcess.InvokedAs, "./bin/t3"),
        Effect.provideService(HostProcess.Environment, { PATH: "" }),
        Effect.provideService(HostProcess.WorkingDirectory, root),
      );
      const absent = yield* resolveLauncherPath.pipe(
        Effect.provideService(HostProcess.InvokedAs, "t3"),
        Effect.provideService(HostProcess.Environment, { PATH: path.join(root, "missing") }),
        Effect.provideService(HostProcess.WorkingDirectory, root),
      );

      assert.equal(bare, launcher);
      assert.equal(relative, launcher);
      assert.equal(absent, undefined);
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );
});

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const stableRelease = "1.2.3";
const nightlyRelease = "1.2.4-nightly.20261012.1";
const releases = [{ tag_name: `v${nightlyRelease}` }, { tag_name: `v${stableRelease}` }];

function releaseIndexHarness(
  reply: (attempt: number, url: string) => Response | Promise<Response>,
) {
  const requests: string[] = [];
  const started = Deferred.makeUnsafe<void>();
  const fetch = vi.fn<typeof globalThis.fetch>((input) => {
    const url = String(input);
    requests.push(url);
    Deferred.doneUnsafe(started, Effect.void);
    return Promise.resolve(reply(requests.length, url));
  });
  const layer = FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  );
  return { fetch, requests, layer, started };
}

it.layer(NodeServices.layer)("goat release index", (it) => {
  it.effect(
    "preserves publication metadata from HTTP and cache while keeping version-only callers",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-release-index-" });
        const publishedAt = "2026-10-01T00:00:00Z";
        const h = releaseIndexHarness(() =>
          Response.json([{ tag_name: `v${stableRelease}`, published_at: publishedAt }]),
        );
        const lookup = resolveNewestRelease({ baseDir, channel: "stable" }).pipe(
          Effect.provide(h.layer),
        );
        assert.deepEqual(yield* lookup, { version: stableRelease, publishedAt });
        assert.deepEqual(yield* lookup, { version: stableRelease, publishedAt });
        assert.equal(
          yield* resolveNewestVersion({ baseDir, channel: "stable" }).pipe(Effect.provide(h.layer)),
          stableRelease,
        );
        assert.equal(h.requests.length, 1);
      }),
  );

  it.effect("accepts old cache entries without published_at", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-release-index-" });
      yield* fs.makeDirectory(`${baseDir}/cache`);
      yield* fs.writeFileString(
        `${baseDir}/cache/release-index.json`,
        encodeJson([
          {
            repository: CLI_RELEASE_REPOSITORY,
            channel: "stable",
            cachedAt: yield* Clock.currentTimeMillis,
            releases: [{ tag_name: `v${stableRelease}` }],
          },
        ]),
      );
      const h = releaseIndexHarness(() => {
        throw new Error("old cache should be reused");
      });
      assert.deepEqual(
        yield* resolveNewestRelease({ baseDir, channel: "stable" }).pipe(Effect.provide(h.layer)),
        { version: stableRelease, publishedAt: undefined },
      );
      assert.equal(h.requests.length, 0);
    }),
  );

  it.effect.each([500, 502, 503, 403, 429, "network"] as const)(
    "retries transient %s twice with exponential backoff",
    (failure) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-release-index-" });
        const h = releaseIndexHarness((attempt) => {
          if (attempt === 3) return Response.json(releases);
          if (failure === "network") return Promise.reject(new Error("offline"));
          return Response.json(
            {
              message:
                failure === 403 ? "You have exceeded a secondary rate limit." : "unavailable",
            },
            { status: failure },
          );
        });
        const fiber = yield* resolveNewestVersion({ baseDir, channel: "nightly" }).pipe(
          Effect.provide(h.layer),
          Effect.forkChild,
        );
        yield* Deferred.await(h.started);
        yield* TestClock.adjust(0);
        assert.equal(h.requests.length, 1);
        yield* TestClock.adjust(Duration.millis(999));
        assert.equal(h.requests.length, 1);
        yield* TestClock.adjust(Duration.millis(1));
        assert.equal(h.requests.length, 2);
        yield* TestClock.adjust(Duration.seconds(2));
        assert.equal(yield* Fiber.join(fiber), nightlyRelease);
        assert.equal(h.requests.length, 3);
      }).pipe(Effect.scoped),
  );

  it.effect("retains the HTTP status after exhausting retries and suggests an exact version", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-release-index-" });
      const h = releaseIndexHarness(() => Response.json({}, { status: 503 }));
      const fiber = yield* resolveNewestVersion({ baseDir, channel: "nightly" }).pipe(
        Effect.provide(h.layer),
        Effect.result,
        Effect.forkChild,
      );
      yield* Deferred.await(h.started);
      yield* TestClock.adjust(Duration.seconds(3));
      const result = yield* Fiber.join(fiber);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.equal(result.failure.status, 503);
        assert.include(result.failure.message, "HTTP 503");
        assert.include(result.failure.message, "GOAT_VERSION");
      }
      assert.equal(h.requests.length, 3);
      assert.isFalse(yield* fs.exists(`${baseDir}/cache/release-index.json`));
    }).pipe(Effect.scoped),
  );

  it.effect.each([403, 404, 401])("does not retry permanent HTTP %s", (status) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-release-index-" });
      const h = releaseIndexHarness(() => Response.json({ message: "Forbidden" }, { status }));
      const result = yield* resolveNewestVersion({ baseDir, channel: "stable" }).pipe(
        Effect.provide(h.layer),
        Effect.result,
      );
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.equal(result.failure.status, status);
      assert.equal(h.requests.length, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("retries a 403 carrying Retry-After", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-release-index-" });
      const h = releaseIndexHarness((attempt) =>
        attempt === 1
          ? Response.json({}, { status: 403, headers: { "Retry-After": "1" } })
          : Response.json(releases),
      );
      const fiber = yield* resolveNewestVersion({ baseDir, channel: "stable" }).pipe(
        Effect.provide(h.layer),
        Effect.forkChild,
      );
      yield* Deferred.await(h.started);
      yield* TestClock.adjust(Duration.seconds(1));
      assert.equal(yield* Fiber.join(fiber), stableRelease);
      assert.equal(h.requests.length, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("caches separately by repository and channel and expires at ten minutes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-release-index-" });
      yield* fs.makeDirectory(`${baseDir}/cache`);
      const cachedAt = yield* Clock.currentTimeMillis;
      yield* fs.writeFileString(
        `${baseDir}/cache/release-index.json`,
        encodeJson([
          {
            repository: "upstream/repository",
            channel: "nightly",
            cachedAt,
            releases: [{ tag_name: "v9.0.0-nightly.20261012.1" }],
          },
        ]),
      );
      const h = releaseIndexHarness(() => Response.json(releases));
      const lookup = (channel: "nightly" | "stable") =>
        resolveNewestVersion({ baseDir, channel }).pipe(Effect.provide(h.layer));
      assert.equal(yield* lookup("nightly"), nightlyRelease);
      assert.equal(h.requests.length, 1);
      assert.equal(yield* lookup("stable"), stableRelease);
      assert.equal(h.requests.length, 2);
      yield* TestClock.adjust(Duration.millis(10 * 60 * 1000 - 1));
      assert.equal(yield* lookup("nightly"), nightlyRelease);
      assert.equal(yield* lookup("stable"), stableRelease);
      assert.equal(h.requests.length, 2);
      yield* TestClock.adjust(Duration.millis(1));
      assert.equal(yield* lookup("nightly"), nightlyRelease);
      assert.equal(h.requests.length, 3);
      const cache = yield* fs
        .readFileString(`${baseDir}/cache/release-index.json`)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))));
      assert.isArray(cache);
      assert.include(encodeJson(cache), CLI_RELEASE_REPOSITORY);
    }).pipe(Effect.scoped),
  );

  it.effect("walks pages without losing retries and caches the collected index", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-release-index-" });
      const h = releaseIndexHarness((attempt, url) =>
        new URL(url).searchParams.get("page") === "1"
          ? Response.json([{ tag_name: `v${nightlyRelease}` }])
          : attempt === 2
            ? Response.json({}, { status: 502 })
            : Response.json([{ tag_name: `v${stableRelease}` }]),
      );
      const fiber = yield* resolveNewestVersion({ baseDir, channel: "stable" }).pipe(
        Effect.provide(h.layer),
        Effect.forkChild,
      );
      yield* Deferred.await(h.started);
      yield* TestClock.adjust(Duration.seconds(1));
      assert.equal(yield* Fiber.join(fiber), stableRelease);
      assert.deepEqual(
        h.requests.map((url) => new URL(url).searchParams.get("page")),
        ["1", "2", "2"],
      );
      assert.equal(
        yield* resolveNewestVersion({ baseDir, channel: "stable" }).pipe(Effect.provide(h.layer)),
        stableRelease,
      );
      assert.equal(h.requests.length, 3);
      assert.include(
        yield* fs.readFileString(`${baseDir}/cache/release-index.json`),
        nightlyRelease,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("bounds pagination at ten pages", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-release-index-" });
      const h = releaseIndexHarness(() => Response.json([{ tag_name: `v${nightlyRelease}` }]));
      const result = yield* resolveNewestVersion({ baseDir, channel: "stable" }).pipe(
        Effect.provide(h.layer),
        Effect.result,
      );
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.equal(result.failure.failure, "unpublished");
      assert.equal(h.requests.length, 10);
    }).pipe(Effect.scoped),
  );

  it.effect("ignores a corrupt cache and a cache that cannot be written", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-release-index-" });
      const h = releaseIndexHarness(() => Response.json(releases));
      yield* fs.makeDirectory(`${baseDir}/cache`);
      yield* fs.writeFileString(`${baseDir}/cache/release-index.json`, "broken JSON");
      assert.equal(
        yield* resolveNewestVersion({ baseDir, channel: "nightly" }).pipe(Effect.provide(h.layer)),
        nightlyRelease,
      );
      yield* fs.remove(`${baseDir}/cache`, { recursive: true });
      yield* fs.writeFileString(`${baseDir}/cache`, "not a directory");
      assert.equal(
        yield* resolveNewestVersion({ baseDir, channel: "nightly" }).pipe(Effect.provide(h.layer)),
        nightlyRelease,
      );
      assert.equal(h.requests.length, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects an invalid index without retrying or caching it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-release-index-" });
      const h = releaseIndexHarness(() => Response.json({ unexpected: true }));
      const result = yield* resolveNewestVersion({ baseDir, channel: "nightly" }).pipe(
        Effect.provide(h.layer),
        Effect.result,
      );
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.equal(result.failure.failure, "invalid");
      assert.equal(h.requests.length, 1);
      assert.isFalse(yield* fs.exists(`${baseDir}/cache/release-index.json`));
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the thirty-second deadline on each retry", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-release-index-" });
      const h = releaseIndexHarness(() => new Promise<Response>(() => {}));
      const fiber = yield* resolveNewestVersion({ baseDir, channel: "nightly" }).pipe(
        Effect.provide(h.layer),
        Effect.result,
        Effect.forkChild,
      );
      yield* Deferred.await(h.started);
      yield* TestClock.adjust(Duration.seconds(29));
      assert.equal(h.requests.length, 1);
      yield* TestClock.adjust(Duration.seconds(2));
      assert.equal(h.requests.length, 2);
      yield* TestClock.adjust(Duration.seconds(32));
      assert.equal(h.requests.length, 3);
      yield* TestClock.adjust(Duration.seconds(30));
      const result = yield* Fiber.join(fiber);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.equal(result.failure.failure, "timeout");
      assert.equal(h.requests.length, 3);
    }).pipe(Effect.scoped),
  );
});
