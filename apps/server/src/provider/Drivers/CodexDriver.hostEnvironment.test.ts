// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import { createModelSelection } from "@goat/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { CodexDriver } from "./CodexDriver.ts";
import { layerTest } from "./CodexDriver.testkit.ts";

const windowsHost = HostProcess.Platform.defaultValue() === "win32";

it.layer(layerTest)("CodexDriver host environment", (it) => {
  // The fixture executables are POSIX shell scripts, which Windows cannot execute.
  it.effect.skipIf(windowsHost)(
    "regression #3079: status, maintenance and text generation follow the current host PATH and CODEX_HOME while instance values win",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const paths: Array<string | undefined> = [];
        const homes: Array<string | undefined> = [];
        const observedSpawner = ChildProcessSpawner.make((command) => {
          if (ChildProcess.isStandardCommand(command)) {
            paths.push(command.options.env?.PATH);
            homes.push(command.options.env?.CODEX_HOME);
          }
          return spawner.spawn(command);
        });
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
        yield* inherited.snapshot.refresh;
        expect(paths.at(-1)).toBe(newBin);
        expect(homes.at(-1)).toBe(NodePath.join(root, "other"));
        const beforeGeneration = homes.length;
        yield* inherited.textGeneration
          .generateThreadTitle({
            cwd: root,
            message: "test",
            modelSelection: createModelSelection(inherited.instanceId, "gpt-test"),
          })
          .pipe(Effect.exit);
        expect(homes.length).toBeGreaterThan(beforeGeneration);
        expect(homes.at(-1)).toBe(NodePath.join(root, "other"));
        yield* overridden.snapshot.refresh;
        expect(paths.at(-1)).toBe(oldBin);
        expect(homes.at(-1)).toBe(NodePath.join(root, "instance-home"));
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
});
