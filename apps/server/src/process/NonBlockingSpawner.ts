// @effect-diagnostics nodeBuiltinImport:off - execvp's X_OK test has no Effect FileSystem equivalent.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import { envTrampoline, supportsEnvChdir } from "@goat/shared/envTrampoline";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as CommandLine from "effect/process/CommandLine";
import * as SpawnWorker from "./SpawnWorker.ts";

// libuv's _PATH_DEFPATH, searched when the child environment has no PATH.
const DEFAULT_PATH = "/usr/bin:/bin";

// A check on a hung mount holds a libuv threadpool thread until the mount answers, and the
// pool's four threads also compress every WebSocket frame. Checks therefore run one at a time
// per directory and two at a time overall; the rest wait without holding a thread.
const CHECK_LIMIT = 2;
const WAITING_LIMIT = 32;
const CHECK_TIMEOUT_MS = 5_000;
const CHECK_TIMEOUT_NANOS = BigInt(CHECK_TIMEOUT_MS) * 1_000_000n;
const active = new Map<string, bigint>();
const waiting = new Set<{ directory: string; start: () => void }>();

const accessFailure = (path: string, tag: "Busy" | "TimedOut") =>
  PlatformError.systemError({
    _tag: tag,
    module: "FileSystem",
    method: "access",
    pathOrDescriptor: path,
  });

const releaseCheck = (directory: string) => {
  active.delete(directory);
  for (const queued of waiting) {
    if (active.has(queued.directory)) continue;
    waiting.delete(queued);
    queued.start();
    break;
  }
};

/** The errno error of `access(path, mode)`, or undefined when it passes. */
const check = (directory: string, path: string, mode: number) =>
  Clock.clockWith((clock) =>
    Effect.callback<NodeJS.ErrnoException | undefined, PlatformError.PlatformError>((resume) => {
      const startedAt = active.get(directory);
      const start = () => {
        active.set(directory, clock.monotonicTimeNanosUnsafe());
        // A timed-out caller leaves the slot occupied until libuv actually finishes.
        const finish = (error?: NodeJS.ErrnoException) => {
          releaseCheck(directory);
          resume(Effect.succeed(error));
        };
        void NodeFSP.access(path, mode).then(() => finish(), finish);
      };
      if (startedAt === undefined && active.size < CHECK_LIMIT) return start();
      if (
        startedAt !== undefined &&
        clock.monotonicTimeNanosUnsafe() - startedAt >= CHECK_TIMEOUT_NANOS
      )
        return resume(accessFailure(path, "TimedOut"));
      if (waiting.size >= WAITING_LIMIT) return resume(accessFailure(path, "Busy"));
      const queued = { directory, start };
      waiting.add(queued);
      return Effect.sync(() => {
        waiting.delete(queued);
      });
    }).pipe(
      Effect.timeoutOrElse({
        duration: CHECK_TIMEOUT_MS,
        orElse: () => accessFailure(path, "TimedOut"),
      }),
    ),
  );

// The PATH the child searches, from the environment Effect's Node spawner gives it.
const childPath = ({ env, extendEnv }: ChildProcess.CommandOptions) => {
  if (env === undefined) return process.env.PATH;
  if (!Object.hasOwn(env, "PATH")) return extendEnv === true ? process.env.PATH : undefined;
  const value = env.PATH;
  return value === undefined || !Redacted.isRedacted(value) ? value : Redacted.value(value);
};

// The spawn error Effect's Node spawner reports when execvp fails with `code`.
const spawnFailure = (command: ChildProcess.StandardCommand, code: "ENOENT" | "EACCES") => {
  const syscall = `spawn ${command.command}`;
  return PlatformError.systemError({
    _tag: code === "ENOENT" ? "NotFound" : "PermissionDenied",
    module: "ChildProcess",
    method: "spawn",
    pathOrDescriptor: CommandLine.display([command.command, ...command.args], { format: "posix" }),
    syscall,
    cause: Object.assign(new Error(`${syscall} ${code}`), {
      errno: code === "ENOENT" ? -2 : -13,
      code,
      syscall,
      path: command.command,
      spawnargs: command.args.map((arg) => (Redacted.isRedacted(arg) ? "<redacted>" : arg)),
    }),
  });
};

// The error of the `FileSystem.access(cwd)` Effect's Node spawner runs before it spawns.
const cwdFailure = (cwd: string, cause: NodeJS.ErrnoException) =>
  PlatformError.systemError({
    _tag:
      cause.code === "ENOENT"
        ? "NotFound"
        : cause.code === "EACCES" || cause.code === "EPERM"
          ? "PermissionDenied"
          : cause.code === "ENOTDIR" || cause.code === "ELOOP"
            ? "BadResource"
            : "Unknown",
    module: "FileSystem",
    method: "access",
    pathOrDescriptor: cwd,
    syscall: cause.syscall,
    cause,
  });

/**
 * Fails as a native spawn does when the command is missing or not executable: callers read
 * that error to tell a CLI that is not installed from one that failed. execvp reports EACCES
 * when a candidate exists but cannot be run, and ENOENT otherwise.
 */
const findExecutable = Effect.fnUntraced(function* (
  command: ChildProcess.StandardCommand,
  cwd: string | undefined,
) {
  // Joined as text: the kernel resolves `..` after a symlink differently from a normalized path.
  const fromCwd = (path: string) =>
    cwd === undefined || path.startsWith("/") ? path : `${cwd}/${path}`;
  const candidates = command.command.includes("/")
    ? [fromCwd(command.command)]
    : (childPath(command.options) ?? DEFAULT_PATH)
        .split(":")
        .map((entry) => `${fromCwd(entry || ".")}/${command.command}`);
  let denied = false;
  for (const candidate of candidates) {
    const error = yield* check(
      candidate.slice(0, candidate.lastIndexOf("/")) || "/",
      candidate,
      NodeFS.constants.X_OK,
    );
    // Any other errno is left for `env` to report through its exit code.
    if (error === undefined || (error.code !== "ENOENT" && error.code !== "EACCES")) return;
    denied ||= error.code === "EACCES";
  }
  return yield* spawnFailure(command, denied ? "EACCES" : "ENOENT");
});

const make = Effect.gen(function* () {
  const native = yield* ChildProcessSpawner.ChildProcessSpawner;
  if ((yield* HostProcess.Platform) !== "linux") return native;
  if (!(yield* Effect.promise(supportsEnvChdir))) return native;
  const path = yield* Path.Path;

  // Runs inside the NonBlockingSpawner.spawn span.
  const prepareStandard = Effect.fnUntraced(function* (input: ChildProcess.StandardCommand) {
    const { cwd: givenCwd, shell, ...options } = input.options;
    // Effect rejects a shell command with arguments, and a NUL, itself.
    if ((shell && input.args.length > 0) || input.command.includes("\0")) return input;
    // Node's shell mode on Unix, spelled out so the trampoline can run it.
    const command = shell
      ? ChildProcess.make(typeof shell === "string" ? shell : "/bin/sh", ["-c", input.command])
      : input;
    // Checked as given and entered resolved, as Effect's Node spawner does.
    const cwd = givenCwd === undefined ? undefined : path.resolve(givenCwd);
    const trampoline = envTrampoline(command.command, command.args, cwd);
    if (trampoline === undefined) return input;
    if (givenCwd !== undefined && cwd !== undefined) {
      const error = yield* check(cwd, givenCwd, NodeFS.constants.F_OK);
      if (error !== undefined) return yield* cwdFailure(givenCwd, error);
    }
    yield* findExecutable(ChildProcess.make(command.command, command.args, options), cwd);
    return ChildProcess.make(trampoline.command, trampoline.args, options);
  });

  const prepare = (
    command: ChildProcess.Command,
  ): Effect.Effect<ChildProcess.Command, PlatformError.PlatformError> =>
    command._tag === "StandardCommand"
      ? prepareStandard(command)
      : Effect.map(Effect.all([prepare(command.left), prepare(command.right)]), ([left, right]) =>
          ChildProcess.pipeTo(left, right, command.options),
        );

  return ChildProcessSpawner.make(
    Effect.fn("NonBlockingSpawner.spawn")(function* (command) {
      return yield* native.spawn(yield* prepare(command));
    }),
  );
});

/**
 * On Linux with GNU `env`, replaces the provided `ChildProcessSpawner` with one that never
 * hands libuv a cwd or a PATH search; elsewhere it passes the provided one through.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* (): Effect.fn.Return<
    Layer.Layer<
      ChildProcessSpawner.ChildProcessSpawner,
      never,
      ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
    >
  > {
    const platform = yield* HostProcess.Platform;
    if (
      platform === "win32" ||
      (platform === "linux" && !(yield* Effect.promise(supportsEnvChdir)))
    ) {
      return SpawnWorker.layer;
    }
    return Layer.effect(ChildProcessSpawner.ChildProcessSpawner, make);
  }),
);
