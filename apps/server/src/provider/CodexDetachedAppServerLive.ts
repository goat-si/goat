// @effect-diagnostics nodeBuiltinImport:off -- detached spawn, process-group signals and socket probes need Node primitives.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { connectCodexAppServerSocket } from "./CodexAppServerSocket.ts";
import {
  CodexDetachedAppServerError,
  type DetachedAppServers,
  type DetachedProcess,
  type DetachedProcessTable,
  makeDetachedAppServers,
  PID_HANDSHAKE_SCRIPT,
  privateSocketDirectory,
} from "./CodexDetachedAppServer.ts";

/** Opt-in maintainer switch until restart survival ships; stdio stays the default. */
export const CODEX_TRANSPORT_ENV = "GOAT_CODEX_APP_SERVER_TRANSPORT";

export class CodexDetachedAppServers extends Context.Service<
  CodexDetachedAppServers,
  DetachedAppServers & { readonly socketTransportEnabled: boolean }
>()("goat/provider/CodexDetachedAppServerLive/CodexDetachedAppServers") {}

const PROCESS_ROW = /^\s*(\d+)\s+(\d+)\s+(.*)$/;

export const parseProcessRows = (stdout: string): ReadonlyArray<DetachedProcess> =>
  stdout.split("\n").flatMap((line) => {
    const match = PROCESS_ROW.exec(line);
    return match ? [{ pid: Number(match[1]), pgid: Number(match[2]), argv: match[3] ?? "" }] : [];
  });

const fail = (detail: string) => new CodexDetachedAppServerError({ detail });

export const layer = Layer.effect(
  CodexDetachedAppServers,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const runner = yield* ProcessRunner.ProcessRunner;
    const platform = yield* HostProcess.Platform;
    const uid = yield* HostProcess.UserId;
    const environment = yield* HostProcess.Environment;

    const run = (command: string, args: ReadonlyArray<string>) =>
      runner
        .run({ command, args, env: { ...environment, LC_ALL: "C" }, timeout: "5 seconds" })
        .pipe(
          Effect.mapError(
            (cause) => new CodexDetachedAppServerError({ detail: command + " failed.", cause }),
          ),
        );

    const processes = (args: ReadonlyArray<string>) =>
      run("ps", args).pipe(
        Effect.flatMap((output) =>
          output.code === 0 || output.code === 1
            ? Effect.succeed(parseProcessRows(output.stdout))
            : Effect.fail(fail("ps exited with " + String(output.code) + ".")),
        ),
      );

    const processTable: DetachedProcessTable = {
      // Numeric group membership only; never a name match.
      groupMembers: (pgid) =>
        processes(["-A", "-ww", "-o", "pid=,pgid=,command="]).pipe(
          Effect.map((rows) => rows.filter((row) => row.pgid === pgid)),
        ),
      ownerOfSocket: Effect.fn("CodexDetachedAppServers.ownerOfSocket")(function* (
        socketPath: string,
      ) {
        // Codex publishes the socket path as a symlink to its protected physical socket.
        const physical = yield* Effect.tryPromise({
          try: () => NodeFSP.realpath(socketPath),
          catch: (cause) =>
            new CodexDetachedAppServerError({ detail: "Codex socket path unreadable.", cause }),
        });
        const output =
          platform === "darwin"
            ? yield* run("lsof", ["-t", "--", physical])
            : yield* run("ss", ["-H", "-xlp", "src", physical]);
        const pid =
          platform === "darwin"
            ? output.stdout.trim().split("\n")[0]
            : /pid=(\d+)/.exec(output.stdout)?.[1];
        if (pid === undefined || !/^\d+$/.test(pid)) return undefined;
        return (yield* processes(["-ww", "-o", "pid=,pgid=,command=", "-p", pid]))[0];
      }),
    };

    const socketAccepts = (path: string) =>
      Effect.callback<boolean>((resume) => {
        const socket = NodeNet.connect({ path });
        const done = (accepted: boolean) => {
          socket.destroy();
          resume(Effect.succeed(accepted));
        };
        socket.once("connect", () => done(true));
        socket.once("error", () => done(false));
        return Effect.sync(() => socket.destroy());
      }).pipe(Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.succeed(false) }));

    const signalGroup = (pgid: number, signal: "SIGTERM" | "SIGKILL") =>
      Effect.try({
        try: () => {
          try {
            process.kill(-pgid, signal);
          } catch (cause) {
            // The group already exited.
            if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
          }
        },
        catch: (cause) =>
          new CodexDetachedAppServerError({ detail: "Could not signal Codex app-server.", cause }),
      });

    const bootId =
      platform === "darwin"
        ? run("sysctl", ["-n", "kern.bootsessionuuid"]).pipe(
            Effect.map((output) => (output.code === 0 ? output.stdout.trim() || null : null)),
          )
        : Effect.tryPromise({
            try: () => NodeFSP.readFile("/proc/sys/kernel/random/boot_id", "utf8"),
            catch: (cause) =>
              new CodexDetachedAppServerError({ detail: "Boot id unreadable.", cause }),
          }).pipe(Effect.map((value) => value.trim() || null));

    const socketDirectory =
      uid === undefined
        ? Effect.fail(new CodexDetachedAppServerError({ detail: "No user id on this platform." }))
        : privateSocketDirectory("/tmp/goat-" + uid, uid);

    const launch = Effect.fn("CodexDetachedAppServers.launch")(function* (input: {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly cwd?: string | undefined;
      readonly env?: NodeJS.ProcessEnv | undefined;
      readonly pidFile: string;
      readonly stderrPath: string;
    }) {
      const exited = yield* Deferred.make<number | null>();
      const child = yield* Effect.try({
        try: () => {
          const stderr = NodeFS.openSync(input.stderrPath, "w", 0o600);
          try {
            return NodeChildProcess.spawn(
              "/bin/sh",
              [
                "-c",
                PID_HANDSHAKE_SCRIPT,
                "goat-codex",
                input.pidFile,
                input.command,
                ...input.args,
              ],
              {
                cwd: input.cwd,
                env: input.env,
                detached: true,
                stdio: ["ignore", "ignore", stderr],
              },
            );
          } finally {
            NodeFS.closeSync(stderr);
          }
        },
        catch: (cause) =>
          new CodexDetachedAppServerError({ detail: "Could not start Codex app-server.", cause }),
      });
      child.once("exit", (code) => Deferred.doneUnsafe(exited, Effect.succeed(code)));
      child.once("error", () => Deferred.doneUnsafe(exited, Effect.succeed(null)));
      child.unref();
      if (child.pid === undefined) return yield* fail("Codex app-server did not start.");
      return { pid: child.pid, exited: Deferred.await(exited) };
    });

    const service = yield* makeDetachedAppServers({
      stateDir: config.stateDir,
      bootId,
      processTable,
      socketAccepts,
      signalGroup,
      warnPossibleLeftovers: (pids) =>
        Effect.logWarning("Processes from an earlier Codex app-server may still be running", {
          pids,
        }),
      launch,
      connect: (socketPath) =>
        connectCodexAppServerSocket(socketPath).pipe(
          Effect.mapError(
            (cause) =>
              new CodexDetachedAppServerError({ detail: "Codex socket not accepting yet.", cause }),
          ),
        ),
      socketDirectory,
    });
    return {
      ...service,
      socketTransportEnabled:
        platform !== "win32" && environment[CODEX_TRANSPORT_ENV]?.trim() === "socket",
    };
  }),
);

/** One shared instance: the startup barrier, the shutdown flag and the factory must see the same blocked set. */
export const layerLive = layer.pipe(Layer.provide(ProcessRunner.layer));
