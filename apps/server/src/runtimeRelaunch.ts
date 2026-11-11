// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import { guardChild } from "@goat/shared/errorGuards";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { pinnedRuntimeCommand, pinnedRuntimePaths } from "./cloud/pinnedRuntime.ts";
import { SERVICE_LAUNCHER_CONTEXT_ENV } from "./cloud/serviceProtocol.ts";
import * as ServerConfig from "./config.ts";

export interface RelaunchCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export class RuntimeRelaunchError extends Schema.TaggedError<RuntimeRelaunchError>()(
  "RuntimeRelaunchError",
  { command: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Could not start ${this.command}.`;
  }
}

export type RelaunchDecision =
  | { readonly _tag: "ready"; readonly start: Effect.Effect<void, RuntimeRelaunchError> }
  | { readonly _tag: "unavailable"; readonly reason: string };

/**
 * Starts this server again on another installed version. The server holds its own arguments,
 * working directory and environment, so nothing is persisted or put on another command line.
 */
export class RuntimeRelaunch extends Context.Service<
  RuntimeRelaunch,
  { readonly prepare: (targetVersion: string) => Effect.Effect<RelaunchDecision> }
>()("goat/runtimeRelaunch") {}

const unavailable = (reason: string): RelaunchDecision => ({ _tag: "unavailable", reason });

const readsBootstrapFd = (args: ReadonlyArray<string>, env: NodeJS.ProcessEnv) =>
  env.GOAT_BOOTSTRAP_FD !== undefined ||
  args.some((arg) => arg === "--bootstrap-fd" || arg.startsWith("--bootstrap-fd="));

export const make = Effect.fn("RuntimeRelaunch.make")(function* (
  spawn: (command: RelaunchCommand) => Effect.Effect<void, RuntimeRelaunchError>,
) {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const env = yield* HostProcess.Environment;
  const cwd = yield* HostProcess.WorkingDirectory;
  // binMain reads the same slice in a single executable and under Node.
  const args = (yield* HostProcess.Arguments).slice(2);
  const prepare = Effect.fn("RuntimeRelaunch.prepare")(function* (targetVersion: string) {
    // A POSIX server started by hand belongs to its terminal; only Windows lacks a service.
    if (platform !== "win32") return unavailable("Only a Windows server restarts itself.");
    if (config.mode === "desktop") return unavailable("The desktop app manages this server.");
    if (env[SERVICE_LAUNCHER_CONTEXT_ENV] !== undefined)
      return unavailable("The background service manages this server.");
    if (readsBootstrapFd(args, env))
      return unavailable("This server read one-time startup input, so it cannot start again.");
    const paths = pinnedRuntimePaths(path, config.baseDir, targetVersion, platform);
    const installed = yield* fs.readFileString(paths.sentinelPath).pipe(
      Effect.map((sentinel) => sentinel.trim() === targetVersion),
      Effect.orElseSucceed(() => false),
    );
    if (!installed)
      return unavailable(`GOAT ${targetVersion} is not installed in this server's home.`);
    const runtime = pinnedRuntimeCommand(paths);
    return {
      _tag: "ready",
      start: spawn({ command: runtime.command, args: [...runtime.args, ...args], cwd, env }),
    } satisfies RelaunchDecision;
  });
  return RuntimeRelaunch.of({ prepare });
});

/**
 * The successor inherits this server's job object, so it lives as long as this server would
 * have. It waits on the server owner lock until this process exits before it binds the port.
 */
const spawnDetached = (input: RelaunchCommand) =>
  Effect.callback<void, RuntimeRelaunchError>((resume) => {
    const fail = (cause: unknown) =>
      resume(Effect.fail(new RuntimeRelaunchError({ command: input.command, cause })));
    try {
      const child = guardChild(
        NodeChildProcess.spawn(input.command, input.args, {
          cwd: input.cwd,
          env: input.env,
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        }),
        fail,
      );
      child.once("spawn", () => {
        child.unref();
        resume(Effect.void);
      });
    } catch (cause) {
      fail(cause);
    }
  });

export const layer = Layer.effect(RuntimeRelaunch, make(spawnDetached));
