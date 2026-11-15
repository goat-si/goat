// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import { createModelSelection } from "@goat/shared/model";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import { CodexDriver } from "./CodexDriver.ts";
import { layerTest } from "./CodexDriver.testkit.ts";
import { ObservedOperation, observing } from "./CodexObservedOperation.testkit.ts";

const windowsHost = HostProcess.Platform.defaultValue() === "win32";

it.layer(layerTest)("CodexDriver host environment", (it) => {
  // The fixture executables are POSIX shell scripts, which Windows cannot execute.
  it.effect.skipIf(windowsHost)(
    "regression #3079: status, maintenance and text generation follow the current host PATH and CODEX_HOME while instance values win",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        // Both instances also launch Codex from checks they start themselves; only the launches of
        // the operation under test count.
        const launches: Array<{
          readonly operation: string | undefined;
          readonly path: string | undefined;
          readonly home: string | undefined;
        }> = [];
        const observedSpawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (ChildProcess.isStandardCommand(command)) {
              launches.push({
                operation: yield* ObservedOperation,
                path: command.options.env?.PATH,
                home: command.options.env?.CODEX_HOME,
              });
            }
            return yield* spawner.spawn(command);
          }),
        );
        const launchesOf = (operation: string) =>
          launches.filter((launch) => launch.operation === operation);
        const root = yield* fs.makeTempDirectoryScoped();
        const oldBin = NodePath.join(root, "old", "packages", "standalone", "bin");
        const newBin = NodePath.join(root, "new", "packages", "standalone", "bin");
        for (const dir of [oldBin, newBin]) {
          yield* fs.makeDirectory(dir, { recursive: true });
          if (dir === newBin) {
            yield* fs.writeFileString(NodePath.join(dir, "codex"), "#!/bin/sh\n");
            yield* fs.chmod(NodePath.join(dir, "codex"), 0o755);
          }
        }
        const host: NodeJS.ProcessEnv = { PATH: oldBin };
        const create = (override: boolean) =>
          CodexDriver.create({
            instanceId: ProviderInstanceId.make(override ? "path-override" : "path-inherit"),
            displayName: "Codex PATH test",
            enabled: true,
            environment: override
              ? [
                  { name: "PATH", value: oldBin, sensitive: false },
                  {
                    name: "CODEX_HOME",
                    value: NodePath.join(root, "instance-home"),
                    sensitive: false,
                  },
                ]
              : [{ name: "TEST_VAR", value: "1", sensitive: false }],
            config: { ...CodexDriver.defaultConfig(), binaryPath: "codex" },
          }).pipe(
            Effect.provideService(HostProcess.Environment, host),
            Effect.provideService(HostProcess.HomeDirectory, root),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observedSpawner),
          );
        const inherited = yield* create(false);
        const overridden = yield* create(true);
        const missing = yield* inherited.snapshot.resolveMaintenance();
        expect(missing.update).toBeNull();
        expect(yield* inherited.snapshot.resolveMaintenance()).toBe(missing);
        yield* fs.writeFileString(NodePath.join(oldBin, "codex"), "#!/bin/sh\n");
        yield* fs.chmod(NodePath.join(oldBin, "codex"), 0o755);
        const first = yield* inherited.snapshot.resolveMaintenance();
        expect(first.update?.executable).toBe(NodePath.join(oldBin, "codex"));
        expect(yield* inherited.snapshot.resolveMaintenance()).toBe(first);
        host.PATH = newBin;
        host.CODEX_HOME = NodePath.join(root, "other");
        expect((yield* inherited.snapshot.resolveMaintenance()).update?.executable).toBe(
          NodePath.join(newBin, "codex"),
        );
        yield* inherited.snapshot.refresh.pipe(observing("inherited check"));
        expect(launchesOf("inherited check").at(-1)).toEqual({
          operation: "inherited check",
          path: newBin,
          home: NodePath.join(root, "other"),
        });
        yield* inherited.textGeneration
          .generateThreadTitle({
            cwd: root,
            message: "test",
            modelSelection: createModelSelection(inherited.instanceId, "gpt-test"),
          })
          .pipe(Effect.exit, observing("generation"));
        expect(launchesOf("generation").length).toBeGreaterThan(0);
        expect(launchesOf("generation").at(-1)?.home).toBe(NodePath.join(root, "other"));
        yield* overridden.snapshot.refresh.pipe(observing("overridden check"));
        expect(launchesOf("overridden check").at(-1)).toEqual({
          operation: "overridden check",
          path: oldBin,
          home: NodePath.join(root, "instance-home"),
        });
        expect((yield* inherited.snapshot.resolveMaintenance()).update?.executable).toBe(
          NodePath.join(newBin, "codex"),
        );
        expect((yield* overridden.snapshot.resolveMaintenance()).update?.executable).toBe(
          NodePath.join(oldBin, "codex"),
        );
      }).pipe(Effect.scoped),
  );
  // The fixture executable is a POSIX shell script, which Windows cannot execute.
  it.effect.skipIf(windowsHost)(
    "an instance with its own Codex home setting ignores a later host CODEX_HOME",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const homes: Array<string | undefined> = [];
        const observedSpawner = ChildProcessSpawner.make((command) => {
          if (ChildProcess.isStandardCommand(command)) homes.push(command.options.env?.CODEX_HOME);
          return spawner.spawn(command);
        });
        const root = yield* fs.makeTempDirectoryScoped();
        const bin = NodePath.join(root, "bin");
        yield* fs.makeDirectory(bin, { recursive: true });
        yield* fs.writeFileString(NodePath.join(bin, "codex"), "#!/bin/sh\n");
        yield* fs.chmod(NodePath.join(bin, "codex"), 0o755);
        const host: NodeJS.ProcessEnv = { PATH: bin };
        const configured = yield* CodexDriver.create({
          instanceId: ProviderInstanceId.make("home-setting"),
          displayName: "Codex home setting test",
          enabled: true,
          environment: [],
          config: {
            ...CodexDriver.defaultConfig(),
            binaryPath: "codex",
            homePath: NodePath.join(root, "configured"),
          },
        }).pipe(
          Effect.provideService(HostProcess.Environment, host),
          Effect.provideService(HostProcess.HomeDirectory, root),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observedSpawner),
        );
        host.CODEX_HOME = NodePath.join(root, "later");
        yield* configured.snapshot.refresh;
        expect(homes.length).toBeGreaterThan(0);
        expect(homes.at(-1)).toBe(NodePath.join(root, "configured"));
      }).pipe(Effect.scoped),
  );
  // The fixture executable is a POSIX shell script, which Windows cannot execute.
  it.effect.skipIf(windowsHost)(
    "a probe timeout override the host sets after creation applies to the next skills scan",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const scanSpawned = yield* Deferred.make<void>();
        let scanInterrupted = false;
        const observedSpawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if ((yield* ObservedOperation) !== "skills scan") return yield* spawner.spawn(command);
            yield* Deferred.succeed(scanSpawned, undefined);
            return yield* Effect.never.pipe(
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  scanInterrupted = true;
                }),
              ),
            );
          }),
        );
        const root = yield* fs.makeTempDirectoryScoped();
        const bin = NodePath.join(root, "bin");
        yield* fs.makeDirectory(bin, { recursive: true });
        yield* fs.writeFileString(NodePath.join(bin, "codex"), "#!/bin/sh\n");
        yield* fs.chmod(NodePath.join(bin, "codex"), 0o755);
        const host: NodeJS.ProcessEnv = { PATH: bin };
        const instance = yield* CodexDriver.create({
          instanceId: ProviderInstanceId.make("probe-timeout"),
          displayName: "Codex probe timeout test",
          enabled: true,
          environment: [],
          config: { ...CodexDriver.defaultConfig(), binaryPath: "codex" },
        }).pipe(
          Effect.provideService(HostProcess.Environment, host),
          Effect.provideService(HostProcess.HomeDirectory, root),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observedSpawner),
        );
        const snapshotForCwd = instance.snapshotForCwd;
        if (snapshotForCwd === undefined) return yield* Effect.die("Codex scans workspaces");
        host.GOAT_CODEX_PROBE_TIMEOUT_MS = "30000";
        const scan = yield* snapshotForCwd(root).pipe(
          Effect.exit,
          observing("skills scan"),
          Effect.forkChild,
        );
        yield* Deferred.await(scanSpawned);
        yield* TestClock.adjust("25 seconds");
        expect(scanInterrupted).toBe(false);
        yield* TestClock.adjust("5 seconds");
        expect((yield* Fiber.join(scan))._tag).toBe("Failure");
        expect(scanInterrupted).toBe(true);
      }).pipe(Effect.scoped),
  );
});
