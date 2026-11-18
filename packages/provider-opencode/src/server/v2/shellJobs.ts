import type {
  OrchestrationV2PendingBackgroundTask,
  ProviderDriverKind,
  RunId,
  ThreadId,
} from "@goat/contracts";
import type * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { compareSemverVersions } from "@goat/shared/semver";
import * as Shell from "@opencode/schema/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type * as Semaphore from "effect/Semaphore";
import type { OpenCodeToolResult } from "../toolItems.ts";
import { reportOutcome } from "./adapterHelpers.ts";
import type { ActiveTurn, ThreadState } from "./adapterState.ts";
import { ref, stringField } from "./adapterUtilities.ts";
import { INVENTORY_TIMEOUT } from "./connectionConstants.ts";
import type * as OpenCode2Client from "./OpenCode2Client.ts";
import type * as OpenCode2Server from "./OpenCode2Server.ts";

type ItemStatus = "running" | "completed" | "failed" | "interrupted";
type ShellEvent = Extract<
  OpenCode2Client.OpenCode2StreamEvent,
  { type: "shell.created" | "shell.exited" | "shell.deleted" }
>;

interface TrackedShell {
  state: ThreadState;
  turn?: ActiveTurn;
  toolId?: string;
  tool?: { name: string; input: Record<string, unknown> };
  command: string;
  running: boolean;
  stopping?: boolean;
  output: string;
  cursor: number;
  startedAt?: DateTime.Utc;
  recoveredRunId?: RunId | null;
  published?: boolean;
}

export interface ShellJobDeps {
  readonly connection: () => OpenCode2Server.OpenCode2Connection;
  readonly driver: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly lock: Semaphore.Semaphore;
  readonly threads: ReadonlyMap<string, ThreadState>;
  readonly ownerOf: (sessionId: string) => ThreadState | undefined;
  readonly sessionsOf: (state: ThreadState) => ReadonlyArray<ThreadState>;
  readonly requestTurn: (
    sessionId: string,
  ) => { readonly state: ThreadState; readonly turn: ActiveTurn } | undefined;
  readonly hasBackground: (state: ThreadState) => boolean;
  readonly emit: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<void>;
  readonly emitTool: (
    state: ThreadState,
    turn: ActiveTurn,
    id: string,
    status: ItemStatus,
    result?: OpenCodeToolResult,
  ) => Effect.Effect<void>;
  readonly syncRosterAncestors: (state: ThreadState) => Effect.Effect<void>;
}

/** OpenCode shell tools can return at launch; this follows the native command until it exits or is stopped. */
export const makeShellJobs = (deps: ShellJobDeps) => {
  const { driver, idAllocator, lock, sessionsOf, emit, emitTool, syncRosterAncestors } = deps;
  const client = () => deps.connection().client;
  const shellInfo = new Map<string, Shell.Info>();
  const shells = new Map<string, TrackedShell>();

  const fetchShellOutput = Effect.fn("OpenCode2Adapter.fetchShellOutput")(function* (
    id: string,
    snapshot: { directory: string; cursor: number; output: string },
    settled = false,
  ) {
    let { cursor, output } = snapshot;
    // Bound each read and retained UI text; the native byte cursor must never use JS string lengths.
    for (let page = 0; page < (settled ? 5 : 4); page++) {
      const { data } = yield* client().shell.output({
        id: Shell.ID.make(id),
        location: { directory: snapshot.directory },
        cursor,
        limit: 65536,
      });
      output = (output + data.output).slice(-262144);
      const previous = cursor;
      cursor = data.cursor;
      if (data.cursor >= data.size || data.cursor <= previous) break;
      if (settled && data.size - data.cursor > 262144) {
        cursor = data.size - 262144;
        output = "";
      }
    }
    return { cursor, output };
  }, Effect.timeout(INVENTORY_TIMEOUT));

  const readShellOutput = Effect.fn("OpenCode2Adapter.readShellOutput")(function* (
    id: string,
    settled = false,
  ) {
    const shell = shells.get(id);
    if (shell === undefined) return;
    const output = yield* fetchShellOutput(
      id,
      { directory: shell.state.directory, cursor: shell.cursor, output: shell.output },
      settled,
    );
    Object.assign(shell, output);
  });

  const emitShell = Effect.fnUntraced(function* (id: string, status: ItemStatus, exit?: number) {
    const shell = shells.get(id);
    if (shell === undefined) return;
    if (shell.turn === undefined || shell.toolId === undefined || shell.tool === undefined) {
      const updatedAt = yield* DateTime.now;
      yield* emit({
        type: "turn_item.updated",
        driver,
        sessionScoped: true,
        turnItem: {
          id: idAllocator.derive.turnItemFromProviderItem({ driver, nativeItemId: id }),
          threadId: shell.state.providerThread.appThreadId ?? deps.threadId,
          runId: shell.recoveredRunId ?? null,
          nodeId: null,
          providerThreadId: shell.state.providerThread.id,
          providerTurnId: null,
          nativeItemRef: ref(id),
          parentItemId: null,
          ordinal: 0,
          status,
          title: null,
          startedAt: shell.startedAt ?? updatedAt,
          completedAt: status === "running" ? null : updatedAt,
          updatedAt,
          type: "command_execution",
          input: shell.command,
          output: shell.output,
          ...(exit === undefined ? {} : { exitCode: exit }),
        },
      });
      shell.published = true;
      return;
    }
    shell.turn.tools.set(shell.toolId, shell.tool);
    yield* emitTool(shell.state, shell.turn, shell.toolId, status, {
      output: shell.output,
      nativeTaskId: id,
      metadata: { shellID: id, exit },
    });
    shell.turn.tools.delete(shell.toolId);
    shell.published = true;
  });

  const settledStatus = (info: Pick<Shell.Info, "status" | "exit"> | undefined): ItemStatus =>
    info?.status === "killed" ? "interrupted" : info?.exit === 0 ? "completed" : "failed";

  const stopShell = Effect.fn("OpenCode2Adapter.stopShell")(function* (id: string) {
    const shell = shells.get(id);
    if (shell === undefined || !shell.running) return;
    yield* readShellOutput(id, true).pipe(Effect.ignore({ log: true }));
    shell.stopping = true;
    yield* client()
      .shell.remove({ id: Shell.ID.make(id), location: { directory: shell.state.directory } })
      .pipe(
        Effect.timeout(INVENTORY_TIMEOUT),
        Effect.onError(() =>
          Effect.sync(() => {
            shell.stopping = false;
          }),
        ),
      );
    shell.stopping = false;
    shell.running = false;
    shell.state.stoppedChildren.add(id);
    yield* emitShell(id, "interrupted");
    shells.delete(id);
    shellInfo.delete(id);
    yield* syncRosterAncestors(shell.state);
  });

  const recover = Effect.fn("OpenCode2Adapter.recoverShells")(
    function* (state: ThreadState) {
      const connection = deps.connection();
      if (compareSemverVersions(connection.version, "2.2.1") < 0) return;
      const jobs =
        compareSemverVersions(connection.version, "2.2.6") >= 0 &&
        connection.shellJobs !== undefined
          ? yield* connection.shellJobs(state.sessionId).pipe(Effect.option)
          : undefined;
      const data =
        jobs?._tag === "Some"
          ? jobs.value.data.map((job) => ({
              id: Shell.ID.make(job.shellID),
              command: job.command,
              metadata: { sessionID: job.sessionID },
            }))
          : (yield* client().shell.list({ location: { directory: state.directory } })).data;
      for (const info of data) {
        const sessionId = stringField(info.metadata, "sessionID");
        const owner =
          sessionId === undefined
            ? undefined
            : (deps.threads.get(sessionId) ??
              deps.ownerOf(sessionId) ??
              (jobs?._tag === "Some" ? state : undefined));
        if (owner === undefined || !sessionsOf(state).includes(owner)) continue;
        if (shells.has(info.id)) continue;
        if (state.active === undefined && !deps.hasBackground(state)) {
          state.sessionScopedBackground = true;
          delete state.publishedBackgroundWork;
        }
        const target = deps.requestTurn(owner.sessionId);
        shells.set(info.id, {
          state: owner,
          ...(target === undefined
            ? {
                recoveredRunId:
                  owner.providerThread.lastRunOrdinal === null
                    ? null
                    : idAllocator.derive.run({
                        threadId: owner.providerThread.appThreadId ?? deps.threadId,
                        ordinal: owner.providerThread.lastRunOrdinal,
                      }),
              }
            : {
                turn: target.turn,
                toolId: info.id,
                tool: { name: "shell", input: { command: info.command } },
              }),
          command: info.command,
          running: true,
          output: "",
          cursor: 0,
        });
      }
      for (const [id, shell] of shells) {
        if (!shell.running || !sessionsOf(state).includes(shell.state)) continue;
        yield* Effect.gen(function* () {
          const found = yield* client()
            .shell.get({ id: Shell.ID.make(id), location: { directory: shell.state.directory } })
            .pipe(
              Effect.timeout(INVENTORY_TIMEOUT),
              Effect.catchTags({ ShellNotFoundError: () => Effect.undefined }),
            );
          if (found === undefined) {
            shell.running = false;
            yield* emitShell(id, "interrupted");
            shells.delete(id);
            return;
          }
          const info = found.data;
          shell.startedAt = DateTime.makeUnsafe(info.time.started);
          yield* readShellOutput(id, info.status !== "running").pipe(Effect.ignore({ log: true }));
          shell.running = info.status === "running";
          yield* emitShell(id, shell.running ? "running" : settledStatus(info), info.exit);
          if (!shell.running) shells.delete(id);
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not recover an OpenCode shell.", cause).pipe(
              Effect.andThen(emitShell(id, "running")),
            ),
          ),
        );
      }
    },
    (effect, state) =>
      lock.withPermit(
        effect.pipe(
          Effect.timeout(INVENTORY_TIMEOUT),
          Effect.ensuring(
            Effect.gen(function* () {
              for (const [id, shell] of shells) {
                if (
                  shell.running &&
                  shell.published !== true &&
                  sessionsOf(state).includes(shell.state)
                )
                  yield* emitShell(id, "running");
              }
              yield* syncRosterAncestors(state).pipe(Effect.ignore({ log: true }));
            }),
          ),
        ),
      ),
  );

  /** Settles a launched background shell; returns false when the tool result is an ordinary one. */
  const onToolSuccess = Effect.fnUntraced(function* (
    state: ThreadState,
    turn: ActiveTurn,
    data: {
      readonly id: string;
      readonly metadata?: Readonly<Record<string, unknown>> | undefined;
    },
  ) {
    const shellId = stringField(data.metadata, "shellID");
    const tool = turn.tools.get(data.id);
    if (
      shellId === undefined ||
      tool?.name !== "shell" ||
      data.metadata?.["exit"] !== undefined ||
      data.metadata?.["signal"] !== undefined ||
      data.metadata?.["timeout"] === true
    ) {
      if (shellId !== undefined) shellInfo.delete(shellId);
      return false;
    }
    const tracked: TrackedShell = {
      state,
      turn,
      toolId: data.id,
      tool,
      command: stringField(tool.input, "command") ?? "Shell command",
      running: true,
      output: "",
      cursor: 0,
    };
    shells.set(shellId, tracked);
    yield* readShellOutput(shellId).pipe(Effect.ignore({ log: true }));
    const known = shellInfo.get(shellId);
    tracked.running = known === undefined || known.status === "running";
    yield* emitShell(shellId, tracked.running ? "running" : settledStatus(known), known?.exit);
    yield* syncRosterAncestors(state);
    return true;
  });

  /** Handles a shell completion notice; returns false for reports from other sources. */
  const onReport = Effect.fnUntraced(function* (
    state: ThreadState,
    inboxId: string,
    payload: {
      readonly text: string;
      readonly description?: string | undefined;
      readonly metadata?: Readonly<Record<string, unknown>> | undefined;
    },
  ) {
    if (stringField(payload.metadata, "source") !== "shell") return false;
    const id = stringField(payload.metadata, "shellID");
    const shell = id === undefined ? undefined : shells.get(id);
    if (shell !== undefined && shell.state !== state) return true;
    const outcome = reportOutcome(stringField(payload.metadata, "state"));
    state.reports.set(inboxId, {
      inboxId,
      childId: id ?? inboxId,
      text: payload.text,
      report: { kind: "command", label: shell?.command ?? payload.description, outcome },
    });
    if (id !== undefined && shell?.stopping !== true) {
      if (shell?.running === true && shell.state === state) {
        yield* readShellOutput(id, true).pipe(Effect.ignore({ log: true }));
        shell.running = false;
        yield* emitShell(
          id,
          outcome === "failed" ? "failed" : outcome === "cancelled" ? "interrupted" : "completed",
        );
      }
      shells.delete(id);
      shellInfo.delete(id);
    }
    return true;
  });

  const onEvent = Effect.fnUntraced(function* (event: ShellEvent) {
    if (event.type === "shell.created") {
      const sessionId = stringField(event.data.info.metadata, "sessionID");
      if (sessionId !== undefined && deps.ownerOf(sessionId) !== undefined) {
        shellInfo.set(event.data.info.id, event.data.info);
        const oldest = shellInfo.keys().next();
        if (shellInfo.size > 128 && oldest.done !== true) shellInfo.delete(oldest.value);
      }
      return;
    }
    const known = shellInfo.get(event.data.id);
    if (known !== undefined)
      shellInfo.set(event.data.id, {
        ...known,
        status: event.type === "shell.deleted" ? "killed" : event.data.status,
        exit: "exit" in event.data ? event.data.exit : undefined,
      });
    const shell = shells.get(event.data.id);
    if (shell === undefined || !shell.running || shell.stopping === true) return;
    if (event.type === "shell.exited")
      yield* readShellOutput(event.data.id, true).pipe(Effect.ignore({ log: true }));
    shell.running = false;
    const exit = "exit" in event.data ? event.data.exit : undefined;
    yield* emitShell(
      event.data.id,
      event.type === "shell.deleted" || event.data.status === "killed"
        ? "interrupted"
        : exit === 0
          ? "completed"
          : "failed",
      exit,
    );
    shells.delete(event.data.id);
    shellInfo.delete(event.data.id);
    yield* syncRosterAncestors(shell.state);
  });

  const poll = Effect.gen(function* () {
    const snapshots = yield* lock.withPermit(
      Effect.sync(() =>
        [...shells]
          .filter(([, shell]) => shell.running)
          .map(([id, shell]) => ({
            id,
            shell,
            cursor: shell.cursor,
            output: shell.output,
            directory: shell.state.directory,
          })),
      ),
    );
    yield* Effect.forEach(
      snapshots,
      (snapshot) =>
        fetchShellOutput(snapshot.id, snapshot).pipe(
          Effect.flatMap((next) =>
            lock.withPermit(
              Effect.gen(function* () {
                const shell = shells.get(snapshot.id);
                // An exit, Stop, or recovery may have consumed this cursor while the request was in flight.
                if (shell !== snapshot.shell || !shell.running || shell.cursor !== snapshot.cursor)
                  return;
                if (next.cursor <= shell.cursor) return;
                Object.assign(shell, next);
                yield* emitShell(snapshot.id, "running");
              }),
            ),
          ),
          Effect.ignore({ log: true }),
        ),
      { concurrency: 4, discard: true },
    );
  }).pipe(Effect.repeat(Schedule.spaced("2 seconds")));

  const runningFor = (state: ThreadState) =>
    [...shells].filter(([, shell]) => shell.running && sessionsOf(state).includes(shell.state));

  return {
    isShellEvent: (event: OpenCode2Client.OpenCode2StreamEvent): event is ShellEvent =>
      event.type === "shell.created" ||
      event.type === "shell.exited" ||
      event.type === "shell.deleted",
    owes: (state: ThreadState) =>
      [...shells.values()].some((shell) => shell.state === state && shell.running),
    rosterTasks: (state: ThreadState): Array<OrchestrationV2PendingBackgroundTask> =>
      runningFor(state).map(([taskId, shell]) => ({
        taskId,
        kind: "command" as const,
        description: shell.command,
        ...(shell.state.subagent === undefined
          ? {}
          : { parentTaskId: shell.state.subagent.call.nativeId }),
      })),
    recover,
    onToolSuccess,
    onReport,
    onEvent,
    poll,
    stopAll: Effect.fnUntraced(function* (state: ThreadState) {
      for (const [id] of runningFor(state))
        yield* lock.withPermit(stopShell(id)).pipe(Effect.ignore({ log: true }));
    }),
    /** Stops one owned shell; false when the task is not a shell this thread owns. */
    stopTask: (state: ThreadState | undefined, taskId: string) => {
      const shell = shells.get(taskId);
      if (state === undefined || shell === undefined || !sessionsOf(state).includes(shell.state))
        return Effect.succeed(false);
      return lock.withPermit(stopShell(taskId)).pipe(Effect.as(true));
    },
  };
};
