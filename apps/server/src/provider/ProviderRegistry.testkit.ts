import {
  DEFAULT_SERVER_SETTINGS,
  ServerSettings,
  type ServerSettings as ContractServerSettings,
} from "@goat/contracts";
import { applyServerSettingsPatch } from "@goat/shared/serverSettings";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as ServerSettingsModule from "../serverSettings.ts";
const encoder = new TextEncoder();
const encodeServerSettings = Schema.encodeSync(ServerSettings);

export function mockHandle(result: { stdout: string; stderr: string; code: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout)),
    stderr: Stream.make(encoder.encode(result.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

export function layerMockSpawner(
  handler: (args: ReadonlyArray<string>) => {
    stdout: string;
    stderr: string;
    code: number;
  },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    // `ChildProcessSpawner.make` calls `spawn` while building `exitCode` and
    // `string` effects, and drivers build commands they may never run (Claude's
    // logout). Handle a command only when its effect runs, as the Node spawner does.
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as { args: ReadonlyArray<string> };
      return Effect.sync(() => mockHandle(handler(cmd.args)));
    }),
  );
}

// A Codex CLI on disk whose `app-server` and `--version` behave as `script` says.
export const writeFakeCodexCli = Effect.fn("writeFakeCodexCli")(function* (script: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-fake-codex-" });
  const binaryPath = path.join(directory, "codex");
  yield* fs.writeFileString(binaryPath, `#!/bin/sh\n${script}\n`);
  yield* fs.chmod(binaryPath, 0o755);
  return { directory, binaryPath };
});

export function makeMutableServerSettingsService(
  initial: ContractServerSettings = DEFAULT_SERVER_SETTINGS,
) {
  return Effect.gen(function* () {
    const settingsRef = yield* Ref.make(initial);
    const changes = yield* PubSub.unbounded<ContractServerSettings>();

    return {
      start: Effect.void,
      ready: Effect.void,
      getSettings: Ref.get(settingsRef),
      updateSettings: (patch) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(settingsRef);
          const next = applyServerSettingsPatch(current, patch);
          encodeServerSettings(next);
          yield* Ref.set(settingsRef, next);
          yield* PubSub.publish(changes, next);
          return next;
        }),
      updateSettingsWith: (patchFor) =>
        Ref.get(settingsRef).pipe(
          Effect.flatMap(patchFor),
          Effect.flatMap((patch) =>
            Effect.gen(function* () {
              const current = yield* Ref.get(settingsRef);
              const next = applyServerSettingsPatch(current, patch);
              encodeServerSettings(next);
              yield* Ref.set(settingsRef, next);
              yield* PubSub.publish(changes, next);
              return next;
            }),
          ),
        ),
      updateProviderInstance: (mutation, patch = {}) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(settingsRef);
          const next = ServerSettingsModule.applyProviderInstanceMutation(
            applyServerSettingsPatch(current, patch),
            mutation,
          );
          encodeServerSettings(next);
          yield* Ref.set(settingsRef, next);
          yield* PubSub.publish(changes, next);
          return next;
        }),
      checkpointReplicationPermit: () =>
        Effect.die("checkpoint replication is not used by this fixture"),
      withSettingsSnapshot: (use) => Ref.get(settingsRef).pipe(Effect.flatMap(use)),
      get streamChanges() {
        return Stream.fromPubSub(changes);
      },
      get subscribeChanges() {
        return PubSub.subscribe(changes).pipe(
          Effect.map((subscription) => Stream.fromSubscription(subscription)),
        );
      },
    } satisfies ServerSettingsModule.ServerSettingsService["Service"];
  });
}
