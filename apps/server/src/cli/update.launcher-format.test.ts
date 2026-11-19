import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { repointLauncher } from "./update.ts";
import { writePosixLauncher } from "../cloud/posixLauncher.ts";
import { resolveServerInstallation } from "./invocation.ts";
import { findOwnedLauncher } from "./uninstall.ts";

it.live(
  "uses a script only for a capable runtime and restores a discoverable legacy link on downgrade",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-launcher-format-" });
      const baseDir = path.join(root, "home '한글");
      yield* fs.makeDirectory(baseDir);
      const bin = path.join(baseDir, "bin");
      const versions = path.join(baseDir, "runtime/goat/versions");
      const older = path.join(versions, "1.0.0/goat");
      const newer = path.join(versions, "1.1.0/goat");
      for (const executable of [older, newer])
        yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
      yield* fs.makeDirectory(bin);
      yield* fs.writeFileString(older, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      yield* fs.writeFileString(
        newer,
        '#!/bin/sh\n[ "$1" = __ssh-helper ] && [ "$2" = launcher-capabilities ] && printf "script-launcher\\n"\n',
        { mode: 0o755 },
      );
      const launcher = path.join(bin, "goat");
      yield* fs.symlink(older, launcher);
      const update = (launchedAs: string, targetEntryPath: string) =>
        repointLauncher({ launchedAs, baseDir, targetEntryPath }).pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Environment, { PATH: bin }),
          Effect.provideService(HostProcess.WorkingDirectory, baseDir),
          Effect.provideService(HostProcess.HomeDirectory, baseDir),
        );
      assert.deepEqual(yield* update(launcher, newer), Option.some(launcher));
      assert.isTrue(
        Option.isNone(yield* fs.readLink(launcher).pipe(Effect.option)),
        "capable runtime should use a regular script",
      );
      assert.include(yield* fs.readFileString(launcher), "'\\''");
      const environment = { PATH: bin };
      const discovered = yield* resolveServerInstallation.pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.IsExecutable, true),
        Effect.provideService(HostProcess.ExecutablePath, newer),
        Effect.provideService(HostProcess.InvokedAs, newer),
        Effect.provideService(HostProcess.Environment, environment),
        Effect.provideService(HostProcess.WorkingDirectory, baseDir),
        Effect.provideService(HostProcess.HomeDirectory, baseDir),
      );
      assert.deepEqual(discovered, { kind: "goat-launcher", launcher, baseDir });
      const owned = yield* findOwnedLauncher({ launchedAs: newer, versionsDir: versions }).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Environment, environment),
        Effect.provideService(HostProcess.WorkingDirectory, baseDir),
        Effect.provideService(HostProcess.HomeDirectory, baseDir),
      );
      assert.equal(owned, launcher);
      assert.deepEqual(yield* update(newer, older), Option.some(launcher));
      assert.equal(
        yield* fs.readLink(launcher),
        older,
        "an old binary can discover the downgraded launcher with readlink",
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.live("does not replace a foreign launcher created during the capability probe", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-launcher-race-" });
    const old = path.join(baseDir, "runtime/goat/versions/1.0.0/goat");
    const target = path.join(baseDir, "runtime/goat/versions/1.1.0/goat");
    const launcher = path.join(baseDir, "bin/goat");
    for (const file of [old, target, launcher])
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(old, "old");
    yield* fs.writeFileString(target, "new");
    yield* fs.symlink(old, launcher);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const flight = writePosixLauncher(launcher, target, async () => {
      started.resolve();
      await release.promise;
      return true;
    });
    yield* Effect.promise(() => started.promise);
    yield* fs.remove(launcher);
    yield* fs.writeFileString(launcher, "foreign replacement");
    release.resolve();
    const result = yield* Effect.tryPromise({
      try: () => flight,
      catch: () => "launcher-update-failed" as const,
    }).pipe(Effect.result);
    assert.isTrue(Result.isFailure(result));
    assert.equal(yield* fs.readFileString(launcher), "foreign replacement");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.live("preserves foreign launchers and reports a missing update target", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-foreign-launcher-" });
    const versions = path.join(baseDir, "runtime/goat/versions");
    const old = path.join(versions, "1.0.0/goat");
    const missing = path.join(versions, "1.1.0/goat");
    const launcher = path.join(baseDir, "bin/goat");
    const foreign = path.join(baseDir, "foreign");
    yield* fs.makeDirectory(path.dirname(old), { recursive: true });
    yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
    yield* fs.writeFileString(old, "old runtime");
    yield* fs.writeFileString(foreign, "foreign content");
    yield* fs.symlink(foreign, launcher);
    const update = repointLauncher({
      launchedAs: launcher,
      baseDir,
      targetEntryPath: missing,
    }).pipe(Effect.provideService(HostProcess.Platform, "linux"));
    assert.isTrue(Option.isNone(yield* update));
    assert.equal(yield* fs.readLink(launcher), foreign);
    yield* fs.remove(launcher);
    yield* fs.writeFileString(launcher, "#!/bin/sh\necho foreign\n");
    assert.isTrue(Option.isNone(yield* update));
    assert.equal(yield* fs.readFileString(launcher), "#!/bin/sh\necho foreign\n");
    yield* fs.remove(launcher);
    yield* fs.symlink(old, launcher);
    const failure = yield* update.pipe(Effect.flip);
    assert.include(failure.reason, "target runtime exists");
    assert.equal(yield* fs.readLink(launcher), old);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
