import * as HostProcess from "@goat/shared/HostProcess";
import { ignoreClosedPipe } from "@goat/shared/closedPipe";
import { installProcessErrorNet } from "@goat/shared/processErrorNet";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, GlobalFlag } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import { SERVICE_LAUNCHER_CONTEXT_ENV } from "../cloud/serviceProtocol.ts";
import * as ServerConfig from "../config.ts";
import { applyDevSshPolicy } from "../devSshPolicy.ts";
import { awaitLauncherLoss } from "../launcherWatch.ts";
import { runServer } from "../server.ts";
import { holdWorkspaceLeaseRegistry } from "../workspace/workspaceLeaseRegistry.ts";
import {
  acquireServerOwnerLock,
  launcherContextFromEnvironment,
  serverOwnerTag,
  SSH_REPLACEMENT_ID_ENV,
} from "../serverOwnerLock.ts";
import { type CliServerFlags, resolveServerConfig, sharedServerCommandFlags } from "./config.ts";
import {
  recoverServerWorkingDirectory,
  resolveFromOriginalWorkingDirectory,
} from "./serverWorkingDirectory.ts";

const encodeCommand = Schema.encodeEffect(Schema.fromJsonString(Schema.String));

const prepareWorkingDirectory = Effect.fn("server.prepareWorkingDirectory")(function* () {
  const result = yield* Effect.try({
    try: recoverServerWorkingDirectory,
    catch: (error) => new CliError.UserError({ cause: String(error) }),
  });
  if (result.current)
    yield* Effect.logWarning(`Working directory is inaccessible; changed to ${result.current}.`);
  return result.original;
});

const runServerCommand = Effect.fn("server.runServerCommand")(function* (
  flags: CliServerFlags,
  options?: {
    readonly startupPresentation?: ServerConfig.StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
    readonly rejectRunningServer?: boolean;
    readonly originalCwd?: string | undefined;
  },
) {
  const originalCwd = (yield* prepareWorkingDirectory()) ?? options?.originalCwd;
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveServerConfig(flags, logLevel, { ...options, originalCwd });
  const environment = yield* HostProcess.Environment;
  // Before any layer starts, so nothing in this process can reach another machine first.
  yield* applyDevSshPolicy(config, environment);
  // An invalid context fails later in ServiceLauncherClient; it must not make startup wait.
  const launcherContext = launcherContextFromEnvironment(environment[SERVICE_LAUNCHER_CONTEXT_ENV]);
  const sshReplacementId = environment[SSH_REPLACEMENT_ID_ENV]?.trim() || undefined;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const runLog = Effect.runForkWith(yield* Effect.context<never>());
      let signalAt: bigint | undefined;
      const onSigterm = () => {
        signalAt ??= clock.monotonicTimeNanosUnsafe();
        runLog(Effect.logInfo("Server received SIGTERM; shutting down"));
      };
      const onSigint = () => {
        signalAt ??= clock.monotonicTimeNanosUnsafe();
        runLog(Effect.logInfo("Server received SIGINT; shutting down"));
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          process.prependListener("SIGTERM", onSigterm);
          process.prependListener("SIGINT", onSigint);
        }),
        () =>
          Effect.sync(() => {
            process.off("SIGTERM", onSigterm);
            process.off("SIGINT", onSigint);
          }),
      );
      // For the process lifetime: shutdown tears down pipes and sockets, when teardown errors cluster.
      yield* Effect.sync(installProcessErrorNet);
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
      // Other GOAT servers on this machine bind the same checkouts; removal must see their work.
      yield* holdWorkspaceLeaseRegistry();
      const run = runServer.pipe(Effect.provideService(ServerConfig.ServerConfig, config));
      const desktop = config.mode === "desktop" && config.desktopBootstrapToken !== undefined;
      if (desktop) {
        yield* Effect.sync(() => {
          // The desktop launcher reads this process's stdout and stderr. Once it is gone,
          // every log write fails, and Node turns an unhandled stream error into a crash
          // that skips shutdown and leaves the ownership lock and runtime record behind.
          process.stdout.on("error", ignoreClosedPipe);
          process.stderr.on("error", ignoreClosedPipe);
        });
      }
      const running = desktop
        ? Effect.raceFirst(
            run,
            awaitLauncherLoss().pipe(
              // End like SIGTERM does (interrupt-only exit, so the runtime forces process exit).
              Effect.andThen(Effect.interrupt),
            ),
          )
        : run;
      return yield* running.pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            const totalMs =
              signalAt === undefined
                ? null
                : Number(((yield* Clock.monotonicTimeNanos) - signalAt) / 1_000_000n);
            const result = Exit.isSuccess(exit)
              ? "success"
              : Cause.hasInterruptsOnly(exit.cause)
                ? "interrupted"
                : "failure";
            yield* Effect.logInfo("Server shutdown finished", { exit: result, totalMs });
          }),
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
  const originalCwd = yield* prepareWorkingDirectory();
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
    const validationPath = resolveFromOriginalWorkingDirectory(cwd, originalCwd);
    if (
      !explicitPath &&
      (!(yield* fs.exists(validationPath)) || (yield* fs.stat(validationPath)).type !== "Directory")
    ) {
      return yield* new CliError.UserError({
        cause: cwd,
        userMessage: `Unknown command ${yield* encodeCommand(cwd)}. Use "goat --help" for commands or an explicit path such as "goat ./my-project" for a new directory.`,
      });
    }
  }
  return yield* runServerCommand(flags, { rejectRunningServer: true, originalCwd });
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
