/**
 * Codex native subagents: how a finished one reads in its parent's wake, and which ones a Stop
 * leaves behind (#1636, #1645). Stop interrupts a root turn and every descendant turn it knows of, but
 * a child that registered before its first turn/started has no turn to interrupt yet, and its
 * later lifecycle notifications arrive on the stopped turn, which the adapter drops. Its task
 * would stay running and keep its thread busy.
 *
 * @module codexSubagents
 */
import type { OrchestrationV2Subagent } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

// Codex spawns can omit the prompt, which registers as an empty string.
export function label(task: OrchestrationV2Subagent): string | undefined {
  return task.title?.trim() || task.prompt.trim() || undefined;
}

export function detail(task: OrchestrationV2Subagent): string {
  const header = `Subagent ${task.status}: ${label(task) ?? task.id}`;
  return task.result == null || task.result.length === 0
    ? header
    : `${header}\n\nResult:\n${task.result}`;
}

interface TurnLike {
  readonly nativeTurnId: string;
  readonly providerThread: { readonly id: string };
  readonly subagent: { readonly parentContext: TurnLike } | null;
}

/**
 * Registered subagents that are still active but run no known turn, under a turn that "stops"
 * matches. They are marked endedByStop so that their first real turn reopens them.
 */
interface Stoppable<T> {
  readonly parentContext: T;
  readonly nativeTurnIds: ReadonlySet<string>;
  readonly task: { readonly status: string };
  endedByStop?: boolean;
}

const stopped = <T extends TurnLike, S extends Stoppable<T>>(
  subagents: ReadonlyMap<string, S>,
  stops: (turn: T) => boolean,
  activeTurns: ReadonlyMap<string, unknown>,
) =>
  [...subagents.values()].filter((subagent) => {
    if (subagent.task.status !== "running" && subagent.task.status !== "pending") return false;
    if ([...subagent.nativeTurnIds].some((turnId) => activeTurns.has(turnId))) return false;
    for (let parent: TurnLike | undefined = subagent.parentContext; parent;) {
      if (stops(parent as T)) return (subagent.endedByStop = true);
      parent = parent.subagent?.parentContext;
    }
    return false;
  });

/**
 * After Stop, ends every subagent of the stopped thread that registered but runs no known turn,
 * whichever path Stop took: a goal pause, between goal turns, after the root finished (#1645).
 */
export const endStopped = Effect.fn("CodexAdapterV2.endStoppedSubagents")(function* <
  T extends TurnLike,
  S extends Stoppable<T>,
  A,
>(
  subagents: Ref.Ref<Map<string, S>>,
  activeTurns: Ref.Ref<Map<string, A>>,
  providerThreadId: string,
  end: (subagent: S) => Effect.Effect<void>,
) {
  const owned = (turn: T) => turn.subagent === null && turn.providerThread.id === providerThreadId;
  for (const subagent of stopped(yield* Ref.get(subagents), owned, yield* Ref.get(activeTurns)))
    yield* end(subagent);
});
