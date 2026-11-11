import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import type * as CodexClient from "effect-codex-app-server/client";
import type {
  CodexGoalBlock,
  CodexInstanceRecordKey,
  CodexStopObligation,
  CodexSurvivors,
} from "../../provider/CodexSurvivors.ts";
import {
  readGoalActivity,
  type PersistedGoals,
  type SurvivorWaiting,
} from "./CodexSurvivorFenceMaintenance.ts";
import { isVerifiedCodexProcessLoss } from "./CodexSurvivorSessionLoss.ts";

type Goal = { readonly record: CodexInstanceRecordKey; readonly block: CodexGoalBlock };
type GoalActivity = "active" | "inactive";

const goalActivityOf = (method: string, payload: object): GoalActivity | undefined => {
  if (method === "thread/goal/cleared") return "inactive";
  if (
    method !== "thread/goal/updated" ||
    !("goal" in payload) ||
    typeof payload.goal !== "object" ||
    payload.goal === null ||
    !("status" in payload.goal)
  )
    return undefined;
  return payload.goal.status === "paused" || payload.goal.status === "complete"
    ? "inactive"
    : "active";
};

export const makeGoalTurnFences = (input: {
  readonly client: CodexClient.CodexAppServerClient["Service"];
  readonly service: CodexSurvivors["Service"] | undefined;
  readonly goals: PersistedGoals;
  readonly waiting: SurvivorWaiting;
  readonly tracked: SurvivorWaiting;
  readonly scope: Scope.Scope;
  readonly onReady: (threadId: string) => Effect.Effect<void>;
}) => {
  const pending = new Set(input.goals.keys());
  const initializing = new Set(input.goals.keys());
  const updates = new Set<string>();
  const terminals = new Map<string, Set<string>>();
  const overflow = new Set<string>();
  const writing = new Map<string, Map<string, { count: number; completed: boolean }>>();
  // The goal state Codex last reported per native thread; reading it inside a notification
  // handler would wait on the connection that delivers the answer.
  const goalActivity = new Map<string, GoalActivity>();
  /**
   * Clears a goal turn's stop fence. When it is the thread's last fence, its goal is inactive and
   * its goal block is this record's alone, the block goes in the same write: between two writes
   * the start guard frees the thread while admission still refuses its start.
   */
  const releaseStop = Effect.fn("CodexGoalTurnFences.releaseStop")(function* (
    service: CodexSurvivors["Service"],
    record: CodexInstanceRecordKey,
    stop: CodexStopObligation,
    inactive: boolean,
  ) {
    const sameRecord = (other: CodexInstanceRecordKey) =>
      other.instanceId === record.instanceId && other.recordName === record.recordName;
    const release =
      inactive &&
      (yield* service.getStopObligations(stop.threadId)).every(
        (other) => sameRecord(other.record) && other.block.nativeTurnId === stop.nativeTurnId,
      ) &&
      (yield* service.getGoalBlocks(stop.threadId)).every(
        (other) => sameRecord(other.record) && other.block.nativeThreadId === stop.nativeThreadId,
      );
    yield* service.clearStopObligation(record, stop, release);
  });
  const blocksFor = Effect.fn("CodexGoalTurnFences.blocks")(function* (nativeThreadId: string) {
    if (input.service === undefined) return [] as Goal[];
    const candidates = [...(input.goals.get(nativeThreadId) ?? [])];
    const tracked = input.tracked.get(nativeThreadId);
    if (tracked !== undefined) candidates.push({ record: tracked.binding, block: tracked.binding });
    const result: Goal[] = [];
    for (const { record, block } of candidates) {
      if (
        result.some(
          (item) =>
            item.record.recordName === record.recordName &&
            item.record.instanceId === record.instanceId &&
            item.block.threadId === block.threadId,
        )
      )
        continue;
      const actual = yield* input.service.getGoalBlocks(block.threadId);
      if (
        actual.some(
          (item) =>
            item.record.instanceId === record.instanceId &&
            item.record.recordName === record.recordName &&
            item.block.nativeThreadId === nativeThreadId,
        )
      )
        result.push({ record, block });
    }
    return result;
  });
  const clearTurn = Effect.fn("CodexGoalTurnFences.clearTurn")(function* (
    nativeThreadId: string,
    turnId: string,
  ) {
    const service = input.service;
    if (service === undefined || input.waiting.has(nativeThreadId)) return;
    for (const { record, block } of yield* blocksFor(nativeThreadId)) {
      const stops = yield* service.getStopObligations(block.threadId);
      for (const stop of stops)
        if (
          stop.record.instanceId === record.instanceId &&
          stop.record.recordName === record.recordName &&
          stop.block.nativeThreadId === nativeThreadId &&
          stop.block.nativeTurnId === turnId
        )
          yield* releaseStop(
            service,
            stop.record,
            stop.block,
            goalActivity.get(nativeThreadId) === "inactive",
          );
    }
  });
  const fence = Effect.fn("CodexGoalTurnFences.fence")(function* (
    nativeThreadId: string,
    turnId: string,
  ) {
    const service = input.service;
    if (service === undefined || input.waiting.has(nativeThreadId)) return;
    const turns = writing.get(nativeThreadId) ?? new Map();
    if (turns.size >= 64 && !turns.has(turnId)) {
      overflow.add(nativeThreadId);
      pending.add(nativeThreadId);
      return;
    }
    const state = turns.get(turnId) ?? { count: 0, completed: false };
    state.count++;
    turns.set(turnId, state);
    writing.set(nativeThreadId, turns);
    pending.add(nativeThreadId);
    const result = yield* Effect.gen(function* () {
      const blocks = yield* blocksFor(nativeThreadId);
      for (const { record, block } of blocks)
        yield* service.recordStopObligation(record, { ...block, nativeTurnId: turnId });
      return blocks.length > 0;
    }).pipe(Effect.result);
    // Without a pause Codex keeps continuing the goal with turns no run owns, and each holds the
    // thread's admission. The fenced turn itself still finishes.
    if (result._tag === "Success" && result.success)
      yield* input.client
        .request("thread/goal/set", { threadId: nativeThreadId, status: "paused" })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not pause a Codex goal that started an unowned turn", {
              nativeThreadId,
              cause,
            }),
          ),
          Effect.forkIn(input.scope),
        );
    state.count--;
    if (result._tag === "Failure") overflow.add(nativeThreadId);
    if (state.count === 0) {
      turns.delete(turnId);
      if (state.completed && result._tag === "Success") yield* clearTurn(nativeThreadId, turnId);
    }
    if (turns.size === 0) {
      writing.delete(nativeThreadId);
      if (!initializing.has(nativeThreadId) && !overflow.has(nativeThreadId)) {
        pending.delete(nativeThreadId);
        terminals.delete(nativeThreadId);
        if (updates.delete(nativeThreadId)) yield* input.onReady(nativeThreadId);
      }
    }
    if (result._tag === "Failure") return yield* result.failure;
  });
  // The session calls this for every notification, including stream deltas.
  const observe = Effect.fnUntraced(function* (method: string, payload: unknown, signal: boolean) {
    if (
      !signal ||
      typeof payload !== "object" ||
      payload === null ||
      !("threadId" in payload) ||
      typeof payload.threadId !== "string"
    )
      return;
    const nativeThreadId = payload.threadId;
    if (!input.goals.has(nativeThreadId) && !input.tracked.has(nativeThreadId)) return;
    const activity = goalActivityOf(method, payload);
    if (activity !== undefined) goalActivity.set(nativeThreadId, activity);
    if (
      pending.has(nativeThreadId) &&
      (method === "thread/goal/updated" ||
        method === "thread/goal/cleared" ||
        method === "turn/completed")
    )
      updates.add(nativeThreadId);
    if (method !== "turn/started" && method !== "turn/completed") return;
    if (
      !("turn" in payload) ||
      typeof payload.turn !== "object" ||
      payload.turn === null ||
      !("id" in payload.turn) ||
      typeof payload.turn.id !== "string"
    )
      return;
    const turnId = payload.turn.id;
    if (method === "turn/started") {
      yield* fence(nativeThreadId, turnId);
      return;
    }
    if (
      !("status" in payload.turn) ||
      !["completed", "failed", "interrupted"].includes(String(payload.turn.status))
    )
      return;
    const write = writing.get(nativeThreadId)?.get(turnId);
    if (write !== undefined) write.completed = true;
    if (pending.has(nativeThreadId)) {
      const seen = terminals.get(nativeThreadId) ?? new Set<string>();
      if (seen.size >= 64 && !seen.has(turnId)) overflow.add(nativeThreadId);
      else seen.add(turnId);
      terminals.set(nativeThreadId, seen);
    }
    yield* clearTurn(nativeThreadId, turnId);
  });
  const resume = Effect.fn("CodexGoalTurnFences.resume")(function* () {
    for (const nativeThreadId of input.goals.keys()) {
      const result = yield* Effect.gen(function* () {
        yield* input.client.raw.request("thread/resume", {
          threadId: nativeThreadId,
          excludeTurns: true,
        });
        const service = input.service;
        const obligations =
          service === undefined
            ? []
            : (yield* Effect.forEach(yield* blocksFor(nativeThreadId), ({ record, block }) =>
                service
                  .getStopObligations(block.threadId)
                  .pipe(
                    Effect.map((stops) =>
                      stops.filter(
                        (stop) =>
                          stop.record.instanceId === record.instanceId &&
                          stop.record.recordName === record.recordName &&
                          stop.block.nativeThreadId === nativeThreadId,
                      ),
                    ),
                  ),
              )).flat();
        const unresolved = new Set(obligations.map(({ block }) => block.nativeTurnId));
        const seen = new Set<string>();
        let inactive: boolean | undefined;
        let cursor: string | undefined;
        for (let page = 0; page < 1000; page++) {
          const turns = yield* input.client.request("thread/turns/list", {
            threadId: nativeThreadId,
            itemsView: "summary",
            sortDirection: "desc",
            limit: 100,
            ...(cursor === undefined ? {} : { cursor }),
          });
          if (overflow.has(nativeThreadId)) return;
          for (const turn of turns.data) {
            if (turn.status === "inProgress" && !terminals.get(nativeThreadId)?.has(turn.id))
              yield* fence(nativeThreadId, turn.id);
            if (!unresolved.has(turn.id)) continue;
            unresolved.delete(turn.id);
            if (
              service === undefined ||
              !["completed", "failed", "interrupted"].includes(turn.status)
            )
              continue;
            if (input.waiting.get(nativeThreadId)?.nativeTurnId === turn.id) continue;
            const activeWrite = writing.get(nativeThreadId)?.get(turn.id);
            if (activeWrite !== undefined) activeWrite.completed = true;
            inactive ??=
              goalActivity.get(nativeThreadId) === "inactive" ||
              Option.contains(yield* readGoalActivity(input.client, nativeThreadId), "inactive");
            for (const stop of obligations)
              if (stop.block.nativeTurnId === turn.id)
                yield* releaseStop(service, stop.record, stop.block, inactive);
          }
          if (unresolved.size === 0 || !turns.nextCursor || seen.has(turns.nextCursor)) break;
          seen.add(turns.nextCursor);
          cursor = turns.nextCursor;
        }
        updates.add(nativeThreadId);
        initializing.delete(nativeThreadId);
        if (!writing.has(nativeThreadId)) {
          pending.delete(nativeThreadId);
          terminals.delete(nativeThreadId);
          if (updates.delete(nativeThreadId)) yield* input.onReady(nativeThreadId);
        }
      }).pipe(Effect.timeout("10 seconds"), Effect.result);
      if (result._tag === "Failure")
        yield* Effect.logWarning("Could not resume a Codex goal thread", {
          nativeThreadId,
          cause: result.failure,
        });
    }
  });
  const clearDead = Effect.fn("CodexGoalTurnFences.clearDead")(function* () {
    if (input.service === undefined) return;
    const entries = [...input.goals.values()].flatMap((items) => [...items]);
    for (const entry of input.tracked.values())
      entries.push({ record: entry.binding, block: entry.binding });
    for (const { record, block } of entries) {
      const classification = yield* input.service
        .classifyRecord(record)
        .pipe(Effect.timeoutOption("10 seconds"), Effect.option);
      if (classification._tag === "None" || classification.value._tag === "None") continue;
      const result = classification.value.value;
      if (!isVerifiedCodexProcessLoss(result)) continue;
      const stops = yield* input.service.getStopObligations(block.threadId);
      for (const stop of stops)
        if (
          stop.record.instanceId === record.instanceId &&
          stop.record.recordName === record.recordName &&
          stop.block.nativeThreadId === block.nativeThreadId
        )
          yield* releaseStop(
            input.service,
            stop.record,
            stop.block,
            goalActivity.get(block.nativeThreadId) === "inactive",
          );
    }
  });
  const fenced = Effect.fn("CodexGoalTurnFences.fenced")(function* () {
    const threads: Array<string> = [];
    for (const nativeThreadId of new Set([...input.goals.keys(), ...input.tracked.keys()]))
      if ((yield* blocksFor(nativeThreadId)).length > 0) threads.push(nativeThreadId);
    return threads;
  });
  return { pending, observe, resume, clearDead, fenced, hasGoals: input.goals.size > 0 };
};
