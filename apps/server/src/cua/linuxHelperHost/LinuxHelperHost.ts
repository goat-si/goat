// @effect-diagnostics nodeBuiltinImport:off -- The host runs the helper as a child process and splits its output into lines.
// @effect-diagnostics globalTimers:off -- Request deadlines are plain timers inside the protocol client.
/**
 * LinuxHelperHost - a standalone Linux server runs its own computer use helper (#1223), as
 * ADR-0023 has Windows and Linux servers do, beside the Cua Driver daemon the agents' MCP proxy
 * talks to. The helper gives the server the two things only it has: its readiness steps and
 * safety signals (a secure field focused, a person's own input), for host status and for
 * ComputerUseLeases, in the same shapes the desktop host's helper reports them.
 *
 * It runs only while the driver daemon runs, with the daemon's display environment and binary,
 * and the session's variables only (SESSION_NAMES). While an agent controls the host it watches
 * every window on screen, so a secret field anywhere pauses agents (the broad side of D7).
 *
 * @module LinuxHelperHost
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import {
  ComputerUseReadiness,
  type ComputerUseEvent,
  type ComputerUseWindowTarget,
  type DesktopCuaReadinessReport,
  type DesktopCuaSafetyReport,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as CuaDriver from "../CuaDriver.ts";
import { killDriverGroup, spawnDriverProcess } from "../driverProcess.ts";
import { SESSION_NAMES } from "../linuxHelper/linuxSession.ts";
import { type HelperClient, makeHelperClient } from "./helperClient.ts";
import { LinuxHelperReport } from "./LinuxHelperReport.ts";

export class LinuxHelperHost extends Context.Service<
  LinuxHelperHost,
  {
    /** The running helper's readiness and signals; none while no helper runs. */
    readonly readiness: Effect.Effect<Option.Option<DesktopCuaReadinessReport>>;
    /** Its safety reports, shaped as the desktop host's helper sends them. */
    readonly safety: Stream.Stream<DesktopCuaSafetyReport>;
    /** Whether agents control this host, so the helper watches only then (D7). */
    readonly setWatch: (active: boolean) => Effect.Effect<void>;
  }
>()("goat/cua/linuxHelperHost/LinuxHelperHost") {}

/** The helper process, as the host needs it. */
export interface HelperProcess {
  readonly pid: number | undefined;
  readonly write: (line: string) => void;
  readonly onLine: (listener: (line: string) => void) => void;
  readonly onExit: (listener: () => void) => void;
  readonly stop: () => void;
}

/** The running daemon the helper follows: its binary and display environment. */
export interface DriverSession {
  readonly command: string;
  readonly display: Readonly<Record<string, string>>;
}

export interface HostDeps {
  readonly session: Effect.Effect<Option.Option<DriverSession>>;
  readonly spawn: (env: Readonly<Record<string, string>>) => HelperProcess;
  /** The server's own environment; only SESSION_NAMES reach the helper. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly report: Ref.Ref<Option.Option<DesktopCuaReadinessReport>>;
  readonly newId: () => string;
  readonly after: (ms: number, task: () => void) => () => void;
}

/** How often the host checks the daemon, re-reads windows to watch, and wakes otherwise. */
export const TICK_MS = 2_000;
const READINESS_EVERY_MS = 30_000;
const HELLO_MS = 10_000;
const REQUEST_MS = 15_000;
const WATCH_MS = 5_000;
const RESTART_MS = [2_000, 5_000, 15_000, 60_000] as const;

const decodeReadiness = Schema.decodeUnknownOption(ComputerUseReadiness);

const windowsOf = (result: unknown): ReadonlyArray<ComputerUseWindowTarget> => {
  if (typeof result !== "object" || result === null || !("windows" in result)) return [];
  const windows = result.windows;
  if (!Array.isArray(windows)) return [];
  return windows.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { pid, windowId, onScreen } = entry as Record<string, unknown>;
    return typeof pid === "number" && typeof windowId === "number" && onScreen !== false
      ? [{ pid, windowId }]
      : [];
  });
};

interface Running {
  readonly launch: number;
  readonly process: HelperProcess;
  readonly client: HelperClient;
  signals?: DesktopCuaReadinessReport["signals"];
  readinessAt: number;
  watched: string;
  /** The process exited on its own. */
  ended: boolean;
  /** The host let it go: stopped, its reports withdrawn. */
  retired: boolean;
}

export const makeLinuxHelperHost = Effect.fn("LinuxHelperHost.make")(function* (deps: HostDeps) {
  const hub = yield* PubSub.unbounded<DesktopCuaSafetyReport>();
  const kick = yield* PubSub.sliding<void>(1);
  const kicks = yield* PubSub.subscribe(kick);
  let current: Running | undefined;
  let launches = 0;
  let failures = 0;
  let retryAt = 0;
  let watchWanted = false;
  /** Watched windows with a secure field focused; private mode holds while any is. */
  const secret = new Map<string, ComputerUseWindowTarget>();

  const publish = (report: DesktopCuaSafetyReport) => void PubSub.publishUnsafe(hub, report);

  const clearSecrets = () => {
    const last = [...secret.values()].at(-1);
    secret.clear();
    if (last !== undefined)
      publish({ version: 1, type: "cuaPrivateMode", active: false, target: last });
  };

  const onEvent = (launch: number) => (event: ComputerUseEvent) => {
    if (current?.launch !== launch) return;
    if (event.type === "humanInput")
      return publish({ version: 1, type: "cuaHumanInput", source: event.source });
    const key = event.target.pid + ":" + event.target.windowId;
    if (event.active) {
      const first = secret.size === 0;
      secret.set(key, event.target);
      if (first)
        publish({ version: 1, type: "cuaPrivateMode", active: true, target: event.target });
    } else if (secret.delete(key) && secret.size === 0)
      publish({ version: 1, type: "cuaPrivateMode", active: false, target: event.target });
  };

  const backoff = () => RESTART_MS[Math.min(failures++, RESTART_MS.length - 1)] ?? 60_000;

  /** A helper that ends releases every target of its launch, and reports nothing any more. */
  const retire = Effect.fnUntraced(function* (entry: Running) {
    if (entry.retired) return;
    entry.retired = true;
    entry.client.close("The computer use helper ended.");
    entry.process.stop();
    if (current === entry) {
      current = undefined;
      clearSecrets();
      yield* Ref.set(deps.report, Option.none());
    }
  });

  const start = Effect.fnUntraced(function* (session: DriverSession) {
    const env: Record<string, string> = {};
    for (const name of SESSION_NAMES) {
      const value = deps.environment[name];
      if (value !== undefined) env[name] = value;
    }
    Object.assign(env, session.display, { GOAT_COMPUTER_USE_DRIVER: session.command });
    const launch = ++launches;
    const process = deps.spawn(env);
    const client = makeHelperClient({
      write: process.write,
      pid: process.pid,
      newId: deps.newId,
      after: deps.after,
      onEvent: onEvent(launch),
    });
    const entry: Running = {
      launch,
      process,
      client,
      readinessAt: 0,
      watched: "",
      ended: false,
      retired: false,
    };
    current = entry;
    process.onLine(client.line);
    process.onExit(() => {
      entry.ended = true;
      client.close("The computer use helper ended.");
      void PubSub.publishUnsafe(kick, undefined);
    });
    const hello = yield* Effect.promise(() =>
      Promise.race([
        client.start().catch(() => undefined),
        new Promise<undefined>((resolve) => deps.after(HELLO_MS, () => resolve(undefined))),
      ]),
    );
    if (hello === undefined || entry.ended) {
      yield* Effect.logWarning("The Linux computer use helper did not start", {
        launch,
        pid: process.pid,
      });
      yield* retire(entry);
      return undefined;
    }
    entry.signals = hello.capabilities.signals;
    yield* Effect.logInfo("Started the Linux computer use helper", {
      launch,
      pid: hello.binding.pid,
      generation: hello.binding.generation,
      signals: hello.capabilities.signals,
    });
    return entry;
  });

  const refreshReadiness = Effect.fnUntraced(function* (entry: Running, now: number) {
    entry.readinessAt = now + READINESS_EVERY_MS;
    const result = yield* Effect.promise(() => entry.client.request("permissions", {}, REQUEST_MS));
    const readiness = decodeReadiness(result);
    if (readiness._tag === "None" || entry.signals === undefined || current !== entry) return;
    const report: DesktopCuaReadinessReport = {
      version: 1,
      type: "cuaReadiness",
      generation: entry.launch,
      readiness: readiness.value,
      signals: entry.signals,
    };
    yield* Ref.set(deps.report, Option.some(report));
    // Every read goes out: leases re-judge detection, and a read is only every 30 seconds.
    publish(report);
    failures = 0;
  });

  /** Watches every window on screen while agents control the host; nothing otherwise. */
  const reconcileWatch = Effect.fnUntraced(function* (entry: Running) {
    if (!watchWanted) {
      if (entry.client.watching()) yield* Effect.promise(() => entry.client.unwatch(WATCH_MS));
      entry.watched = "";
      return;
    }
    const targets = windowsOf(
      yield* Effect.promise(() => entry.client.request("listWindows", {}, WATCH_MS)),
    );
    const key = targets
      .map((target) => target.pid + ":" + target.windowId)
      .sort()
      .join(",");
    if (key === entry.watched && entry.client.watching()) return;
    if (targets.length === 0) {
      if (entry.client.watching()) yield* Effect.promise(() => entry.client.unwatch(WATCH_MS));
      entry.watched = "";
      return;
    }
    if (yield* Effect.promise(() => entry.client.watch(targets, WATCH_MS))) entry.watched = key;
  });

  const tick = Effect.fnUntraced(function* () {
    const session = yield* deps.session;
    const now = yield* Clock.currentTimeMillis;
    let entry = current;
    if (entry !== undefined && (entry.ended || Option.isNone(session))) {
      const crashed = entry.ended;
      yield* Effect.logInfo(
        crashed ? "The Linux computer use helper exited" : "Stopped the Linux computer use helper",
        { launch: entry.launch, pid: entry.process.pid },
      );
      yield* retire(entry);
      if (crashed) retryAt = now + backoff();
      entry = undefined;
    }
    if (Option.isNone(session)) return;
    if (entry === undefined) {
      if (now < retryAt) return;
      entry = yield* start(session.value);
      if (entry === undefined) {
        retryAt = now + backoff();
        return;
      }
    }
    if (now >= entry.readinessAt) yield* refreshReadiness(entry, now);
    if (!entry.ended) yield* reconcileWatch(entry);
  });

  yield* tick().pipe(
    Effect.andThen(Effect.race(PubSub.take(kicks), Effect.sleep(TICK_MS))),
    Effect.forever,
    Effect.ensuring(Effect.suspend(() => (current ? retire(current) : Effect.void))),
    Effect.forkScoped,
  );

  return LinuxHelperHost.of({
    readiness: Ref.get(deps.report),
    safety: Stream.fromPubSub(hub),
    setWatch: (active) =>
      Effect.sync(() => {
        if (watchWanted === active) return;
        watchWanted = active;
        void PubSub.publishUnsafe(kick, undefined);
      }),
  });
});

/** Longest helper line kept; the host asks for no screenshots, so its answers are small. */
const MAX_LINE = 4 * 1024 * 1024;

/**
 * Where the helper is: a packaged bundle that GOAT_COMPUTER_USE_HELPER names, or its source
 * beside this server in development. Staging the bundle with a released server is #1224.
 */
const helperEntry = (environment: Readonly<Record<string, string | undefined>>) => {
  const named = environment.GOAT_COMPUTER_USE_HELPER?.trim();
  if (named) return named;
  const source = NodeURL.fileURLToPath(new URL("../linuxHelper/main.ts", import.meta.url));
  return NodeFS.existsSync(source) ? source : undefined;
};

const spawnHelper =
  (platform: NodeJS.Platform, node: string, entry: string) =>
  (env: Readonly<Record<string, string>>): HelperProcess => {
    const child = spawnDriverProcess(platform, node, [entry], {
      ...env,
      GOAT_COMPUTER_USE_EXECUTABLE: entry,
    });
    const lines: Array<(line: string) => void> = [];
    let buffer = "";
    let dropping = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (dropping) dropping = false;
        else for (const listener of lines) listener(line);
      }
      // A line past the limit is dropped whole, through its newline.
      if (buffer.length > MAX_LINE) {
        buffer = "";
        dropping = true;
      }
    });
    return {
      pid: child.pid,
      write: (line) => void child.stdin.write(line),
      onLine: (listener) => void lines.push(listener),
      // close follows exit and a failed spawn alike.
      onExit: (listener) => void child.once("close", listener),
      stop: () => killDriverGroup(platform, child, "SIGTERM"),
    };
  };

const inert = (report: Ref.Ref<Option.Option<DesktopCuaReadinessReport>>) =>
  LinuxHelperHost.of({
    readiness: Ref.get(report),
    safety: Stream.empty,
    setWatch: () => Effect.void,
  });

export const layer = Layer.effect(
  LinuxHelperHost,
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    const config = yield* ServerConfig.ServerConfig;
    const { latest } = yield* LinuxHelperReport;
    const environment = yield* HostProcess.Environment;
    const node = yield* HostProcess.ExecutablePath;
    const driver = yield* Effect.serviceOption(CuaDriver.CuaDriver);
    const entry = platform === "linux" ? helperEntry(environment) : undefined;
    // The desktop app's own helper reports through desktop telemetry instead.
    if (
      entry === undefined ||
      config.mode === "desktop" ||
      Option.isNone(driver) ||
      driver.value.driverSession === undefined
    )
      return inert(latest);
    return yield* makeLinuxHelperHost({
      session: driver.value.driverSession.pipe(
        Effect.map(
          Option.map(({ mcp, display }) => ({
            command: mcp.command,
            display: Object.fromEntries(display.map((variable) => [variable.name, variable.value])),
          })),
        ),
      ),
      spawn: spawnHelper(platform, node, entry),
      environment,
      report: latest,
      newId: () => NodeCrypto.randomUUID(),
      after: (ms, task) => {
        const timer = setTimeout(task, ms);
        return () => clearTimeout(timer);
      },
    });
  }),
);
