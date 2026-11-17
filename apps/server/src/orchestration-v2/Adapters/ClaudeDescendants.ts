import { signalProcessGroup } from "@goat/provider-core/server/processGroup";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import type { ProcessRunner } from "../../processRunner.ts";

export interface ClaudeProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly started: string;
}

export type ClaudeProcessTable = Effect.Effect<Option.Option<ReadonlyArray<ClaudeProcessRow>>>;

/** Parses `ps -A -o pid=,ppid=,pgid=,lstart=`; pid plus start time tells a process from a reused pid. */
export function parseClaudeProcessTable(table: string): ReadonlyArray<ClaudeProcessRow> {
  return table.split("\n").flatMap((line) => {
    const [pid, ppid, pgid, ...started] = line.trim().split(/\s+/);
    const row = {
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      started: started.join(" "),
    };
    return Number.isSafeInteger(row.pid) &&
      Number.isSafeInteger(row.ppid) &&
      Number.isSafeInteger(row.pgid) &&
      row.started
      ? [row]
      : [];
  });
}

// A table cut short by the output cap or a timeout fails whole, so it never looks like exits.
export const readClaudeProcessTable = (runner: ProcessRunner["Service"]): ClaudeProcessTable =>
  runner
    .run({
      command: "ps",
      args: ["-A", "-o", "pid=,ppid=,pgid=,lstart="],
      env: { LC_ALL: "C", TZ: "UTC" },
      timeout: "5 seconds",
      maxOutputBytes: 8 * 1024 * 1024,
    })
    .pipe(
      Effect.map((result) =>
        result.code === 0 && !result.stdoutTruncated
          ? Option.some(parseClaudeProcessTable(result.stdout))
          : Option.none(),
      ),
      Effect.orElseSucceed(() => Option.none()),
    );

export function claudeDescendants(
  rows: ReadonlyArray<ClaudeProcessRow>,
  rootPids: ReadonlyArray<number>,
): ReadonlyArray<ClaudeProcessRow> {
  const children = Map.groupBy(rows, (row) => row.ppid);
  const found: Array<ClaudeProcessRow> = [];
  const seen = new Set<number>(rootPids);
  const pending = [...rootPids];
  for (let parent = pending.pop(); parent !== undefined; parent = pending.pop()) {
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      found.push(child);
      pending.push(child.pid);
    }
  }
  return found;
}

function serverAndAncestors(rows: ReadonlyArray<ClaudeProcessRow>): ReadonlySet<number> {
  const parents = new Map(rows.map((row) => [row.pid, row.ppid]));
  const pids = new Set<number>();
  for (let pid: number | undefined = process.pid; pid !== undefined && pid > 1;) {
    if (pids.has(pid)) break;
    pids.add(pid);
    pid = parents.get(pid);
  }
  return pids;
}

// A job leading its own group takes the processes it started since with it.
export function killClaudeDescendant(row: ClaudeProcessRow) {
  try {
    if (row.pgid === row.pid) signalProcessGroup(row.pid, "SIGKILL");
    else process.kill(row.pid, "SIGKILL");
  } catch {}
}

export interface ClaudeDescendantTracker {
  /** Records jobs started since the last sample; run before the CLI is told to exit. */
  readonly refresh: Effect.Effect<void>;
  /** After the CLI exited: stops what it left that is still the same process. */
  readonly stop: Effect.Effect<void>;
}

export interface ClaudeDescendantSampler {
  readonly track: (cliPid: number) => ClaudeDescendantTracker;
}

/**
 * Without an agent scope, a job that left the CLI's group escapes the group kill and is
 * re-parented once the CLI exits. One sampler per server records every such CLI's tree from one
 * process table per interval, and polls only while one of those CLIs lives.
 */
export const makeClaudeDescendantSampler = Effect.fn("ClaudeDescendantSampler.make")(
  function* (input: {
    readonly readTable: ClaudeProcessTable;
    readonly interval: Duration.Input;
    readonly kill?: (row: ClaudeProcessRow) => void;
  }) {
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    const kill = input.kill ?? killClaudeDescendant;
    const live = new Set<(rows: ReadonlyArray<ClaudeProcessRow>) => void>();
    let polling: Fiber.Fiber<unknown> | undefined;
    let warned = false;
    const readTable = input.readTable.pipe(
      Effect.tap((table) =>
        Option.isNone(table) && !warned
          ? Effect.sync(() => (warned = true)).pipe(
              Effect.andThen(
                Effect.logWarning("orchestration-v2.claude-process-table-unavailable"),
              ),
            )
          : Effect.void,
      ),
    );
    const sample = readTable.pipe(
      Effect.map(Option.map((rows) => live.forEach((observe) => observe(rows)))),
    );

    const track = (cliPid: number): ClaudeDescendantTracker => {
      const tracked = new Map<string, ClaudeProcessRow>();
      const identity = (row: ClaudeProcessRow) => `${row.pid} ${row.started}`;
      // After exit the CLI's pid may belong to an unrelated process, so only tracked jobs are roots.
      const observe = (rows: ReadonlyArray<ClaudeProcessRow>, cliRunning: boolean) => {
        const running = new Set(rows.map(identity));
        const roots = [
          ...(cliRunning ? [cliPid] : []),
          ...[...tracked.values()].flatMap((row) => (running.has(identity(row)) ? [row.pid] : [])),
        ];
        for (const row of claudeDescendants(rows, roots)) tracked.set(identity(row), row);
        return running;
      };
      const observeRunning = (rows: ReadonlyArray<ClaudeProcessRow>) => void observe(rows, true);
      live.add(observeRunning);
      if (polling === undefined)
        polling = runFork(sample.pipe(Effect.repeat(Schedule.spaced(input.interval))));
      let stopped = false;
      return {
        refresh: Effect.suspend(() =>
          stopped ? Effect.void : readTable.pipe(Effect.map(Option.map(observeRunning))),
        ),
        stop: Effect.suspend(() => {
          if (stopped) return Effect.void;
          stopped = true;
          live.delete(observeRunning);
          const idle = live.size === 0 ? polling : undefined;
          if (idle !== undefined) polling = undefined;
          return (idle === undefined ? Effect.void : Fiber.interrupt(idle)).pipe(
            Effect.andThen(readTable),
            Effect.map(
              Option.map((rows) => {
                const running = observe(rows, false);
                const protectedPids = serverAndAncestors(rows);
                for (const row of tracked.values())
                  if (running.has(identity(row)) && row.pid > 1 && !protectedPids.has(row.pid))
                    kill(row);
              }),
            ),
          );
        }),
      };
    };
    return { track } satisfies ClaudeDescendantSampler;
  },
);
