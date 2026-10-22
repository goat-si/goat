import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, GlobalFlag } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import { SERVICE_LAUNCHER_CONTEXT_ENV } from "../cloud/serviceProtocol.ts";
import * as ServerConfig from "../config.ts";
import { awaitLauncherLoss } from "../launcherWatch.ts";
import { runServer } from "../server.ts";
import {
  acquireServerOwnerLock,
  launcherContextFromEnvironment,
  serverOwnerTag,
  SSH_REPLACEMENT_ID_ENV,
} from "../serverOwnerLock.ts";
import { type CliServerFlags, resolveServerConfig, sharedServerCommandFlags } from "./config.ts";

const encodeCommand = Schema.encodeEffect(Schema.fromJsonString(Schema.String));

// The desktop launcher reads this process's stdout and stderr. Once it is gone,
// every log write fails, and Node turns an unhandled stream error into a crash
// that skips shutdown and leaves the ownership lock and runtime record behind.
function ignoreClosedLauncherPipe(error: NodeJS.ErrnoException): void {
  if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") throw error;
}

const runServerCommand = Effect.fn("server.runServerCommand")(function* (
  flags: CliServerFlags,
  options?: {
    readonly startupPresentation?: ServerConfig.StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
    readonly rejectRunningServer?: boolean;
  },
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveServerConfig(flags, logLevel, options);
  const environment = yield* HostProcess.Environment;
  // An invalid context fails later in ServiceLauncherClient; it must not make startup wait.
  const launcherContext = launcherContextFromEnvironment(environment[SERVICE_LAUNCHER_CONTEXT_ENV]);
  const sshReplacementId = environment[SSH_REPLACEMENT_ID_ENV]?.trim() || undefined;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      // Held until the server exits, before any layer opens the database.
      yield* acquireServerOwnerLock({
        stateDir: config.stateDir,
        owner: serverOwnerTag({
          launcherContext,
          mode: config.mode,
          sshReplacementId,
        }),
        serverRuntimeStatePath: config.serverRuntimeStatePath,
        waitForOwner: launcherContext !== undefined,
      });
      const run = runServer.pipe(Effect.provideService(ServerConfig.ServerConfig, config));
      if (config.mode !== "desktop" || config.desktopBootstrapToken === undefined)
        return yield* run;
      yield* Effect.sync(() => {
        process.stdout.on("error", ignoreClosedLauncherPipe);
        process.stderr.on("error", ignoreClosedLauncherPipe);
      });
      return yield* Effect.raceFirst(
        run,
        awaitLauncherLoss().pipe(
          // End like SIGTERM does (interrupt-only exit, so the runtime forces process exit).
          Effect.andThen(Effect.interrupt),
        ),
      );
    }),
  ).pipe(
    Effect.catchTags({
      ServerOwnerConflictError: (error) =>
        Effect.fail(new CliError.UserError({ cause: error.message })),
    }),
  );
});

export const runDefaultServerCommand = Effect.fn("server.runDefaultServerCommand")(function* (
  flags: CliServerFlags,
) {
  if (Option.isSome(flags.cwd)) {
    const cwd = flags.cwd.value.trim();
    const fs = yield* FileSystem.FileSystem;
    const platform = yield* HostProcess.Platform;
    const explicitPath =
      cwd === "." ||
      cwd === ".." ||
      cwd === "~" ||
      /[/\\]/.test(cwd) ||
      (platform === "win32" && /^[a-z]:/i.test(cwd));
    if (!explicitPath && (!(yield* fs.exists(cwd)) || (yield* fs.stat(cwd)).type !== "Directory")) {
      return yield* new CliError.UserError({
        cause: cwd,
        userMessage: `Unknown command ${yield* encodeCommand(cwd)}. Use "goat --help" for commands or an explicit path such as "goat ./my-project" for a new directory.`,
      });
    }
  }
  return yield* runServerCommand(flags, { rejectRunningServer: true });
});

export const startCommand = Command.make("start", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription("Run the GOAT server."),
  Command.withHandler((flags) => runServerCommand(flags, { rejectRunningServer: true })),
);

export const serveCommand = Command.make("serve", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription(
    "Run the GOAT server without opening a browser and print headless pairing details.",
  ),
  Command.withHandler((flags) =>
    runServerCommand(flags, {
      startupPresentation: "headless",
      forceAutoBootstrapProjectFromCwd: false,
    }),
  ),
);
