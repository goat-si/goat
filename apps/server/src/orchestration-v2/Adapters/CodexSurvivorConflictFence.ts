import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import type * as CodexClient from "effect-codex-app-server/client";
import { readGoalReleaseStatus } from "../../provider/CodexSurvivors.ts";
import type { SurvivorEntry } from "./CodexSurvivorFenceMaintenance.ts";

const MAX_PAGES = 1_000;

const nativeTurnStatus = Effect.fn("CodexSurvivorConflictFence.turnStatus")(function* (
  client: CodexClient.CodexAppServerClient["Service"],
  threadId: string,
  turnId: string,
) {
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = yield* client.request("thread/turns/list", {
      threadId,
      itemsView: "summary",
      ...(cursor === undefined ? {} : { cursor }),
    });
    const turn = result.data.find((candidate) => candidate.id === turnId);
    if (turn !== undefined) return turn.status;
    if (!result.nextCursor || seen.has(result.nextCursor)) return undefined;
    seen.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  return undefined;
});

/**
 * Fences native turns that started on the survivor's thread before GOAT resubscribed. Each stop is
 * durable before its interrupt; a failed write sends no interrupt and holds only the in-memory block.
 */
export const fenceConflictingTurns = Effect.fn("CodexSurvivorConflictFence.fence")(
  function* (input: {
    readonly client: CodexClient.CodexAppServerClient["Service"];
    readonly entry: SurvivorEntry;
    readonly turnIds: ReadonlyArray<string>;
  }) {
    const { client, entry } = input;
    const fresh = input.turnIds.filter((id) => !entry.conflicts.has(id));
    if (fresh.length === 0) return;
    for (const nativeTurnId of fresh) {
      const target = { ...entry.binding, nativeTurnId };
      const recorded = yield* entry.service
        .recordStopObligation(entry.binding, target)
        .pipe(Effect.exit);
      entry.conflicts.set(nativeTurnId, Exit.isSuccess(recorded));
      if (Exit.isFailure(recorded)) {
        yield* Effect.logWarning("Could not record the stop of a newer Codex turn", {
          cause: recorded.cause,
        });
        continue;
      }
      yield* client
        .request("turn/interrupt", { threadId: target.nativeThreadId, turnId: nativeTurnId })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Failed to interrupt a newer Codex turn", { cause }),
          ),
        );
    }
    const goal = yield* readGoalReleaseStatus(
      client.request("thread/goal/get", { threadId: entry.binding.nativeThreadId }),
    ).pipe(Effect.timeoutOption("15 seconds"), Effect.option, Effect.map(Option.flatten));
    if (Option.isSome(goal) && goal.value === "goal")
      yield* entry.service
        .recordGoalBlock(entry.binding, entry.binding)
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not record the goal block of a newer Codex turn", { cause }),
          ),
        );
  },
);

/** Clears the fences of newer turns that Codex reports ended; true when none remain. */
export const releaseEndedConflicts = Effect.fn("CodexSurvivorConflictFence.release")(
  function* (input: {
    readonly client: CodexClient.CodexAppServerClient["Service"];
    readonly entry: SurvivorEntry;
  }) {
    const { client, entry } = input;
    for (const [nativeTurnId, recorded] of entry.conflicts) {
      const status = yield* nativeTurnStatus(client, entry.binding.nativeThreadId, nativeTurnId);
      if (status === undefined || status === "inProgress") continue;
      if (recorded) {
        const target = { ...entry.binding, nativeTurnId };
        yield* entry.service.clearStopObligation(entry.binding, target);
      }
      entry.conflicts.delete(nativeTurnId);
    }
    return entry.conflicts.size === 0;
  },
);

/** Clears every newer-turn fence once the Codex process is verified gone. */
export const clearConflictFences = Effect.fn("CodexSurvivorConflictFence.clearAll")(function* (
  entry: SurvivorEntry,
) {
  for (const [nativeTurnId, recorded] of entry.conflicts) {
    if (recorded)
      yield* entry.service.clearStopObligation(entry.binding, { ...entry.binding, nativeTurnId });
    entry.conflicts.delete(nativeTurnId);
  }
});
