// @effect-diagnostics nodeBuiltinImport:off - Effect's spawner has no windowsVerbatimArguments option.
import * as NodeChildProcess from "node:child_process";
import { guardChild } from "@goat/shared/errorGuards";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export type WindowsVerbatimSpawner = (
  command: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
) => Effect.Effect<void, Error>;

const spawnDetachedVerbatim: WindowsVerbatimSpawner = (command, args, env) =>
  Effect.callback<void, Error>((resume) => {
    try {
      const child = guardChild(
        NodeChildProcess.spawn(command, args, {
          detached: true,
          env,
          stdio: "ignore",
          windowsVerbatimArguments: true,
        }),
        (error) => resume(Effect.fail(error)),
      );
      child.once("spawn", () => {
        child.unref();
        resume(Effect.void);
      });
    } catch (error) {
      resume(Effect.fail(error instanceof Error ? error : new Error("Explorer spawn failed")));
    }
  });

export const WindowsVerbatimSpawn = Context.Reference<WindowsVerbatimSpawner>(
  "goat/process/WindowsVerbatimSpawn",
  { defaultValue: () => spawnDetachedVerbatim },
);
