import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it, vi } from "@effect/vitest";
import { cliArchiveFileName, cliReleaseDownloadBaseUrl } from "@goat/shared/cliRelease";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import {
  downloadRuntimeArchiveWithHttps,
  RuntimeArchiveNotPublished,
  RuntimeArchiveNetworkError,
} from "./runtimeArchiveHttp.ts";
import { prepareRemoteRuntime } from "./tunnel.ts";
import { makeSuccessfulProcess, uploadTarget } from "./tunnel.fixture.ts";
import { lazyChildProcessSpawner } from "@goat/shared/testing/lazyChildProcessSpawner";

const isNotPublished = Schema.is(RuntimeArchiveNotPublished);
const isNetworkError = Schema.is(RuntimeArchiveNetworkError);
const version = "1.2.3-nightly.20261012.1";
const asset = cliArchiveFileName(version, "linux-x64");
const bytes = new Uint8Array([0, 128, 255]);
const digest = "5240672d7b51756b829ad0ef8d9468b7a078afa2f410484fd3892dab47becb72";

describe("public HTTPS SSH runtime supply", () => {
  it.effect.each(["content-length", "streamed"] as const)(
    "caps %s bytes before publishing an oversized archive",
    (mode) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        let cancelled = false;
        let reads = 0;
        const chunk = new Uint8Array(1024 * 1024);
        const fetchImpl: typeof fetch = async (url) =>
          String(url).endsWith("SHA256SUMS")
            ? new Response(`${digest}  ${asset}\n`)
            : new Response(
                new ReadableStream<Uint8Array>({
                  pull(controller) {
                    reads++;
                    controller.enqueue(chunk);
                  },
                  cancel() {
                    cancelled = true;
                  },
                }),
                {
                  headers:
                    mode === "content-length"
                      ? { "content-length": String(256 * 1024 * 1024 + 1) }
                      : {},
                },
              );
        const result = yield* Effect.result(
          downloadRuntimeArchiveWithHttps(directory, version, "linux-x64", fetchImpl),
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) assert.include(result.failure.message, "256 MiB");
        assert.isTrue(cancelled);
        assert.isAtMost(reads, mode === "content-length" ? 1 : 258);
        assert.deepEqual(yield* fs.readDirectory(directory), []);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("verifies and caches public bytes; subsequent acquisition reads the cache", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const urls: string[] = [];
      const fetchImpl: typeof fetch = async (url) => {
        urls.push(String(url));
        return String(url).endsWith("SHA256SUMS")
          ? new Response(`${digest}  ${asset}\n`)
          : new Response(bytes);
      };
      const first = yield* downloadRuntimeArchiveWithHttps(
        directory,
        version,
        "linux-x64",
        fetchImpl,
      );
      const second = yield* downloadRuntimeArchiveWithHttps(
        directory,
        version,
        "linux-x64",
        fetchImpl,
      );
      assert.deepEqual(first, second);
      assert.deepEqual(first.bytes, bytes);
      assert.deepEqual(urls, [
        `${cliReleaseDownloadBaseUrl(version)}/SHA256SUMS`,
        `${cliReleaseDownloadBaseUrl(version)}/${asset}`,
      ]);
      assert.equal(
        yield* fs.readFileString(`${directory}/${asset}.sha256`),
        `${digest}  ${asset}\n`,
      );
      assert.deepEqual(
        (yield* fs.readDirectory(directory)).sort(),
        [asset, `${asset}.sha256`].sort(),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("checksum mismatch publishes neither archive nor sidecar", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const fetchImpl: typeof fetch = async (url) =>
        String(url).endsWith("SHA256SUMS")
          ? new Response(`${"0".repeat(64)}  ${asset}\n`)
          : new Response(bytes);
      const result = yield* Effect.result(
        downloadRuntimeArchiveWithHttps(directory, version, "linux-x64", fetchImpl),
      );
      assert.isTrue(Result.isFailure(result));
      assert.deepEqual(yield* fs.readDirectory(directory), []);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("a missing public asset is typed not-published", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const error = yield* downloadRuntimeArchiveWithHttps(
        directory,
        version,
        "linux-x64",
        async () => new Response(null, { status: 404 }),
      ).pipe(Effect.flip);
      assert.isTrue(isNotPublished(error));
      assert.deepEqual(yield* fs.readDirectory(directory), []);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("network failure stays typed and leaves no published cache entry", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const error = yield* downloadRuntimeArchiveWithHttps(
        directory,
        version,
        "linux-x64",
        async () => {
          throw new TypeError("fixture network failure");
        },
      ).pipe(Effect.flip);
      assert.isTrue(isNetworkError(error));
      assert.deepEqual(yield* fs.readDirectory(directory), []);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("missing asset falls back to local gh before uploading verified bytes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const calls: string[] = [];
      const spawner = lazyChildProcessSpawner((command) =>
        Effect.gen(function* () {
          if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected command");
          if (command.command === "gh") {
            calls.push("gh");
            const staging = command.args[command.args.indexOf("--dir") + 1]!;
            yield* fs.writeFile(`${staging}/${asset}`, bytes);
            yield* fs.writeFileString(`${staging}/SHA256SUMS`, `${digest}  ${asset}\n`);
            return makeSuccessfulProcess("");
          }
          if (command.args.includes("-c")) {
            calls.push("upload");
            return makeSuccessfulProcess("");
          }
          return makeSuccessfulProcess('{"platform":"linux","arch":"x64","ready":false}');
        }),
      );
      vi.stubGlobal("fetch", async (url: string) => {
        calls.push("https");
        return url.endsWith("SHA256SUMS")
          ? new Response(`${digest}  ${asset}\n`)
          : new Response(null, { status: 404 });
      });
      try {
        yield* prepareRemoteRuntime(
          uploadTarget,
          {},
          { archiveVersion: version, archiveDirectory: directory },
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        assert.deepEqual(calls, ["https", "https", "gh", "upload"]);
      } finally {
        vi.unstubAllGlobals();
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
