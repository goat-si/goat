import * as NodeNet from "node:net";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import { assert, it } from "@effect/vitest";
import { CheckpointRef } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "goat-private-checkpoint-",
});
const layerGitContract = Layer.mergeAll(GitVcsDriver.layerVcs, GitVcsDriver.layer).pipe(
  Layer.provide(layerServerConfig),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const makeCheckpointFixture = Effect.fn("makeCheckpointFixture")(function* (
  driver: Effect.Success<ReturnType<typeof GitVcsDriver.makeVcsDriverShape>>,
  cwd: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = (args: ReadonlyArray<string>) =>
    driver.execute({ operation: "checkpoint-test", cwd, args });
  yield* git(["init"]);
  yield* git(["config", "user.name", "Test"]);
  yield* git(["config", "user.email", "test@test.com"]);
  yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "initial\n");
  yield* git(["add", "."]);
  yield* git(["commit", "-m", "initial"]);
  const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/test");
  yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "staged\n");
  yield* git(["add", "."]);
  yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "unstaged\n");
  return { git, checkpointRef };
});

it.effect.each(["interrupt", "timeout", "success"] as const)(
  "checkpoint bulk staging cleans operation-owned packs after $0 and can retry",
  (stop) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const liveProcess = yield* VcsProcess.VcsProcess;
      const sandbox = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bulk-checkpoint-" });
      const cwd = path.join(sandbox, "repo");
      yield* fs.makeDirectory(cwd);
      const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
      const originalCheckpoint = (yield* git(["rev-parse", checkpointRef])).stdout;
      const originalIndex = yield* fs.readFile(path.join(cwd, ".git/index"));
      const originalHead = (yield* git(["rev-parse", "HEAD"])).stdout;
      yield* git(["config", "core.bigFileThreshold", "1m"]);
      const crypto = yield* SecureRandom.SecureRandom;
      const payload = yield* crypto.randomBytes(2 * 1024 * 1024);
      yield* fs.writeFile(path.join(cwd, "a-media.bin"), payload);

      // Git keeps bulk-checkin's pack open while the next path's clean filter runs.
      // The socket is a barrier, not a race against the speed of compression.
      const connected = Promise.withResolvers<NodeNet.Socket>();
      const sockets = new Set<NodeNet.Socket>();
      let released = false;
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          NodeNet.createServer((socket) => {
            sockets.add(socket);
            connected.resolve(socket);
            // Git can run the filter again while refreshing the staged entry.
            if (released) socket.end();
          }),
        ),
        (server) =>
          Effect.sync(() => {
            for (const socket of sockets) socket.destroy();
            server.close();
          }),
      );
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
          }),
      );
      const address = server.address();
      assert.isTrue(address !== null && typeof address !== "string");
      if (address === null || typeof address === "string") return;
      const filter = path.join(sandbox, "filter.cjs");
      yield* fs.writeFileString(
        filter,
        `const s = require('node:net').connect(${address.port}, '127.0.0.1'); s.resume(); process.stdin.resume(); s.on('end', () => process.exit(0));`,
      );
      yield* git(["config", "filter.barrier.clean", `"${process.execPath}" "${filter}"`]);
      yield* git(["config", "filter.barrier.required", "true"]);
      yield* fs.writeFileString(path.join(cwd, ".gitattributes"), "z-gate filter=barrier\n");
      yield* fs.writeFileString(path.join(cwd, "z-gate"), "gate\n");
      const sharedPack = path.join(cwd, ".git/objects/pack/tmp_pack_other_operation");
      yield* fs.writeFileString(sharedPack, "owned by another Git operation");
      let objectDirectory = path.join(cwd, ".git/objects");
      const captureDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
        Effect.provideService(VcsProcess.VcsProcess, {
          run: (input) => {
            if (input.args.includes("add") && input.env?.GIT_OBJECT_DIRECTORY)
              objectDirectory = input.env.GIT_OBJECT_DIRECTORY;
            return liveProcess.run(input);
          },
        }),
      );
      const fiber = yield* captureDriver.checkpoints
        .captureCheckpoint({ cwd, checkpointRef })
        .pipe(Effect.exit, Effect.forkScoped);
      const socket = yield* Effect.promise(() => connected.promise).pipe(
        Effect.raceFirst(
          Fiber.join(fiber).pipe(
            Effect.flatMap((result) =>
              Exit.isFailure(result)
                ? Effect.failCause(result.cause)
                : Effect.die("capture ended before the filter connected"),
            ),
          ),
        ),
      );
      const packs = (yield* fs.readDirectory(path.join(objectDirectory, "pack"))).filter(
        (name) => name.startsWith("tmp_pack_") && name !== "tmp_pack_other_operation",
      );
      assert.strictEqual(packs.length, 1);
      assert.isAbove(
        Number((yield* fs.stat(path.join(objectDirectory, "pack", packs[0]!))).size),
        1024 * 1024,
      );
      // An overlapping capture publishes the same large blob while the first
      // still owns an unfinished pack. Its objects/ref must survive either exit.
      const concurrentRef = CheckpointRef.make("refs/t3/checkpoints/concurrent");
      const concurrentDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
        Effect.provideService(VcsProcess.VcsProcess, {
          run: (input) =>
            liveProcess.run({ ...input, args: ["-c", "filter.barrier.clean=cat", ...input.args] }),
        }),
      );
      yield* concurrentDriver.checkpoints.captureCheckpoint({ cwd, checkpointRef: concurrentRef });
      const concurrentOid = (yield* git(["rev-parse", concurrentRef])).stdout;
      const sharedPackNames = (yield* fs.readDirectory(path.join(cwd, ".git/objects/pack"))).sort();
      const packName = sharedPackNames.find((name) => name.endsWith(".pack"));
      assert.isDefined(packName);
      const sharedPackBytes = yield* fs.readFile(path.join(cwd, ".git/objects/pack", packName!));
      if (stop === "interrupt") yield* Fiber.interrupt(fiber);
      else if (stop === "timeout") yield* TestClock.adjust("30 seconds");
      released = true;
      socket.end();
      const result = yield* Fiber.await(fiber);
      if (stop === "interrupt")
        assert.isTrue(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause));
      else if (stop === "timeout") {
        assert.isTrue(Exit.isSuccess(result));
        if (Exit.isSuccess(result)) {
          assert.isTrue(Exit.isFailure(result.value));
          if (Exit.isFailure(result.value)) {
            const error = Cause.findErrorOption(result.value.cause);
            assert.isTrue(Option.isSome(error) && error.value._tag === "VcsProcessTimeoutError");
          }
        }
      } else assert.isTrue(Exit.isSuccess(result) && Exit.isSuccess(result.value));
      assert.deepEqual(
        (yield* fs.readDirectory(path.join(cwd, ".git/objects/pack"))).sort(),
        sharedPackNames,
      );
      assert.deepEqual(
        yield* fs.readFile(path.join(cwd, ".git/objects/pack", packName!)),
        sharedPackBytes,
      );
      assert.strictEqual((yield* git(["rev-parse", concurrentRef])).stdout, concurrentOid);
      assert.isFalse(yield* fs.exists(path.join(objectDirectory, "pack", packs[0]!)));
      assert.isFalse(yield* fs.exists(objectDirectory));
      assert.strictEqual(yield* fs.readFileString(sharedPack), "owned by another Git operation");
      if (stop !== "success")
        assert.strictEqual((yield* git(["rev-parse", checkpointRef])).stdout, originalCheckpoint);
      assert.deepEqual(yield* fs.readFile(path.join(cwd, ".git/index")), originalIndex);
      assert.strictEqual((yield* git(["rev-parse", "HEAD"])).stdout, originalHead);
      assert.deepEqual(yield* fs.readFile(path.join(cwd, "a-media.bin")), payload);

      yield* git(["config", "filter.barrier.clean", "cat"]);
      yield* captureDriver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
      assert.isFalse(yield* fs.exists(objectDirectory));
      const blob = (yield* git(["hash-object", "a-media.bin"])).stdout.trim();
      assert.strictEqual(
        (yield* git(["rev-parse", `${checkpointRef}:a-media.bin`])).stdout.trim(),
        blob,
      );
      yield* fs.remove(sharedPack);
      yield* git(["fsck", "--full"]);
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect.each(["failure", "interrupt"] as const)(
  "checkpoint publication $0 preserves existing refs and permits retry",
  (stop) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-publish-" });
      const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
      const previous = (yield* git(["show-ref"])).stdout;
      yield* fs.writeFileString(path.join(cwd, "new.txt"), "new checkpoint content\n");
      const published = yield* Deferred.make<void>();
      const captureDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          link: (source, destination) =>
            fs.link(source, destination).pipe(
              Effect.andThen(Deferred.succeed(published, undefined)),
              Effect.andThen(
                stop === "interrupt"
                  ? Effect.never
                  : Effect.fail(
                      PlatformError.systemError({
                        _tag: "BadResource",
                        module: "FileSystem",
                        method: "link",
                      }),
                    ),
              ),
            ),
        }),
      );
      const fiber = yield* captureDriver.checkpoints
        .captureCheckpoint({ cwd, checkpointRef })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.await(published);
      if (stop === "interrupt") yield* Fiber.interrupt(fiber);
      const result = yield* Fiber.await(fiber);
      if (stop === "interrupt")
        assert.isTrue(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause));
      else {
        assert.isTrue(Exit.isSuccess(result) && Exit.isFailure(result.value));
        if (Exit.isSuccess(result) && Exit.isFailure(result.value)) {
          const error = Cause.findErrorOption(result.value.cause);
          assert.isTrue(
            Option.isSome(error) &&
              error.value._tag === "VcsProcessExitError" &&
              error.value.detail === "Could not publish checkpoint objects.",
          );
        }
      }
      assert.strictEqual((yield* git(["show-ref"])).stdout, previous);
      assert.deepEqual(
        (yield* fs.readDirectory(path.join(cwd, ".git/objects"))).filter((name) =>
          name.startsWith("tmp_objdir-goat-checkpoint-"),
        ),
        [],
      );
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
      assert.strictEqual(
        (yield* git(["show", `${checkpointRef}:new.txt`])).stdout,
        "new checkpoint content\n",
      );
      yield* git(["fsck", "--full"]);
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect("checkpoint publication falls back to rename where hardlinks are unavailable", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* SecureRandom.SecureRandom;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-publish-no-links-" });
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    yield* git(["config", "core.bigFileThreshold", "1m"]);
    yield* fs.writeFile(path.join(cwd, "media.bin"), yield* crypto.randomBytes(2 * 1024 * 1024));
    const captureDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        link: () =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "link",
            }),
          ),
      }),
    );
    yield* captureDriver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
    const files = yield* fs.readDirectory(path.join(cwd, ".git/objects/pack"));
    assert.isTrue(files.some((name) => name.endsWith(".pack")));
    assert.isTrue(yield* driver.checkpoints.hasCheckpointRef({ cwd, checkpointRef }));
    assert.match((yield* git(["count-objects", "-v"])).stdout, /^garbage: 0$/m);
    yield* git(["fsck", "--full"]);
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "checkpoint publication preserves Git's shared object directory permissions",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-publish-shared-" });
      const git = (args: ReadonlyArray<string>) =>
        driver.execute({ operation: "test.shared", cwd, args });
      yield* git(["init", "--shared=0660"]);
      const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/shared");
      yield* fs.writeFileString(path.join(cwd, "shared.txt"), "new shared object\n");
      const blob = (yield* git(["hash-object", "-w", "shared.txt"])).stdout.trim();
      const directory = path.join(cwd, ".git/objects", blob.slice(0, 2));
      const expectedMode = (yield* fs.stat(directory)).mode & 0o7777;
      yield* fs.remove(directory, { recursive: true });
      assert.isFalse(yield* fs.exists(directory));
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
      assert.strictEqual((yield* fs.stat(directory)).mode & 0o7777, expectedMode);
      yield* git(["fsck", "--full"]);
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect("checkpoint capture ignores an inherited object directory", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const sandbox = yield* fs.makeTempDirectoryScoped({ prefix: "t3-inherited-objects-" });
    const cwd = path.join(sandbox, "repo");
    yield* fs.makeDirectory(cwd);
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    const unrelated = path.join(sandbox, "unrelated");
    yield* git(["init", "--bare", unrelated]);
    const unrelatedObjects = path.join(unrelated, "objects");
    // VcsProcess clears inherited selectors from git children; only the driver sees this one.
    yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef }).pipe(
      Effect.provideService(HostProcess.Environment, {
        ...(yield* HostProcess.Environment),
        GIT_OBJECT_DIRECTORY: unrelatedObjects,
      }),
    );
    assert.strictEqual((yield* git(["show", `${checkpointRef}:file.txt`])).stdout, "unstaged\n");
    assert.deepEqual(
      (yield* fs.readDirectory(unrelatedObjects)).filter(
        (name) => name !== "info" && name !== "pack",
      ),
      [],
    );
    yield* git(["fsck", "--full"]);
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect.each(["sha1", "sha256"] as const)(
  "checkpoint object isolation supports linked worktrees with $0 objects",
  (format) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const sandbox = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-worktree-" });
      // A separator must remain part of the alternate's path, not split the list.
      const platform = yield* HostProcess.Platform;
      const cwd = path.join(sandbox, platform === "win32" ? "repo;space" : 'repo:space"\u0001');
      yield* fs.makeDirectory(cwd);
      yield* driver.execute({
        operation: "test.init",
        cwd,
        args: ["init", `--object-format=${format}`],
      });
      const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
      const worktree = path.join(sandbox, "linked");
      yield* git(["worktree", "add", "-b", "linked", worktree]);
      yield* fs.writeFileString(path.join(worktree, "untracked.txt"), "linked worktree\n");
      const originalIndex = yield* fs.readFile(path.join(cwd, ".git/index"));
      yield* driver.checkpoints.captureCheckpoint({ cwd: worktree, checkpointRef });
      assert.strictEqual(
        (yield* git(["show", `${checkpointRef}:untracked.txt`])).stdout,
        "linked worktree\n",
      );
      assert.deepEqual(yield* fs.readFile(path.join(cwd, ".git/index")), originalIndex);
      yield* git(["fsck", "--full"]);
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);
