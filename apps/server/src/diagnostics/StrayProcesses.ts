import type { HostStrayCleanupResult, HostStrayProcess, HostStrayProcesses } from "@goat/contracts";
import { HostMaintenanceError } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { forkParked } from "../serverActivation.ts";

/** A test server younger than this may still belong to a run in progress. */
export const STRAY_TEMPORARY_HOME_MIN_AGE_MS = 60 * 60_000;
const SCAN_INTERVAL = Duration.minutes(5);
const TERM_GRACE_MS = 5_000;
const TERM_POLL_MS = 250;

class StraySignalError extends Schema.TaggedError<StraySignalError>()("StraySignalError", {
  pid: Schema.Number,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    const detail = this.cause instanceof Error ? this.cause.message : String(this.cause);
    return `Could not stop process ${this.pid}: ${detail}`;
  }
}

const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly uid: number;
  readonly startedAtMs: number;
  readonly command: string;
}

const PS_LINE =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/u;

/** Rows of `ps -axww -o pid=,ppid=,uid=,lstart=,command=` run with LC_ALL=C and TZ=UTC. */
export function parsePsRows(stdout: string): ReadonlyArray<ProcessRow> {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    const match = PS_LINE.exec(line);
    if (match === null) continue;
    const startedAtMs = Date.parse(match[4]! + " UTC");
    if (!Number.isFinite(startedAtMs)) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      uid: Number(match[3]),
      startedAtMs,
      command: match[5]!,
    });
  }
  return rows;
}

/**
 * The GOAT home a `serve` command line was started for, or null when it is not one. Paths may
 * hold spaces, so the value runs to the next option.
 */
export function serveBaseDir(command: string): string | null {
  // A GOAT or legacy t3 entry point: an executable, package or checkout path named for it.
  if (!/(?:^|[\s/])(?:goat|t3)/iu.test(command)) return null;
  if (!/(?:^|\s)serve(?:\s|$)/u.test(command)) return null;
  const match = /\s--base-dir(?:=|\s+)(.+?)(?=\s+--[a-z]|$)/u.exec(command);
  return match === null ? null : match[1]!.trim() || null;
}

/**
 * Whether a process can be a stray GOAT server before looking at its home: this user's, not this
 * server, reparented to PID 1 because whatever launched it is gone. A service manager also starts
 * servers under PID 1, so the home decides the rest (strayReason).
 */
export function orphanedServer(
  row: ProcessRow,
  self: { readonly pid: number; readonly uid: number; readonly baseDir: string },
): string | null {
  if (row.pid === self.pid || row.uid !== self.uid || row.ppid !== 1) return null;
  const baseDir = serveBaseDir(row.command);
  return baseDir === null || baseDir === self.baseDir ? null : baseDir;
}

export function strayReason(input: {
  readonly homeExists: boolean;
  readonly homeIsTemporary: boolean;
  readonly ageMs: number;
}): HostStrayProcess["reason"] | null {
  if (!input.homeExists) return "home_deleted";
  if (input.homeIsTemporary && input.ageMs >= STRAY_TEMPORARY_HOME_MIN_AGE_MS)
    return "temporary_home";
  return null;
}

const sameProcess = (left: Pick<ProcessRow, "pid" | "startedAtMs">, right: HostStrayProcess) =>
  left.pid === right.pid && isoAt(left.startedAtMs) === right.startedAt;

export class StrayProcesses extends Context.Service<
  StrayProcesses,
  {
    /** The last scan, refreshed every few minutes. Null before the first, and on Windows. */
    readonly latest: Effect.Effect<HostStrayProcesses | null>;
    /** Rescans, then stops each stray that is still the same process. */
    readonly cleanUp: Effect.Effect<HostStrayCleanupResult, HostMaintenanceError>;
  }
>()("goat/diagnostics/StrayProcesses") {}

const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcess.Platform;
  const uid = yield* HostProcess.UserId;
  const environment = yield* HostProcess.Environment;
  const latestRef = yield* Ref.make<HostStrayProcesses | null>(null);
  const lock = yield* Semaphore.make(1);
  const supported = platform !== "win32" && uid !== undefined;
  const self = { pid: process.pid, uid: uid ?? -1, baseDir: path.resolve(config.baseDir) };

  const realPath = (value: string) =>
    fs.realPath(value).pipe(Effect.orElseSucceed(() => path.resolve(value)));
  const temporaryRoots = Effect.forEach(
    [environment.TMPDIR, "/tmp", "/private/tmp"].filter(
      (root): root is string => root !== undefined && root.length > 0,
    ),
    realPath,
  );

  const listRows = runner
    .run({
      command: "ps",
      args: ["-axww", "-o", "pid=,ppid=,uid=,lstart=,command="],
      env: { LC_ALL: "C", TZ: "UTC" },
      timeout: Duration.seconds(5),
      maxOutputBytes: 8 * 1024 * 1024,
    })
    .pipe(Effect.map((output) => (output.code === 0 ? parsePsRows(output.stdout) : [])));

  const scanNow = Effect.gen(function* () {
    const rows = yield* listRows;
    const roots = yield* temporaryRoots;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const processes: HostStrayProcess[] = [];
    for (const row of rows) {
      const baseDir = orphanedServer(row, self);
      if (baseDir === null) continue;
      const homeExists = yield* fs.exists(baseDir).pipe(Effect.orElseSucceed(() => true));
      const home = homeExists ? yield* realPath(baseDir) : baseDir;
      const reason = strayReason({
        homeExists,
        homeIsTemporary: roots.some((root) => home === root || home.startsWith(root + path.sep)),
        ageMs: now - row.startedAtMs,
      });
      if (reason === null) continue;
      processes.push({
        pid: row.pid,
        startedAt: isoAt(row.startedAtMs),
        kind: "orphaned_server",
        reason,
        baseDir,
      });
    }
    const result: HostStrayProcesses = {
      scannedAt: DateTime.formatIso(yield* DateTime.now),
      processes: processes.toSorted((left, right) => left.startedAt.localeCompare(right.startedAt)),
    };
    yield* Ref.set(latestRef, result);
    return result;
  });
  const scan = lock.withPermits(1)(scanNow);

  const signal = (pid: number, name: "SIGTERM" | "SIGKILL") =>
    Effect.try({
      try: () => process.kill(pid, name),
      catch: (cause) => new StraySignalError({ pid, cause }),
    });

  /** The process is gone, or is no longer the one that was found. */
  const exited = (stray: HostStrayProcess) =>
    listRows.pipe(Effect.map((rows) => !rows.some((row) => sameProcess(row, stray))));

  const stop = Effect.fn("StrayProcesses.stop")(function* (stray: HostStrayProcess) {
    yield* signal(stray.pid, "SIGTERM");
    for (let waited = 0; waited < TERM_GRACE_MS; waited += TERM_POLL_MS) {
      yield* Effect.sleep(Duration.millis(TERM_POLL_MS));
      if (yield* exited(stray)) return "stopped" as const;
    }
    // Checked again right before SIGKILL, so a reused pid is never the one killed.
    if (yield* exited(stray)) return "stopped" as const;
    yield* signal(stray.pid, "SIGKILL");
    return "forced" as const;
  });

  const cleanUp = lock
    .withPermits(1)(
      Effect.gen(function* () {
        const found = yield* scanNow;
        let stopped = 0;
        let forced = 0;
        const failed: Array<{ pid: number; message: string }> = [];
        for (const stray of found.processes) {
          const outcome = yield* stop(stray).pipe(
            Effect.catch((cause) => Effect.succeed({ message: cause.message })),
          );
          if (outcome === "stopped") stopped++;
          else if (outcome === "forced") {
            stopped++;
            forced++;
          } else failed.push({ pid: stray.pid, message: outcome.message });
        }
        if (stopped > 0) yield* Effect.logInfo("Stopped stray GOAT servers", { stopped, forced });
        return { stopped, forced, failed, remaining: yield* scanNow };
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new HostMaintenanceError({
            operation: "clean_up_strays",
            message: "Could not list this machine's processes: " + cause.message,
          }),
      ),
    );

  if (supported) {
    yield* forkParked(
      scan.pipe(
        Effect.catch((cause) => Effect.logWarning("Stray process scan failed", { cause })),
        Effect.repeat(Schedule.spaced(SCAN_INTERVAL)),
      ),
    );
  }

  return StrayProcesses.of({
    latest: Ref.get(latestRef),
    cleanUp: supported
      ? cleanUp
      : Effect.fail(
          new HostMaintenanceError({
            operation: "clean_up_strays",
            message: "Stray process cleanup is not available on this platform.",
          }),
        ),
  });
});

export const layer = Layer.effect(StrayProcesses, make);
