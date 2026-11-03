import { liveInCheckPhase } from "./checkPhase.ts";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import type { AgentScopeShape } from "@goat/shared/AgentScope";
import * as NodeOS from "node:os";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";

export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly rssBytes: number;
  readonly zombie: boolean;
}
type AgentProcess = { readonly pid: number; readonly isRunning: () => boolean };
type Registration = {
  readonly process: AgentProcess;
  readonly threadId: string | undefined;
  readonly shared: boolean;
  readonly generation: number | undefined;
};
const MAX_ENTRIES = 1000;
const GiB = 1024 ** 3;
const automaticAgentMemoryLimitBytes = (totalBytes: number) =>
  Math.min(Math.floor(totalBytes / 2), 16 * GiB);
export const resolveAgentMemoryLimitBytes = (setting: number | null, totalBytes: number) =>
  setting === null
    ? automaticAgentMemoryLimitBytes(totalBytes)
    : setting === 0
      ? null
      : setting * GiB;
export function parseProcessTable(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) continue;
    const [pid, ppid, pgid, rss] = match.slice(1, 5).map(Number);
    if (
      pid === undefined ||
      ppid === undefined ||
      pgid === undefined ||
      rss === undefined ||
      !Number.isSafeInteger(rss * 1024)
    )
      continue;
    rows.push({
      pid,
      ppid,
      pgid,
      rssBytes: rss * 1024,
      zombie: match[5]?.startsWith("Z") === true,
    });
  }
  return rows;
}
function indexRows(rows: ReadonlyArray<ProcessRow>) {
  const byPid = new Map<number, ProcessRow>();
  const byGroup = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    if (!byPid.has(row.pid)) byPid.set(row.pid, row);
    const group = byGroup.get(row.pgid) ?? [];
    group.push(row);
    byGroup.set(row.pgid, group);
  }
  return { byPid, byGroup };
}
function treeOfIndexed(
  index: ReturnType<typeof indexRows>,
  children: ReadonlyMap<number, ReadonlyArray<ProcessRow | undefined>>,
  rootPid: number,
) {
  const root = index.byPid.get(rootPid);
  if (root === undefined || root.zombie) return undefined;
  const pending = [root, ...(index.byGroup.get(rootPid) ?? [])];
  const visited = new Set<number>();
  let rssBytes = 0;
  while (pending.length > 0) {
    const row = pending.pop();
    if (row === undefined || visited.has(row.pid)) continue;
    visited.add(row.pid);
    rssBytes += row.rssBytes;
    for (const child of children.get(row.pid) ?? []) if (child !== undefined) pending.push(child);
  }
  return { rssBytes, processCount: visited.size, leader: root.pgid === rootPid };
}
export function treeOf(
  rows: ReadonlyArray<ProcessRow>,
  children: ReadonlyMap<number, ReadonlyArray<ProcessRow | undefined>>,
  rootPid: number,
  index = indexRows(rows),
) {
  return treeOfIndexed(index, children, rootPid);
}
export const makeAgentMemoryGuard = Effect.fn("AgentMemoryGuard.make")(function* <E>(deps: {
  sample: Effect.Effect<ReadonlyArray<ProcessRow>, E>;
  limitBytes: Effect.Effect<number | null>;
  signal: (pid: number) => void;
  inCheckPhase: <A>(block: () => A) => Effect.Effect<A>;
}) {
  const watched = new Map<number, Registration>();
  const generations = new Map<string, number>();
  const marked = new Set<string>();
  let nextGeneration = 0;
  let sampleFailed = false;
  const trim = <K, V>(map: Map<K, V> | Set<K>) => {
    while (map.size > MAX_ENTRIES) {
      const first = map.keys().next();
      if (first.done) break;
      map.delete(first.value);
    }
  };
  const pruneGeneration = (threadId: string | undefined) => {
    if (threadId === undefined || marked.has(threadId)) return;
    if (![...watched.values()].some((reg) => reg.threadId === threadId))
      generations.delete(threadId);
  };
  const watch = (input: {
    process: AgentProcess;
    threadId?: string | undefined;
    shared?: boolean | undefined;
  }) =>
    deps.inCheckPhase(() => {
      for (const [pid, reg] of watched)
        if (!reg.process.isRunning()) {
          watched.delete(pid);
          pruneGeneration(reg.threadId);
        }
      const previous = watched.get(input.process.pid);
      watched.delete(input.process.pid);
      if (previous) pruneGeneration(previous.threadId);
      let generation: number | undefined;
      if (input.threadId !== undefined) {
        generation = generations.get(input.threadId);
        if (generation === undefined) {
          generation = ++nextGeneration;
          generations.set(input.threadId, generation);
          trim(generations);
        }
      }
      watched.set(input.process.pid, {
        process: input.process,
        threadId: input.threadId,
        shared: input.shared === true,
        generation,
      });
      while (watched.size > MAX_ENTRIES) {
        const first = watched.entries().next();
        if (first.done) break;
        watched.delete(first.value[0]);
        pruneGeneration(first.value[1].threadId);
      }
    });
  const clear = (threadId: string) =>
    Effect.sync(() => {
      marked.delete(threadId);
      generations.delete(threadId);
      if ([...watched.values()].some((reg) => reg.threadId === threadId)) {
        generations.set(threadId, ++nextGeneration);
        trim(generations);
      }
    });
  const tick = Effect.gen(function* () {
    if (watched.size === 0) return;
    const limit = yield* deps.limitBytes;
    if (limit === null) return;
    const registrations = [...watched.entries()];
    const sampled = yield* Effect.result(deps.sample);
    if (sampled._tag === "Failure") {
      if (sampleFailed) yield* Effect.logDebug("Agent memory sample failed", sampled.failure);
      else yield* Effect.logWarning("Agent memory sample failed", sampled.failure);
      sampleFailed = true;
      return;
    }
    if (sampleFailed) yield* Effect.logInfo("Agent memory sampling recovered");
    sampleFailed = false;
    const rows = sampled.success;
    const children = new Map<number, ProcessRow[]>();
    for (const row of rows) {
      const list = children.get(row.ppid) ?? [];
      list.push(row);
      children.set(row.ppid, list);
    }
    const index = indexRows(rows);
    const decisions = registrations.map(([pid, reg]) => ({
      pid,
      reg,
      tree: treeOf(rows, children, pid, index),
    }));
    const results = yield* deps.inCheckPhase(() => {
      const killed: Array<{
        pid: number;
        reg: Registration;
        tree: NonNullable<ReturnType<typeof treeOf>>;
        partial: boolean;
      }> = [];
      // libuv 1.52.1 uv__wait_children runs in uv__io_poll and completes the exit callback batch before check phase.
      // Node sets exitCode/signalCode in onexit and the Effect spawner completes its exit Deferred in that callback.
      // This holds only when this Node loop owns and reaps the child.
      for (const { pid, reg, tree } of decisions) {
        if (watched.get(pid) !== reg) continue;
        if (!reg.process.isRunning()) {
          watched.delete(pid);
          pruneGeneration(reg.threadId);
          continue;
        }
        if (tree === undefined || tree.rssBytes <= limit) continue;
        try {
          deps.signal(pid);
        } catch {
          continue;
        }
        watched.delete(pid);
        if (
          !reg.shared &&
          reg.threadId !== undefined &&
          generations.get(reg.threadId) === reg.generation
        ) {
          marked.delete(reg.threadId);
          marked.add(reg.threadId);
          while (marked.size > MAX_ENTRIES) {
            const oldest = marked.values().next();
            if (oldest.done) break;
            marked.delete(oldest.value);
            pruneGeneration(oldest.value);
          }
        }
        pruneGeneration(reg.threadId);
        let partial = false;
        if (tree.leader)
          try {
            deps.signal(-pid);
          } catch {
            partial = true;
          }
        killed.push({ pid, reg, tree, partial });
      }
      return killed;
    });
    for (const { pid, reg, tree, partial } of results)
      yield* Effect.logWarning("Agent memory limit exceeded", {
        pid,
        threadId: reg.threadId,
        shared: reg.shared,
        rssBytes: tree.rssBytes,
        limitBytes: limit,
        processCount: tree.processCount,
        partial,
      });
  });
  yield* Effect.forever(
    Effect.sleep("30 seconds").pipe(
      Effect.andThen(
        tick.pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("Agent memory guard tick failed", cause),
          ),
        ),
      ),
    ),
  ).pipe(Effect.forkScoped);
  return {
    watch,
    clear,
    oomKilled: (threadId: string) => Effect.sync(() => marked.has(threadId)),
    trackingCounts: () => ({
      watched: watched.size,
      generations: generations.size,
      marked: marked.size,
    }),
  };
});

export const makeDarwinAgentScope = Effect.fn("AgentMemoryGuard.makeDarwinAgentScope")(
  function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    const settings = yield* ServerSettings.ServerSettingsService;
    const guard = yield* makeAgentMemoryGuard({
      sample: runner
        .run({ command: "ps", args: ["-axo", "pid=,ppid=,pgid=,rss=,stat="], timeout: "5 seconds" })
        .pipe(
          Effect.flatMap((output) =>
            output.code === 0 && !output.stdoutTruncated && !output.stdoutInvalidUtf8
              ? Effect.succeed(parseProcessTable(output.stdout))
              : Effect.fail("ps output unavailable"),
          ),
        ),
      limitBytes: settings.getSettings.pipe(
        Effect.map((value) =>
          resolveAgentMemoryLimitBytes(value.agentMemoryLimitGiB, NodeOS.totalmem()),
        ),
        Effect.orElseSucceed(() => automaticAgentMemoryLimitBytes(NodeOS.totalmem())),
      ),
      signal: (pid) => {
        process.kill(pid, "SIGKILL");
      },
      inCheckPhase: liveInCheckPhase,
    });
    const scope: AgentScopeShape = {
      watch: guard.watch,
      clear: guard.clear,
      oomKilled: guard.oomKilled,
      wrap: ({ command, args }: { command: string; args: ReadonlyArray<string> }) =>
        Effect.succeed({ command, args }),
      stop: () => Effect.void,
      kill: () => Effect.succeed(false),
    };
    return scope;
  },
);
