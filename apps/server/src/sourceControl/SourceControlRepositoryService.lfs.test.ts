import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { ChildProcessSpawner } from "effect/process";
import * as ServerConfig from "../config.ts";
import type { GitCloneProgressLine } from "../project/gitCloneProgress.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import * as SourceControlRepositoryService from "./SourceControlRepositoryService.ts";

const CLONE_URLS = { url: "https://github.com/octocat/goat" };
const processOutput = () => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});
const layer = (input: { git: Partial<GitVcsDriver.GitVcsDriver["Service"]> }) =>
  SourceControlRepositoryService.layer.pipe(
    Layer.provide(Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({})),
    Layer.provide(
      Layer.mock(GitVcsDriver.GitVcsDriver)({ invalidateRefs: () => Effect.void, ...input.git }),
    ),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-lfs-test-" })),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

it.effect("reports a Git LFS download as progress only while its partial files change", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "goat-source-control-clone-lfs-" });
    const destinationPath = path.join(parent, "goat");
    const incomplete = path.join(destinationPath, ".git", "lfs", "incomplete");
    const progress = yield* Queue.unbounded<GitCloneProgressLine>();
    const firstDownloading = yield* Deferred.make<void>();
    const firstLanded = yield* Deferred.make<void>();
    const secondDownloading = yield* Deferred.make<void>();
    const secondLanded = yield* Deferred.make<void>();
    const filtering = "Filtering content:  50% (1/2), 1.50 MiB | 1.00 MiB/s";

    const clone = yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      return yield* service.cloneRepository(
        { remoteUrl: CLONE_URLS.url, destinationPath },
        { onProgress: (line) => Queue.offer(progress, line), timeoutMs: null },
      );
    }).pipe(
      Effect.provide(
        layer({
          git: {
            execute: (input) =>
              Effect.gen(function* () {
                yield* (
                  input.progress?.onStderrLine?.("Updating files: 100% (3/3), done.") ?? Effect.void
                );
                yield* fs.makeDirectory(incomplete, { recursive: true });
                yield* fs.writeFile(path.join(incomplete, "a.part"), new Uint8Array(1536 * 1024));
                yield* Deferred.succeed(firstDownloading, undefined);
                yield* Deferred.await(firstLanded);
                yield* fs.remove(path.join(incomplete, "a.part"));
                yield* fs.writeFile(path.join(incomplete, "b.part"), new Uint8Array(512 * 1024));
                yield* input.progress?.onStderrLine?.(filtering) ?? Effect.void;
                yield* Deferred.succeed(secondDownloading, undefined);
                yield* Deferred.await(secondLanded);
                yield* fs.remove(path.join(incomplete, "b.part"));
                return processOutput();
              }).pipe(Effect.orDie),
          },
        }),
      ),
      Effect.forkChild,
    );

    yield* Deferred.await(firstDownloading);
    yield* TestClock.adjust("2 seconds");
    assert.deepStrictEqual(yield* Queue.takeN(progress, 2), [
      { stage: "checkout", percent: 100, detail: null },
      {
        stage: "checkout",
        percent: null,
        detail: "Downloading Git LFS objects: 1.5 MiB in progress",
      },
    ]);

    yield* Deferred.succeed(firstLanded, undefined);
    yield* Deferred.await(secondDownloading);
    yield* TestClock.adjust("2 seconds");
    assert.deepStrictEqual(yield* Queue.takeN(progress, 2), [
      { stage: "checkout", percent: 50, detail: "1.50 MiB | 1.00 MiB/s" },
      {
        stage: "checkout",
        percent: 50,
        detail: "Downloading Git LFS objects: 0.5 MiB in progress",
      },
    ]);

    // The second object stops growing: a transfer that really stalled must stay silent.
    yield* TestClock.adjust("2 seconds");
    yield* Deferred.succeed(secondLanded, undefined);
    yield* Fiber.join(clone);
    assert.strictEqual(yield* Queue.size(progress), 0);
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
