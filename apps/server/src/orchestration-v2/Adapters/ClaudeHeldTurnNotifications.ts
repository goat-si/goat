import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderThread,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { claudeToolResultBlocksFromUserMessage } from "./ClaudeToolFrames.ts";

/**
 * Claude folds a background task notice into the running turn only between tool rounds; one that
 * arrives after the last round reaches the model in a wake turn Claude starts after `result`.
 * When that turn ends its tasks become wake-eligible again until a later turn carries them.
 */
export function makeClaudeHeldTurnNotifications<Turn>(deps: {
  readonly wakeEligibleTasks: Ref.Ref<Map<string, Set<string>>>;
  readonly pendingTasks: Ref.Ref<
    Map<string, ReadonlyMap<string, OrchestrationV2PendingBackgroundTask>>
  >;
  readonly lastProviderThreads: Ref.Ref<Map<string, OrchestrationV2ProviderThread>>;
  readonly clearWakeEligible: (nativeThreadId: string, taskId: string) => Effect.Effect<void>;
  readonly markWakeEligible: (
    nativeThreadId: string,
    taskIds: ReadonlyArray<string>,
  ) => Effect.Effect<void>;
}) {
  const heldByNativeThread = new Map<
    string,
    {
      readonly turn: Turn;
      readonly tasks: Map<string, OrchestrationV2PendingBackgroundTask>;
    }
  >();

  const release = Effect.fnUntraced(function* (nativeThreadId: string) {
    const held = heldByNativeThread.get(nativeThreadId);
    if (held === undefined) return;
    heldByNativeThread.delete(nativeThreadId);
    for (const taskId of held.tasks.keys()) {
      yield* deps.clearWakeEligible(nativeThreadId, taskId);
    }
  });

  const releaseIfOtherTurn = Effect.fnUntraced(function* (
    nativeThreadId: string,
    activeTurn: Turn | null,
  ) {
    if (heldByNativeThread.get(nativeThreadId)?.turn !== activeTurn) {
      yield* release(nativeThreadId);
    }
  });

  const settleTurn = Effect.fnUntraced(function* (nativeThreadId: string, turn: Turn) {
    const held = heldByNativeThread.get(nativeThreadId);
    if (held === undefined) return;
    if (held.turn !== turn) {
      yield* release(nativeThreadId);
    } else {
      yield* deps.markWakeEligible(nativeThreadId, [...held.tasks.keys()]);
    }
  });

  const findNotifiedTask = Effect.fnUntraced(function* (
    nativeThreadId: string,
    taskId: string,
    turn: Turn | null,
    activeTurn: Turn | null,
  ): Effect.fn.Return<OrchestrationV2PendingBackgroundTask | undefined> {
    if (turn === null || turn !== activeTurn) return undefined;
    if (!(yield* Ref.get(deps.wakeEligibleTasks)).get(nativeThreadId)?.has(taskId)) {
      return undefined;
    }
    return (
      (yield* Ref.get(deps.pendingTasks)).get(nativeThreadId)?.get(taskId) ??
      (yield* Ref.get(deps.lastProviderThreads))
        .get(nativeThreadId)
        ?.pendingBackgroundTasks?.find((task) => task.taskId === taskId)
    );
  });

  const hold = Effect.fnUntraced(function* (
    nativeThreadId: string,
    turn: Turn,
    task: OrchestrationV2PendingBackgroundTask,
  ) {
    const held = heldByNativeThread.get(nativeThreadId);
    if (held?.turn === turn) {
      held.tasks.set(task.taskId, task);
      return;
    }
    yield* release(nativeThreadId);
    heldByNativeThread.set(nativeThreadId, { turn, tasks: new Map([[task.taskId, task]]) });
  });

  const clearOnToolRound = (nativeThreadId: string, turn: Turn, message: SDKMessage) => {
    // The next tool round's request carries every notice held so far.
    if (
      message.type === "user" &&
      message.parent_tool_use_id == null &&
      claudeToolResultBlocksFromUserMessage(message).length > 0 &&
      heldByNativeThread.get(nativeThreadId)?.turn === turn
    ) {
      heldByNativeThread.delete(nativeThreadId);
    }
  };

  const owedCandidates = (
    nativeThreadId: string,
    previousTasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask> | undefined,
  ): ReadonlyArray<OrchestrationV2PendingBackgroundTask> => {
    const seen = new Set<string>();
    const combined: Array<OrchestrationV2PendingBackgroundTask> = [];
    const held = heldByNativeThread.get(nativeThreadId)?.tasks.values() ?? [];
    for (const task of [...(previousTasks ?? []), ...held]) {
      if (seen.has(task.taskId)) continue;
      seen.add(task.taskId);
      combined.push(task);
    }
    return combined;
  };

  return {
    get size() {
      return heldByNativeThread.size;
    },
    has: (nativeThreadId: string) => heldByNativeThread.has(nativeThreadId),
    delete: (nativeThreadId: string) => {
      heldByNativeThread.delete(nativeThreadId);
    },
    releaseIfOtherTurn,
    settleTurn,
    findNotifiedTask,
    hold,
    clearOnToolRound,
    owedCandidates,
  };
}
