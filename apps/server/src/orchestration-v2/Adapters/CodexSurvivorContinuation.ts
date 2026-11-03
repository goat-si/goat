import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Queue from "effect/Queue";
import * as Deferred from "effect/Deferred";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as NodeUtil from "node:util";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import type { ProviderInstanceId, ProviderDriverKind, ProviderTurnId } from "@goat/contracts";
import type {
  CodexGoalBlock,
  CodexInstanceRecordKey,
  CodexSurvivors,
} from "../../provider/CodexSurvivors.ts";
import { settleSurvivorSessionLoss } from "./CodexSurvivorSessionLoss.ts";
import { makeCodexSessionEvents } from "./CodexAppServerExit.ts";
import { makeGoalTurnFences } from "./CodexGoalTurnFences.ts";
import {
  refreshSurvivorGoalBlock,
  observeSurvivorNotification,
  clearDeadSurvivorFences,
  forgetUnblockedSurvivor,
  type SurvivorSignal,
  type SurvivorWaiting,
  type GoalMaintenance,
} from "./CodexSurvivorFenceMaintenance.ts";

export function mapCodexTurnStatus(
  status: CodexSchema.V2TurnCompletedNotification__TurnStatus,
): import("@goat/contracts").OrchestrationV2ProviderTurn["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "failed":
      return "failed";
    case "inProgress":
      return "running";
  }
}

export const makeSurvivorNotifications = Effect.fn("CodexSurvivorContinuation.notifications")(
  function* (input: {
    readonly client: CodexClient.CodexAppServerClient["Service"];
    readonly survivors: Option.Option<CodexSurvivors["Service"]>;
    readonly instanceId: ProviderInstanceId;
    readonly scope: Scope.Scope;
  }) {
    const { client } = input;
    const waiting: SurvivorWaiting = new Map();
    const tracked: SurvivorWaiting = new Map();
    const goals = new Map<
      string,
      Array<{ record: CodexInstanceRecordKey; block: CodexGoalBlock }>
    >();
    const maintenance: GoalMaintenance = new Map();
    if (Option.isSome(input.survivors)) {
      const service = input.survivors.value;
      for (const goal of yield* service.listGoalBlocksByInstance(input.instanceId)) {
        const group = goals.get(goal.block.nativeThreadId) ?? [];
        group.push(goal);
        goals.set(goal.block.nativeThreadId, group);
      }
      for (const binding of yield* service.list) {
        if (binding.instanceId !== input.instanceId) continue;
        const entry = {
          nativeTurnId: binding.nativeTurnId,
          signals: yield* Queue.bounded<SurvivorSignal>(64),
          binding,
          service,
          gate: yield* Semaphore.make(1),
          lost: yield* Deferred.make<void>(),
          done: undefined,
          providerTurnId: undefined,
          stopRecorded: false,
          interruptSent: false,
          overflow: false,
          terminalEvidence: false,
          retainingFence: false,
          fenceWriteFailed: false,
        };
        waiting.set(binding.nativeThreadId, entry);
        tracked.set(binding.nativeThreadId, entry);
      }
    }
    const goalFences = makeGoalTurnFences({
      client,
      service: Option.getOrUndefined(input.survivors),
      goals,
      waiting,
      tracked,
      onReady: (threadId) =>
        observeSurvivorNotification({
          client,
          scope: input.scope,
          waiting,
          tracked,
          goals,
          service: Option.getOrUndefined(input.survivors),
          maintenance,
          method: "thread/goal/updated",
          payload: { threadId },
          signal: true,
        }),
    });
    yield* client.setRequestGuard((method, payload) =>
      Effect.gen(function* () {
        if (waiting.size === 0) return;
        const threadId =
          typeof payload === "object" &&
          payload !== null &&
          "threadId" in payload &&
          typeof payload.threadId === "string"
            ? payload.threadId
            : undefined;
        if (threadId === undefined)
          return yield* CodexErrors.CodexAppServerRequestError.invalidRequest(
            "Request cannot be attributed while a survivor is waiting",
          );
        let current: string | null | undefined = threadId;
        const seen = new Set<string>();
        let entry = waiting.get(current);
        while (entry === undefined && current && seen.size < 64 && !seen.has(current)) {
          seen.add(current);
          const response: CodexSchema.V2ThreadReadResponse = yield* client.request("thread/read", {
            threadId: current,
            includeTurns: false,
          });
          const source = response.thread.source;
          const spawn =
            typeof source === "object" &&
            source !== null &&
            "subAgent" in source &&
            typeof source.subAgent === "object" &&
            source.subAgent !== null &&
            "thread_spawn" in source.subAgent
              ? source.subAgent.thread_spawn
              : undefined;
          current = response.thread.parentThreadId ?? spawn?.parent_thread_id;
          entry = current == null ? undefined : waiting.get(current);
        }
        if (entry === undefined) {
          if (current)
            return yield* CodexErrors.CodexAppServerRequestError.invalidRequest(
              "Could not establish the request's thread ancestry",
            );
          return;
        }
        const turnId =
          threadId === entry.binding.nativeThreadId
            ? entry.nativeTurnId
            : typeof payload === "object" &&
                payload !== null &&
                "turnId" in payload &&
                typeof payload.turnId === "string"
              ? payload.turnId
              : undefined;
        {
          const target =
            turnId === undefined
              ? entry.binding
              : { ...entry.binding, nativeThreadId: threadId, nativeTurnId: turnId };
          const selected = entry;
          yield* selected.gate
            .withPermits(1)(
              Effect.gen(function* () {
                if (waiting.get(selected.binding.nativeThreadId) !== selected) return;
                if (
                  target.nativeThreadId === selected.binding.nativeThreadId &&
                  selected.interruptSent
                )
                  return;
                yield* interruptSurvivor({
                  binding: target,
                  recordStop: (record, obligation) =>
                    selected.service.recordStopObligation(record, obligation).pipe(
                      Effect.tap(() =>
                        Effect.sync(() => {
                          if (
                            target.nativeThreadId === selected.binding.nativeThreadId &&
                            target.nativeTurnId === selected.nativeTurnId
                          )
                            selected.stopRecorded = true;
                        }),
                      ),
                    ),
                  interrupt: (nativeThreadId, nativeTurnId) =>
                    client
                      .request("turn/interrupt", { threadId: nativeThreadId, turnId: nativeTurnId })
                      .pipe(Effect.asVoid),
                });
                if (target.nativeThreadId === selected.binding.nativeThreadId)
                  selected.interruptSent = true;
              }),
            )
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Failed to stop a survivor request", { cause }),
              ),
              Effect.forkIn(input.scope, { startImmediately: true }),
            );
        }
        return yield* CodexErrors.CodexAppServerRequestError.invalidRequest(
          "Request belongs to a turn running across a restart",
        );
      }),
    );
    const registered = new Set<string>();
    const handleNotification: CodexClient.CodexAppServerClient["Service"]["handleServerNotification"] =
      (method, handler) => {
        const signal = !registered.has(method);
        registered.add(method);
        return client.handleServerNotification(method, (payload) =>
          Effect.gen(function* () {
            yield* goalFences
              .observe(method, payload, signal)
              .pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("Failed to maintain a Codex goal turn fence", { cause }),
                ),
              );
            if (
              !(
                typeof payload === "object" &&
                payload !== null &&
                "threadId" in payload &&
                typeof payload.threadId === "string" &&
                goalFences.pending.has(payload.threadId)
              )
            )
              yield* observeSurvivorNotification({
                client,
                scope: input.scope,
                waiting,
                tracked,
                goals,
                service: Option.getOrUndefined(input.survivors),
                maintenance,
                method,
                payload,
                signal,
              });
            if (yield* interceptSurvivor(waiting, method, payload, signal)) return;
            yield* handler(payload);
          }),
        );
      };
    const sessionLost = Effect.gen(function* () {
      const entries = Array.from(waiting.values());
      for (const entry of entries) {
        if (!Queue.offerUnsafe(entry.signals, { type: "SessionLost" })) {
          yield* Queue.poll(entry.signals);
          Queue.offerUnsafe(entry.signals, { type: "SessionLost" });
        }
        yield* Deferred.succeed(entry.lost, undefined);
      }
      for (const entry of entries) if (entry.done !== undefined) yield* Deferred.await(entry.done);
      yield* clearDeadSurvivorFences({ entries, waiting });
      yield* goalFences
        .clearDead()
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Failed to clear dead Codex goal turn fences", { cause }),
          ),
        );
    });
    return {
      waiting,
      tracked,
      handleNotification,
      hasGoalThreads: goalFences.hasGoals,
      resumeGoalThreads: goalFences.resume(),
      makeSessionEvents: (providerSessionId: import("@goat/contracts").ProviderSessionId) =>
        makeCodexSessionEvents(client, providerSessionId, sessionLost),
    };
  },
);

// This runs for every notification, including streaming deltas.
const interceptSurvivor = Effect.fnUntraced(function* (
  waiting: SurvivorWaiting,
  method: string,
  payload: unknown,
  signal: boolean,
) {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("threadId" in payload) ||
    typeof payload.threadId !== "string"
  )
    return false;
  const entry = waiting.get(payload.threadId);
  if (entry === undefined) return false;
  if (signal) {
    const turn =
      "turn" in payload && typeof payload.turn === "object" && payload.turn !== null
        ? payload.turn
        : undefined;
    const turnId = turn && "id" in turn && typeof turn.id === "string" ? turn.id : undefined;
    const status =
      "status" in payload && typeof payload.status === "object" && payload.status !== null
        ? payload.status
        : undefined;
    const idle = status && "type" in status && status.type === "idle";
    const goal =
      "goal" in payload && typeof payload.goal === "object" && payload.goal !== null
        ? payload.goal
        : undefined;
    const activeGoal = goal && "status" in goal && goal.status === "active";
    const next: SurvivorSignal | undefined =
      (method === "turn/completed" && turnId === entry.nativeTurnId) ||
      (method === "thread/status/changed" && idle)
        ? { type: "End" }
        : method === "turn/completed" && turnId !== undefined && turnId !== entry.nativeTurnId
          ? { type: "ConflictEnd", id: turnId }
          : method === "thread/goal/updated" && activeGoal
            ? { type: "Goal" }
            : method === "turn/started" && turnId !== undefined && turnId !== entry.nativeTurnId
              ? { type: "Conflict", id: turnId }
              : undefined;
    // Never block the notification reader; retain an end signal even when conflicts fill the queue.
    if (next !== undefined && !Queue.offerUnsafe(entry.signals, next)) {
      entry.overflow = true;
      if (next.type === "End") {
        yield* Queue.poll(entry.signals);
        Queue.offerUnsafe(entry.signals, next);
      }
    }
    if (
      next?.type === "Goal" &&
      "turnId" in payload &&
      typeof payload.turnId === "string" &&
      payload.turnId !== entry.nativeTurnId &&
      !Queue.offerUnsafe(entry.signals, { type: "Conflict", id: payload.turnId })
    )
      entry.overflow = true;
  }
  return true;
});

export const adoptSurvivor = Effect.fn("CodexSurvivorContinuation.adopt")(function* <
  A extends { readonly providerTurnId: ProviderTurnId },
  E,
>(input: {
  readonly survivors: Option.Option<CodexSurvivors["Service"]>;
  readonly instanceId: ProviderInstanceId;
  readonly turnInput: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly waiting: { readonly waiting: SurvivorWaiting; readonly tracked: SurvivorWaiting };
  readonly continuation: {
    readonly scope: Scope.Scope;
    readonly client: CodexClient.CodexAppServerClient["Service"];
    readonly emitCompletedItem: (
      payload: CodexSchema.V2ItemCompletedNotification,
    ) => Effect.Effect<void>;
    readonly settle: (
      context: A,
      status: "completed" | "interrupted" | "failed",
      detail?: string,
      runFailure?: string,
    ) => Effect.Effect<void>;
  };
  readonly registerRootTurn: (input: {
    readonly turnInput: ProviderAdapter.ProviderAdapterV2TurnInput;
    readonly nativeTurnId: string;
    readonly startedAt: DateTime.Utc;
    readonly providerTurnIdSalt: string;
  }) => Effect.Effect<A, E>;
}) {
  if (input.turnInput.restartContinuationOfRunId === undefined || Option.isNone(input.survivors))
    return false;
  const binding = yield* input.survivors.value.get(input.instanceId, input.turnInput.threadId);
  if (binding === undefined) return false;
  const entry: NonNullable<ReturnType<SurvivorWaiting["get"]>> = input.waiting.waiting.get(
    binding.nativeThreadId,
  ) ?? {
    nativeTurnId: binding.nativeTurnId,
    signals: yield* Queue.bounded<SurvivorSignal>(64),
    binding,
    service: input.survivors.value,
    gate: yield* Semaphore.make(1),
    lost: yield* Deferred.make<void>(),
    done: undefined,
    providerTurnId: undefined as ProviderTurnId | undefined,
    stopRecorded: false,
    interruptSent: false,
    overflow: false,
    terminalEvidence: false,
    retainingFence: false,
    fenceWriteFailed: false,
  };
  input.waiting.waiting.set(binding.nativeThreadId, entry);
  input.waiting.tracked.set(binding.nativeThreadId, entry);
  const done = yield* Deferred.make<void>();
  entry.done = done;
  const context = yield* input
    .registerRootTurn({
      turnInput: input.turnInput,
      nativeTurnId: binding.nativeTurnId,
      startedAt: yield* DateTime.now,
      providerTurnIdSalt: `:restart:${input.turnInput.runId}`,
    })
    .pipe(Effect.onError(() => Deferred.succeed(done, undefined)));
  entry.providerTurnId = context.providerTurnId;
  yield* waitForSurvivor({
    ...input.continuation,
    waiting: input.waiting.waiting,
    tracked: input.waiting.tracked,
    binding,
    context,
  }).pipe(
    Effect.ensuring(Deferred.succeed(done, undefined)),
    Effect.forkIn(input.continuation.scope, { startImmediately: true }),
  );
  return true;
});

export class CodexSurvivorReadError extends Schema.TaggedError<CodexSurvivorReadError>()(
  "CodexSurvivorReadError",
  { cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "Could not read the result of the turn that ran across the restart";
  }
}

const isCodexSurvivorReadError = Schema.is(CodexSurvivorReadError);

const MAX_PAGES = 1_000;
const MAX_ITEMS = 10_000;

type Page<A> = { readonly data: ReadonlyArray<A>; readonly nextCursor?: string | null };
type Turn = { readonly id: string; readonly status: string };
type Item = { readonly turnId: string; readonly item: { readonly id: string } };

const findSurvivorTurn = Effect.fn("CodexSurvivorContinuation.findTurn")(function* <
  T extends Turn,
  E,
>(input: {
  threadId: string;
  turnId: string;
  readTurns: (input: { threadId: string; cursor?: string }) => Effect.Effect<Page<T>, E>;
  allowConflicts?: boolean;
}) {
  const fail = () => new CodexSurvivorReadError({});
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = yield* input.readTurns({
      threadId: input.threadId,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const turn = result.data.find((candidate) => candidate.id === input.turnId);
    if (
      !input.allowConflicts &&
      result.data.some(
        (candidate) => candidate.id !== input.turnId && candidate.status === "inProgress",
      )
    )
      return yield* fail();
    if (turn !== undefined) return turn;
    if (!result.nextCursor || seen.has(result.nextCursor)) return yield* fail();
    seen.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  return yield* fail();
});

export const readSurvivorResult = Effect.fn("CodexSurvivorContinuation.readResult")(function* <
  T extends Turn,
  I extends Item,
  E,
>(input: {
  readonly threadId: string;
  readonly turnId: string;
  readonly readTurns: (input: {
    readonly threadId: string;
    readonly cursor?: string;
  }) => Effect.Effect<Page<T>, E>;
  readonly readItems: (input: {
    readonly threadId: string;
    readonly turnId: string;
    readonly cursor?: string;
  }) => Effect.Effect<Page<I>, E>;
}) {
  const fail = () => new CodexSurvivorReadError({});
  const readItems = Effect.fn("CodexSurvivorContinuation.readItems")(function* () {
    let cursor: string | undefined;
    const seen = new Set<string>();
    const ids = new Map<string, I>();
    const items: I[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = yield* input.readItems({
        threadId: input.threadId,
        turnId: input.turnId,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const entry of result.data) {
        if (entry.turnId !== input.turnId) return yield* fail();
        const previous = ids.get(entry.item.id);
        if (previous !== undefined) {
          if (!NodeUtil.isDeepStrictEqual(previous, entry)) return yield* fail();
          continue;
        }
        if (items.length >= MAX_ITEMS) return yield* fail();
        ids.set(entry.item.id, entry);
        items.push(entry);
      }
      if (!result.nextCursor) return items;
      if (seen.has(result.nextCursor)) return yield* fail();
      seen.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    return yield* fail();
  });
  return yield* Effect.gen(function* () {
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = yield* findSurvivorTurn(input);
      if (!["completed", "interrupted", "failed"].includes(before.status)) return yield* fail();
      const first = yield* readItems();
      const second = yield* readItems();
      const after = yield* findSurvivorTurn(input);
      if (NodeUtil.isDeepStrictEqual(before, after) && NodeUtil.isDeepStrictEqual(first, second)) {
        return { turn: after, items: second };
      }
    }
    return yield* fail();
  }).pipe(
    Effect.mapError((cause) =>
      isCodexSurvivorReadError(cause) ? cause : new CodexSurvivorReadError({ cause }),
    ),
  );
});

class SurvivorSessionLost extends Schema.TaggedError<SurvivorSessionLost>()(
  "SurvivorSessionLost",
  {},
) {}
const isSurvivorSessionLost = Schema.is(SurvivorSessionLost);
const isTerminalCodexTransportError = Schema.is(
  Schema.Union([
    CodexErrors.CodexAppServerInputStreamEndedError,
    CodexErrors.CodexAppServerProcessExitedError,
    CodexErrors.CodexAppServerTransportError,
  ]),
);

const waitForSurvivor = Effect.fn("CodexSurvivorContinuation.wait")(function* <A>(input: {
  readonly client: CodexClient.CodexAppServerClient["Service"];
  readonly waiting: SurvivorWaiting;
  readonly tracked: SurvivorWaiting;
  readonly binding: { readonly nativeThreadId: string; readonly nativeTurnId: string };
  readonly context: A;
  readonly emitCompletedItem: (
    payload: CodexSchema.V2ItemCompletedNotification,
  ) => Effect.Effect<void>;
  readonly settle: (
    context: A,
    status: "completed" | "interrupted" | "failed",
    detail?: string,
    runFailure?: string,
  ) => Effect.Effect<void>;
}) {
  const { nativeThreadId: threadId, nativeTurnId: turnId } = input.binding;
  const entry = input.waiting.get(threadId);
  if (entry === undefined) return;
  const readTurns = (page: { threadId: string; cursor?: string }) =>
    input.client.request("thread/turns/list", { ...page, itemsView: "summary" }).pipe(
      Effect.tap((response) =>
        Effect.sync(() => {
          if (
            response.data.some(
              (turn) =>
                turn.id === turnId && ["completed", "interrupted", "failed"].includes(turn.status),
            )
          )
            entry.terminalEvidence = true;
        }),
      ),
    );
  const readItems = (page: { threadId: string; turnId: string; cursor?: string }) =>
    input.client.request("thread/items/list", page);
  const read = Effect.gen(function* () {
    let goalActive = false;
    const first = yield* findSurvivorTurn({ threadId, turnId, readTurns, allowConflicts: true });
    let ended = first.status !== "inProgress";
    const conflicted = new Set<string>();
    const pendingConflicts = new Set<string>();
    while (true) {
      if (entry.overflow) return yield* new CodexSurvivorReadError({});
      const next =
        ended && pendingConflicts.size === 0
          ? yield* Queue.poll(entry.signals)
          : Option.some(yield* Queue.take(entry.signals));
      if (Option.isNone(next)) break;
      const signal = next.value;
      if (signal.type === "End") {
        ended = true;
        continue;
      }
      if (signal.type === "Conflict") {
        if (conflicted.has(signal.id)) continue;
        conflicted.add(signal.id);
        pendingConflicts.add(signal.id);
        const target = { ...entry.binding, nativeTurnId: signal.id };
        yield* interruptSurvivor({
          binding: target,
          recordStop: entry.service.recordStopObligation,
          interrupt: (threadId, turnId) =>
            input.client.request("turn/interrupt", { threadId, turnId }).pipe(Effect.asVoid),
        });
      }
      if (signal.type === "ConflictEnd" && pendingConflicts.delete(signal.id)) {
        const target = { ...entry.binding, nativeTurnId: signal.id };
        yield* entry.service.clearStopObligation(target, target);
      }
      if (signal.type === "Goal" && !goalActive) {
        yield* entry.service.recordGoalBlock(entry.binding, entry.binding);
        goalActive = true;
        yield* entry.gate.withPermits(1)(
          interruptSurvivor({
            binding: entry.binding,
            recordStop: (record, obligation) =>
              entry.service.recordStopObligation(record, obligation).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    entry.stopRecorded = true;
                  }),
                ),
              ),
            interrupt: (threadId, turnId) =>
              input.client.request("turn/interrupt", { threadId, turnId }).pipe(Effect.asVoid),
          }),
        );
      }
    }
    const result = yield* readSurvivorResult({ threadId, turnId, readTurns, readItems });
    return { result, goalActive };
  }).pipe(
    Effect.raceFirst(
      Deferred.await(entry.lost).pipe(Effect.andThen(Effect.fail(new SurvivorSessionLost({})))),
    ),
  );
  yield* Effect.gen(function* () {
    const { result, goalActive } = yield* read;
    for (const item of result.items) {
      yield* input.emitCompletedItem({
        threadId,
        turnId,
        item: item.item,
        completedAtMs: item.completedAtMs ?? DateTime.toEpochMillis(yield* DateTime.now),
      });
    }
    const status = result.turn.status;
    if (status !== "completed" && status !== "interrupted" && status !== "failed")
      return yield* new CodexSurvivorReadError({});
    yield* entry.gate.withPermits(1)(
      Effect.gen(function* () {
        yield* input.settle(
          input.context,
          status,
          result.turn.error?.message,
          goalActive && status === "interrupted"
            ? "Codex started a goal on this thread while GOAT was waiting; the turn that ran across the restart was stopped."
            : undefined,
        );
        if (entry.stopRecorded)
          yield* entry.service
            .clearStopObligation(entry.binding, entry.binding)
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Failed to clear Codex survivor stop obligation", { cause }),
              ),
            );
        yield* refreshSurvivorGoalBlock({ client: input.client, entry }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Failed to refresh a Codex survivor goal block", { cause }),
          ),
        );
        if (input.waiting.get(threadId) === entry) input.waiting.delete(threadId);
        yield* forgetUnblockedSurvivor({ waiting: input.waiting, tracked: input.tracked, entry });
      }),
    );
  }).pipe(
    Effect.catchCause((failure) =>
      Effect.gen(function* () {
        if (Cause.hasInterruptsOnly(failure)) return yield* Effect.failCause(failure);
        const error = Cause.squash(failure);
        const cause = isCodexSurvivorReadError(error) ? error.cause : error;
        const sessionLost = isSurvivorSessionLost(error) || isTerminalCodexTransportError(cause);
        if (sessionLost) yield* Deferred.await(entry.lost);
        return yield* entry.gate.withPermits(1)(
          Effect.gen(function* () {
            if (sessionLost) {
              yield* settleSurvivorSessionLoss({
                binding: entry.binding,
                service: entry.service,
                settle: (detail) => input.settle(input.context, "failed", detail),
              });
            } else {
              let detail = isSurvivorStopFenceError(error)
                ? error.message
                : new CodexSurvivorReadError({ cause: error }).message;
              if (!entry.terminalEvidence) {
                entry.retainingFence = true;
                const fence = yield* entry.service
                  .recordStopObligation(entry.binding, entry.binding)
                  .pipe(Effect.exit);
                if (Exit.isFailure(fence)) {
                  entry.fenceWriteFailed = true;
                  detail = new CodexSurvivorStopFenceError({ cause: fence.cause }).message;
                } else {
                  entry.stopRecorded = true;
                }
              }
              yield* input.settle(input.context, "failed", detail);
            }
            if (!entry.retainingFence && input.waiting.get(threadId) === entry)
              input.waiting.delete(threadId);
            yield* forgetUnblockedSurvivor({
              waiting: input.waiting,
              tracked: input.tracked,
              entry,
            });
          }),
        );
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        if (!entry.retainingFence && input.waiting.get(threadId) === entry)
          input.waiting.delete(threadId);
      }),
    ),
  );
});

export class CodexSurvivorStopFenceError extends Schema.TaggedError<CodexSurvivorStopFenceError>()(
  "CodexSurvivorStopFenceError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "GOAT could not record the stop of the Codex turn from before the restart";
  }
}

export const interruptSurvivor = Effect.fn("CodexSurvivorContinuation.interrupt")(function* <
  E,
  F,
>(input: {
  readonly binding: import("../../provider/CodexSurvivors.ts").CodexInstanceRecordKey &
    import("../../provider/CodexSurvivors.ts").CodexStopObligation;
  readonly recordStop: (
    record: import("../../provider/CodexSurvivors.ts").CodexInstanceRecordKey,
    obligation: import("../../provider/CodexSurvivors.ts").CodexStopObligation,
  ) => Effect.Effect<void, E>;
  readonly interrupt: (nativeThreadId: string, nativeTurnId: string) => Effect.Effect<void, F>;
}) {
  const { binding } = input;
  yield* input
    .recordStop(binding, binding)
    .pipe(Effect.mapError((cause) => new CodexSurvivorStopFenceError({ cause })));
  yield* input.interrupt(binding.nativeThreadId, binding.nativeTurnId);
});

export const stopWaitingSurvivor = Effect.fn("CodexSurvivorContinuation.stopWaiting")(
  function* (input: {
    readonly waiting: SurvivorWaiting;
    readonly client: CodexClient.CodexAppServerClient["Service"];
    readonly requested: ProviderAdapter.ProviderAdapterV2InterruptInput;
  }) {
    const threadId = input.requested.providerThread.nativeThreadRef?.nativeId;
    const entry = threadId == null ? undefined : input.waiting.get(threadId);
    if (entry === undefined || entry.providerTurnId !== input.requested.providerTurnId)
      return false;
    yield* entry.gate.withPermits(1)(
      Effect.gen(function* () {
        if (input.waiting.get(entry.binding.nativeThreadId) !== entry || entry.interruptSent)
          return;
        yield* interruptSurvivor({
          binding: entry.binding,
          recordStop: (record, obligation) =>
            entry.service.recordStopObligation(record, obligation).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  entry.stopRecorded = true;
                }),
              ),
            ),
          interrupt: (nativeThreadId, nativeTurnId) =>
            input.client
              .request("turn/interrupt", { threadId: nativeThreadId, turnId: nativeTurnId })
              .pipe(Effect.asVoid),
        });
        entry.interruptSent = true;
        Queue.offerUnsafe(entry.signals, { type: "Stop" });
      }),
    );
    return true;
  },
);

class SurvivorFenceInterruptError extends ProviderAdapter.ProviderAdapterInterruptError {
  override get message(): string {
    return "GOAT could not record the stop of the Codex turn from before the restart";
  }
}

const isSurvivorStopFenceError = Schema.is(CodexSurvivorStopFenceError);

export const mapSurvivorInterruptError = (input: {
  readonly driver: ProviderDriverKind;
  readonly providerThreadId: ProviderAdapter.ProviderAdapterV2InterruptInput["providerThread"]["id"];
  readonly providerTurnId: ProviderTurnId;
  readonly cause: unknown;
}) =>
  isSurvivorStopFenceError(input.cause)
    ? new SurvivorFenceInterruptError(input)
    : new ProviderAdapter.ProviderAdapterInterruptError(input);
