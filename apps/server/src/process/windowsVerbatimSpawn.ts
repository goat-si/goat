// @effect-diagnostics nodeBuiltinImport:off - Effect's spawner has no windowsVerbatimArguments option.
import * as NodeChildProcess from "node:child_process";
import { guardChild } from "@goat/shared/errorGuards";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

class WindowsVerbatimSpawnError extends Data.TaggedError("WindowsVerbatimSpawnError")<{
  readonly cause: unknown;
}> {}

export type WindowsVerbatimSpawner = (
  command: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
) => Effect.Effect<void, WindowsVerbatimSpawnError>;

const spawnDetachedVerbatim: WindowsVerbatimSpawner = (command, args, env) =>
  Effect.callback<void, WindowsVerbatimSpawnError>((resume) => {
    const fail = (cause: unknown) => resume(new WindowsVerbatimSpawnError({ cause }));
    try {
      const child = guardChild(
        NodeChildProcess.spawn(command, args, {
          detached: true,
          env,
          stdio: "ignore",
          windowsVerbatimArguments: true,
        }),
        fail,
      );
      child.once("spawn", () => {
        child.unref();
        resume(Effect.void);
      });
    } catch (error) {
      fail(error);
    }
  });

export const WindowsVerbatimSpawn = Context.Reference<WindowsVerbatimSpawner>(
  "goat/process/WindowsVerbatimSpawn",
  { defaultValue: () => spawnDetachedVerbatim },
);
