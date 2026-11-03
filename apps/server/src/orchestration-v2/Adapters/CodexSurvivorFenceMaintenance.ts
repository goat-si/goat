import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Deferred from "effect/Deferred";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import type * as CodexClient from "effect-codex-app-server/client";
import type { ProviderTurnId } from "@goat/contracts";
import type {
  CodexGoalBlock,
  CodexInstanceRecordKey,
  CodexSurvivorBinding,
  CodexSurvivors,
} from "../../provider/CodexSurvivors.ts";
import { isVerifiedCodexProcessLoss } from "./CodexSurvivorSessionLoss.ts";
import { clearConflictFences, releaseEndedConflicts } from "./CodexSurvivorConflictFence.ts";
import type { SurvivorRequestStops } from "./CodexSurvivorRequestStops.ts";

export type SurvivorSignal =
  | { readonly type: "End" | "Stop" | "Goal" | "SessionLost" }
  | { readonly type: "Conflict" | "ConflictEnd"; readonly id: string };
export type SurvivorEntry = {
  readonly nativeTurnId: string;
  readonly signals: Queue.Queue<SurvivorSignal>;
  readonly binding: CodexSurvivorBinding;
  readonly service: CodexSurvivors["Service"];
  readonly gate: Semaphore.Semaphore;
  readonly lost: Deferred.Deferred<void>;
  done: Deferred.Deferred<void> | undefined;
  providerTurnId: ProviderTurnId | undefined;
  stopRecorded: boolean;
  interruptSent: boolean;
  overflow: boolean;
  terminalEvidence: boolean;
  retainingFence: boolean;
  fenceWriteFailed: boolean;
  /** Newer native turns fenced after the survivor ended, with whether each stop is durable. */
  readonly conflicts: Map<string, boolean>;
  readonly stops: SurvivorRequestStops;
};
export type SurvivorWaiting = Map<string, SurvivorEntry>;

export const holdsFence = (entry: SurvivorEntry) =>
  entry.retainingFence || entry.conflicts.size > 0;

export const forgetUnblockedSurvivor = Effect.fn("CodexSurvivorFenceMaintenance.forget")(
  function* (input: {
    readonly waiting: SurvivorWaiting;
    readonly tracked: SurvivorWaiting;
    readonly entry: SurvivorEntry;
  }) {
    const { entry, waiting, tracked } = input;
    const nativeThreadId = entry.binding.nativeThreadId;
    if (waiting.has(nativeThreadId)) return;
    // A goal block must not hold the binding: /goal pause is itself a queued start.
    yield* entry.service.release(entry.binding);
    if (yield* entry.service.hasGoalBlock(entry.binding.threadId)) return;
    if (tracked.get(nativeThreadId) === entry) tracked.delete(nativeThreadId);
  },
);

export const refreshSurvivorGoalBlock = Effect.fn("CodexSurvivorFenceMaintenance.refreshGoal")(
  function* (input: {
    readonly client: CodexClient.CodexAppServerClient["Service"];
    readonly entry: {
      readonly binding: CodexInstanceRecordKey & CodexGoalBlock;
      readonly service: CodexSurvivors["Service"];
    };
  }) {
    const { binding, service } = input.entry;
    const blocks = (yield* service.getGoalBlocks(binding.threadId)).filter(
      ({ record, block }) =>
        record.instanceId === binding.instanceId &&
        record.recordName === binding.recordName &&
        block.nativeThreadId === binding.nativeThreadId,
    );
    if (blocks.length === 0) return;
    const goal = yield* input.client
      .request("thread/goal/get", { threadId: binding.nativeThreadId })
      .pipe(
        Effect.map((response) =>
          response.goal == null
            ? ("inactive" as const)
            : response.goal.status === "paused" || response.goal.status === "complete"
              ? ("inactive" as const)
              : ("active" as const),
        ),
        Effect.catchTags({
          CodexAppServerRequestError: (error) =>
            error.code === -32600 && error.errorMessage === "goals feature is disabled"
              ? Effect.succeed("inactive" as const)
              : Effect.fail(error),
        }),
        Effect.timeout("15 seconds"),
        Effect.option,
      );
    if (Option.isNone(goal) || goal.value !== "inactive") return;
    if ((yield* service.getStopObligations(binding.threadId)).length > 0) return;
    for (const { record, block } of blocks) yield* service.clearGoalBlock(record, block);
  },
);

const clearSurvivorFence = Effect.fn("CodexSurvivorFenceMaintenance.clear")(function* (
  entry: SurvivorEntry,
) {
  if (!entry.retainingFence) return false;
  const { service, binding } = entry;
  if (entry.fenceWriteFailed) {
    yield* service.recordStopObligation(binding, binding);
    entry.fenceWriteFailed = false;
  }
  yield* service.clearStopObligation(binding, binding);
  entry.retainingFence = false;
  return true;
});

const verifyRetainedSurvivorDeath = Effect.fn("CodexSurvivorFenceMaintenance.verifyDeath")(
  function* (entry: SurvivorEntry) {
    if (!holdsFence(entry)) return false;
    const result = yield* entry.service
      .classifyRecord(entry.binding)
      .pipe(Effect.orElseSucceed(() => ({ type: "unverifiable" as const })));
    if (!isVerifiedCodexProcessLoss(result)) return false;
    yield* clearConflictFences(entry);
    yield* clearSurvivorFence(entry);
    return true;
  },
);

export type GoalMaintenance = Map<string, { dirty: boolean; terminal: boolean }>;
export type PersistedGoals = ReadonlyMap<
  string,
  ReadonlyArray<{ readonly record: CodexInstanceRecordKey; readonly block: CodexGoalBlock }>
>;

// Streaming notifications share this callback, so only maintenance signals create a fiber.
export const observeSurvivorNotification = Effect.fnUntraced(function* (input: {
  readonly client: CodexClient.CodexAppServerClient["Service"];
  readonly scope: Scope.Scope;
  readonly waiting: SurvivorWaiting;
  readonly tracked: SurvivorWaiting;
  readonly goals: PersistedGoals;
  readonly service: CodexSurvivors["Service"] | undefined;
  readonly maintenance: GoalMaintenance;
  readonly method: string;
  readonly payload: unknown;
  readonly signal: boolean;
}) {
  const { client, scope, waiting, tracked, goals, service, maintenance, method, payload, signal } =
    input;
  if (
    !signal ||
    (method !== "thread/goal/updated" &&
      method !== "thread/goal/cleared" &&
      method !== "turn/completed") ||
    typeof payload !== "object" ||
    payload === null ||
    !("threadId" in payload) ||
    typeof payload.threadId !== "string"
  )
    return;
  const threadId = payload.threadId;
  const entry = tracked.get(threadId);
  if (entry === undefined && !goals.has(threadId)) return;
  const turn =
    "turn" in payload && typeof payload.turn === "object" && payload.turn !== null
      ? payload.turn
      : undefined;
  const terminal =
    entry !== undefined &&
    method === "turn/completed" &&
    turn !== undefined &&
    "id" in turn &&
    turn.id === entry.nativeTurnId &&
    "status" in turn &&
    turn.status !== "inProgress";
  if (terminal) entry.terminalEvidence = true;
  const existing = maintenance.get(threadId);
  if (existing !== undefined) {
    existing.dirty = true;
    existing.terminal ||= terminal;
    return;
  }
  const state = { dirty: true, terminal };
  maintenance.set(threadId, state);
  yield* Effect.gen(function* () {
    while (
      yield* Effect.sync(() => {
        if (!state.dirty) {
          maintenance.delete(threadId);
          return false;
        }
        state.dirty = false;
        return true;
      })
    ) {
      const current = tracked.get(threadId);
      const terminalPending = state.terminal;
      state.terminal = false;
      const work = Effect.gen(function* () {
        if (current !== undefined) {
          if (
            terminalPending &&
            (yield* clearSurvivorFence(current)) &&
            current.conflicts.size === 0 &&
            waiting.get(threadId) === current
          )
            waiting.delete(threadId);
          if (
            current.conflicts.size > 0 &&
            (yield* releaseEndedConflicts({ client, entry: current })) &&
            !current.retainingFence &&
            waiting.get(threadId) === current
          )
            waiting.delete(threadId);
          yield* refreshSurvivorGoalBlock({ client, entry: current });
          yield* forgetUnblockedSurvivor({ waiting, tracked, entry: current });
        }
        if (service !== undefined)
          for (const { record, block } of goals.get(threadId) ?? []) {
            if (
              current !== undefined &&
              current.binding.threadId === block.threadId &&
              current.binding.instanceId === record.instanceId &&
              current.binding.recordName === record.recordName
            )
              continue;
            yield* refreshSurvivorGoalBlock({
              client,
              entry: { binding: { ...record, ...block }, service },
            });
          }
      });
      yield* (current === undefined ? work : current.gate.withPermits(1)(work)).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Failed to maintain Codex survivor fences", { cause }),
        ),
      );
    }
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (maintenance.get(threadId) === state) maintenance.delete(threadId);
      }),
    ),
    Effect.forkIn(scope, { startImmediately: true }),
  );
});

export const clearDeadSurvivorFences = Effect.fn("CodexSurvivorFenceMaintenance.clearDead")(
  function* (input: {
    readonly entries: ReadonlyArray<SurvivorEntry>;
    readonly waiting: SurvivorWaiting;
  }) {
    const { entries, waiting } = input;
    for (const entry of entries) {
      yield* entry.gate
        .withPermits(1)(verifyRetainedSurvivorDeath(entry))
        .pipe(
          Effect.tap((cleared) =>
            Effect.gen(function* () {
              if (!cleared) return;
              if (waiting.get(entry.binding.nativeThreadId) === entry)
                waiting.delete(entry.binding.nativeThreadId);
              yield* entry.service.release(entry.binding);
            }),
          ),
          Effect.catch((cause) =>
            Effect.logWarning("Failed to clear a dead survivor fence", { cause }),
          ),
        );
    }
  },
);
