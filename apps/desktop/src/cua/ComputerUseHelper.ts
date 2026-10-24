// @effect-diagnostics globalTimers:off -- Startup and shutdown deadlines run at child-process callback boundaries outside Effect fibers.
// @effect-diagnostics nodeBuiltinImport:off -- This desktop-only module owns the helper's child process and socket directory.

import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import { COMPUTER_USE_HELPER_NAME } from "@goat/shared/cuaDriverRelease";
import { ComputerUseEvent } from "@goat/contracts";
import type { CuaDriverListedApp } from "@goat/shared/cuaDriverManifest";
import type { EmbeddedDriverConnection } from "@trycua/cua-driver/embedded";
import * as Schema from "effect/Schema";

/**
 * Line-delimited JSON spoken with "GOAT Computer Use.app" over its stdio
 * (apps/desktop/native/computer-use-helper/main.swift). The helper's first line is hello or a
 * refusal; requests carry an id and get exactly one reply. Unrequested lines are driverExited
 * and, while a watch is in force, its events.
 */
const HELPER_PROTOCOL_VERSION = 1;

const Hello = Schema.Struct({
  type: Schema.Literal("hello"),
  protocol: Schema.Number,
  pid: Schema.Number,
  bundleId: Schema.String,
  /** Methods beyond protocol 1's first set; absent from helpers that predate them. */
  features: Schema.optionalKey(Schema.Array(Schema.String)),
});
const Refused = Schema.Struct({
  type: Schema.Literal("refused"),
  reason: Schema.String,
  message: Schema.String,
});
const Reply = Schema.Struct({
  id: Schema.String,
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Struct({ code: Schema.String, message: Schema.String })),
});
const DriverExited = Schema.Struct({
  type: Schema.Literal("driverExited"),
  driverPid: Schema.Number,
  code: Schema.Number,
});
/** Something the helper noticed while watching (#1235); never what was typed or shown. */
const HelperEvent = Schema.Struct({
  type: Schema.Literal("event"),
  watchId: Schema.String,
  event: ComputerUseEvent,
});
export type HelperEvent = typeof HelperEvent.Type;
const Message = Schema.Union([Hello, Refused, DriverExited, HelperEvent, Reply]);
const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(Message));

export const HelperGrants = Schema.Struct({
  accessibility: Schema.Boolean,
  screenRecording: Schema.Boolean,
});
const decodeGrants = Schema.decodeUnknownSync(HelperGrants);
/** list_apps entries as the driver reports them; extra fields are dropped. */
const decodeListedApps = Schema.decodeUnknownSync(
  Schema.Struct({
    apps: Schema.Array(
      Schema.Struct({
        bundle_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
        name: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  }),
);
const Started = Schema.Struct({
  socketPath: Schema.String,
  driverPid: Schema.Number,
  hostBundleId: Schema.String,
});
const decodeStarted = Schema.decodeUnknownSync(Started);

/** A typed failure from the helper or from talking to it; code names the cause for logs and UI. */
export class ComputerUseHelperError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ComputerUseHelperError";
  }
}

/** The pieces of a spawned process the client uses, so tests can drive it with streams. */
export interface HelperProcess {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly kill: (signal: NodeJS.Signals) => void;
  readonly exited: Promise<void>;
}

export const spawnHelperProcess = (
  executable: string,
  platform: NodeJS.Platform,
): HelperProcess => {
  // Windows has no process groups to signal; the helper keeps its driver in a kill-on-close job,
  // so ending the helper ends the driver.
  if (platform === "win32") {
    const child = NodeChildProcess.spawn(executable, [], {
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    });
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    child.stdin.on("error", () => undefined);
    return { stdin: child.stdin, stdout: child.stdout, kill: () => child.kill(), exited };
  }
  // Its own process group: the launcher, the service it re-execs and the driver all join it, so
  // a forced stop reaches the whole tree even when the service is stuck.
  const child = NodeChildProcess.spawn(executable, [], {
    stdio: ["pipe", "pipe", "inherit"],
    detached: true,
  });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  // A helper that died leaves a closed pipe; the exit promise reports it instead.
  child.stdin.on("error", () => undefined);
  const kill = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // The group is already gone.
    }
  };
  return { stdin: child.stdin, stdout: child.stdout, kill, exited };
};

export interface HelperSession {
  /** The service process: the driver's parent and the TCC principal. */
  readonly pid: number;
  readonly bundleId: string;
  /** One request and its undecoded result, for platform methods such as Windows readiness. */
  readonly request: (method: string, params?: object) => Promise<unknown>;
  readonly permissions: (prompt: boolean) => Promise<typeof HelperGrants.Type>;
  readonly start: (params: {
    readonly socketPath: string;
    readonly capabilityManifestPath?: string;
    readonly environment: ReadonlyArray<{ readonly name: string; readonly value: string }>;
    readonly noOverlay: boolean;
  }) => Promise<typeof Started.Type>;
  readonly stop: () => Promise<void>;
  /** Whether this helper can watch for a focused secure field (#1235). */
  readonly canWatch: boolean;
  /**
   * Starts watching every window for a focused secure field, replacing any earlier watch. The
   * new watch is in force from its answer: events the old one sends before it still arrive,
   * and the new one's first state follows it.
   */
  readonly watch: (watchId: string) => Promise<void>;
  /** Stops whatever this helper watches, including a watch whose answer never arrived. */
  readonly unwatch: () => Promise<void>;
  /** Events of the watch in force; returns the unsubscribe. */
  readonly onEvent: (listener: (event: HelperEvent["event"]) => void) => () => void;
  /** Ends stdin, the helper's ownership signal, and waits for exit; kills it after a deadline. */
  readonly close: () => Promise<void>;
  /** Settles when the driver exits on its own or the helper goes away. */
  readonly ended: Promise<void>;
}

const HELLO_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 8_000;

const timeout = (ms: number) =>
  new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms).unref?.());

export async function openHelperSession(
  process: HelperProcess,
  expectedBundleId: string,
): Promise<HelperSession> {
  const pending = new Map<string, (reply: typeof Reply.Type) => void>();
  // Which watch each in-flight watch/unwatch request puts in force once answered.
  const watchChanges = new Map<string, string | undefined>();
  let watching: string | undefined;
  const eventListeners = new Set<(event: HelperEvent["event"]) => void>();
  let gone = false;
  let markEnded!: () => void;
  const ended = new Promise<void>((resolve) => (markEnded = resolve));
  let greet!: (message: typeof Hello.Type | typeof Refused.Type | undefined) => void;
  const greeting = new Promise<typeof Hello.Type | typeof Refused.Type | undefined>(
    (resolve) => (greet = resolve),
  );
  const finish = () => {
    if (gone) return;
    gone = true;
    greet(undefined);
    for (const resolve of pending.values())
      resolve({ id: "", error: { code: "helper_exited", message: "The helper exited." } });
    pending.clear();
    markEnded();
  };
  void process.exited.then(finish);
  const lines = NodeReadline.createInterface({ input: process.stdout });
  lines.on("line", (line) => {
    const message = decodeMessage(line);
    if (message._tag === "None") return;
    const value = message.value;
    if ("type" in value) {
      if (value.type === "hello" || value.type === "refused") greet(value);
      else if (value.type === "event") {
        if (value.watchId === watching)
          for (const listener of eventListeners) listener(value.event);
      } else markEnded();
      return;
    }
    // Switched as the answer is read, before any later line: the new watch's first state is next.
    if (watchChanges.has(value.id) && value.error === undefined)
      watching = watchChanges.get(value.id);
    watchChanges.delete(value.id);
    pending.get(value.id)?.(value);
    pending.delete(value.id);
  });
  lines.on("close", finish);

  const close = async () => {
    process.stdin.end();
    if (
      (await Promise.race([
        process.exited.then(() => "exited" as const),
        timeout(CLOSE_TIMEOUT_MS),
      ])) === "timeout"
    )
      process.kill("SIGKILL");
    await process.exited;
  };

  const hello = await Promise.race([greeting, timeout(HELLO_TIMEOUT_MS)]);
  const refuse = async (code: string, message: string): Promise<never> => {
    await close();
    throw new ComputerUseHelperError(code, message);
  };
  if (hello === "timeout") return refuse("no_hello", "GOAT Computer Use did not answer.");
  if (hello === undefined)
    return refuse("helper_exited", "GOAT Computer Use exited before it answered.");
  if (hello.type === "refused") return refuse(hello.reason, hello.message);
  if (hello.protocol !== HELPER_PROTOCOL_VERSION)
    return refuse(
      "protocol_mismatch",
      "GOAT Computer Use speaks protocol " +
        hello.protocol +
        ", expected " +
        HELPER_PROTOCOL_VERSION +
        ".",
    );
  if (hello.bundleId !== expectedBundleId)
    return refuse(
      "bundle_mismatch",
      "GOAT Computer Use is " + hello.bundleId + ", expected " + expectedBundleId + ".",
    );

  let next = 0;
  const request = async (
    method: string,
    params: object = {},
    watchChange?: { readonly to: string | undefined },
  ): Promise<unknown> => {
    if (gone) throw new ComputerUseHelperError("helper_exited", "The helper exited.");
    const id = String(++next);
    const reply = new Promise<typeof Reply.Type>((resolve) => pending.set(id, resolve));
    if (watchChange) watchChanges.set(id, watchChange.to);
    process.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    const answer = await Promise.race([reply, timeout(REQUEST_TIMEOUT_MS)]);
    if (answer === "timeout") {
      pending.delete(id);
      // A late answer must not switch the watch: the caller treats this one as failed.
      watchChanges.delete(id);
      throw new ComputerUseHelperError(
        "timeout",
        "GOAT Computer Use did not answer " + method + ".",
      );
    }
    if (answer.error) throw new ComputerUseHelperError(answer.error.code, answer.error.message);
    return answer.result;
  };

  return {
    pid: hello.pid,
    bundleId: hello.bundleId,
    request,
    permissions: async (prompt) => decodeGrants(await request("permissions", { prompt })),
    start: async (params) => decodeStarted(await request("start", params)),
    stop: async () => {
      await request("stop");
    },
    canWatch: hello.features?.includes("watch") === true,
    watch: async (watchId) => {
      await request("watch", { watchId, targets: [] }, { to: watchId });
    },
    unwatch: async () => {
      // No watchId: the helper stops any watch it runs, one this session never saw answered too.
      await request("unwatch", {}, { to: undefined });
    },
    onEvent: (listener) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    close,
    ended,
  };
}

/** Reads a helper's own grants from a fresh process: macOS caches TCC answers per process. */
/** The apps the helper's driver lists, run inside the helper after its seal check (#1241). */
export async function listHelperApplications(
  process: HelperProcess,
  expectedBundleId: string,
): Promise<ReadonlyArray<CuaDriverListedApp>> {
  const session = await openHelperSession(process, expectedBundleId);
  try {
    return decodeListedApps(await session.request("listApps")).apps;
  } finally {
    await session.close();
  }
}

export async function probeHelperGrants(
  process: HelperProcess,
  expectedBundleId: string,
  prompt: boolean,
): Promise<typeof HelperGrants.Type> {
  const session = await openHelperSession(process, expectedBundleId);
  try {
    return await session.permissions(prompt);
  } finally {
    await session.close();
  }
}

export interface HelperBundle {
  readonly bundlePath: string;
  readonly executable: string;
  readonly driverPath: string;
  readonly bundleId: string;
}

/**
 * Whether a helper bundle is at a path. absent only when nothing is there, not even a link, and
 * the caller did not insist on it; anything else that does not resolve to a bundle with its
 * executable is unusable, so a broken install never silently becomes "no helper".
 */
export async function classifyHelperBundle(
  candidate: string,
  required: boolean,
  executableOf: (bundlePath: string) => string = (path) => helperBundle(path, "").executable,
): Promise<
  | { readonly kind: "found"; readonly path: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unusable"; readonly message: string }
> {
  const unusable = (error: unknown) => ({
    kind: "unusable" as const,
    message:
      COMPUTER_USE_HELPER_NAME +
      " at " +
      candidate +
      " cannot be used (" +
      ((error as NodeJS.ErrnoException).code ?? "unknown error") +
      ").",
  });
  try {
    await NodeFSP.lstat(candidate);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" && !required
      ? { kind: "absent" }
      : unusable(error);
  }
  try {
    const path = await NodeFSP.realpath(candidate);
    await NodeFSP.access(executableOf(path), NodeFSP.constants.X_OK);
    return { kind: "found", path };
  } catch (error) {
    return unusable(error);
  }
}

// A macOS bundle's paths are POSIX wherever this module is tested.
export const helperBundle = (bundlePath: string, bundleId: string): HelperBundle => ({
  bundlePath,
  executable: NodePath.posix.join(bundlePath, "Contents", "MacOS", COMPUTER_USE_HELPER_NAME),
  driverPath: NodePath.posix.join(bundlePath, "Contents", "Resources", "cua-driver", "cua-driver"),
  bundleId,
});

/** What the daemon says about itself, read over its socket before anyone else connects. */
export interface DaemonMetadata {
  readonly driverVersion: string;
  readonly contractVersion: string;
  readonly mcpProtocolVersion: string;
  readonly pid: number;
  readonly embedded: boolean;
  readonly hostBundleId?: string | undefined;
}

/** Why a daemon the helper started is not the one GOAT expects, or undefined when it is. */
export function daemonMismatch(
  metadata: DaemonMetadata,
  expected: { readonly pid: number; readonly bundleId: string; readonly driverVersion: string },
): string | undefined {
  if (metadata.pid !== expected.pid)
    return (
      "The driver socket belongs to pid " +
      metadata.pid +
      ", not the driver the helper started (" +
      expected.pid +
      ")."
    );
  if (!metadata.embedded) return "The driver is not running embedded in GOAT Computer Use.";
  if (metadata.hostBundleId !== expected.bundleId)
    return (
      "The driver reports host " +
      (metadata.hostBundleId ?? "none") +
      ", expected " +
      expected.bundleId +
      "."
    );
  if (metadata.driverVersion !== expected.driverVersion)
    return (
      "The helper bundles Cua Driver " +
      metadata.driverVersion +
      ", expected " +
      expected.driverVersion +
      "."
    );
  return undefined;
}

/**
 * The SDK's embedded host lifecycle (start, stop, waitForExit) backed by the helper, so the
 * desktop driver owns either engine the same way. One helper process per generation.
 */
export interface HelperHostOptions {
  readonly bundle: HelperBundle;
  readonly driverVersion: string;
  readonly capabilityManifestPath: string;
  readonly environment: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly spawn: (executable: string) => HelperProcess;
  readonly readMetadata: (socketPath: string) => Promise<DaemonMetadata>;
  /**
   * Where this generation's driver listens. Defaults to a socket in a fresh private directory;
   * Windows names a pipe instead.
   */
  readonly socket?: () => Promise<{ readonly path: string; readonly release: () => Promise<void> }>;
  /**
   * Agents reach the driver through the helper's MCP relay instead of the driver binary. Windows
   * sets it: the relay keeps screenshots of covered windows from showing what covers them (#1329).
   */
  readonly mcpThroughHelper?: boolean;
}

const privateSocket = async () => {
  // A short private directory: Unix socket paths stop at 104 bytes.
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-cu-"));
  return {
    path: NodePath.join(directory, "driver.sock"),
    release: () => NodeFSP.rm(directory, { recursive: true, force: true }),
  };
};

export function makeHelperHost(options: HelperHostOptions) {
  let session: HelperSession | undefined;
  let releaseSocket: (() => Promise<void>) | undefined;
  let connection: EmbeddedDriverConnection | undefined;
  let generation = 0;

  const release = async () => {
    const current = session;
    session = undefined;
    connection = undefined;
    if (current) {
      await current.stop().catch(() => undefined);
      await current.close();
    }
    await releaseSocket?.();
    releaseSocket = undefined;
  };

  return {
    servicePid: () => session?.pid,
    /** The running generation's helper session, for its watch; undefined between generations. */
    session: () => session,
    start: async (): Promise<EmbeddedDriverConnection> => {
      if (connection) return connection;
      session = await openHelperSession(
        options.spawn(options.bundle.executable),
        options.bundle.bundleId,
      );
      try {
        const socket = await (options.socket ?? privateSocket)();
        releaseSocket = socket.release;
        const started = await session.start({
          socketPath: socket.path,
          capabilityManifestPath: options.capabilityManifestPath,
          environment: options.environment,
          noOverlay: false,
        });
        const metadata = await options.readMetadata(started.socketPath);
        const mismatch = daemonMismatch(metadata, {
          pid: started.driverPid,
          bundleId: options.bundle.bundleId,
          driverVersion: options.driverVersion,
        });
        if (mismatch) throw new ComputerUseHelperError("incompatible_daemon", mismatch);
        connection = {
          socketPath: started.socketPath,
          pid: started.driverPid,
          generation: String(++generation),
          driverVersion: metadata.driverVersion,
          contractVersion: metadata.contractVersion,
          mcpProtocolVersion: metadata.mcpProtocolVersion,
          // The same proxy invocation the SDK host hands out: arguments carry the whole route.
          mcp: {
            command: options.mcpThroughHelper
              ? options.bundle.executable
              : options.bundle.driverPath,
            args: [
              "mcp",
              "--embedded",
              "--socket",
              started.socketPath,
              "--host-bundle-id",
              options.bundle.bundleId,
            ],
            environment: [],
          },
        };
        return connection;
      } catch (error) {
        await release();
        throw error;
      }
    },
    stop: release,
    waitForExit: async (_generation: string, opts?: { readonly signal?: AbortSignal }) => {
      const ended = session?.ended ?? Promise.resolve();
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(new ComputerUseHelperError("aborted", "Stopped waiting."));
        if (opts?.signal?.aborted) return abort();
        opts?.signal?.addEventListener("abort", abort, { once: true });
        void ended.then(() => {
          opts?.signal?.removeEventListener("abort", abort);
          resolve();
        });
      });
    },
    uniffiDestroy: () => undefined,
  };
}
