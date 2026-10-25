/**
 * Codex native subagents: how a finished one reads in its parent's wake, which ones a Stop leaves
 * behind (#1636, #1645), and which late turns belong to stopped work (#1643). Stop interrupts a
 * root turn and every descendant turn it knows of, but a child that registered before its first
 * turn/started has no turn to interrupt yet, and its later lifecycle notifications arrive on the
 * stopped turn, which the adapter drops. Its task would stay running and keep its thread busy.
 *
 * @module codexSubagents
 */
import type { OrchestrationV2Subagent } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as CodexClient from "effect-codex-app-server/client";

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
 * This turn and every parent turn it runs under. Reparenting never forms a cycle (reparent), but
 * a walk still stops at a turn it has seen: a cycle would otherwise spin forever on the event
 * loop and block even Stop.
 */
function* turnsUp(turn: TurnLike): Generator<TurnLike> {
  const seen = new Set<TurnLike>();
  for (let at: TurnLike | undefined = turn; at && !seen.has(at); at = at.subagent?.parentContext) {
    seen.add(at);
    yield at;
  }
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
    for (const parent of turnsUp(subagent.parentContext))
      if (stops(parent as T)) return (subagent.endedByStop = true);
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

/** The native turn ids from this turn up through every parent turn it runs under. */
export const lineage = (turn: TurnLike) => [...turnsUp(turn)].map((at) => at.nativeTurnId);

/** Whether any of these lineages runs through a turn that Stop or a failure ended. */
export const stoppedLineage = (
  starts: ReadonlyArray<TurnLike>,
  terminalized: ReadonlySet<string>,
) =>
  starts.some((start) => [...turnsUp(start)].some((turn) => terminalized.has(turn.nativeTurnId)));

/**
 * Moves a subagent under a new parent turn, unless that turn runs under the subagent itself (its
 * own descendant, directly or through a thread it messaged): the parent chain would become a
 * cycle. Returns whether it moved (#1643).
 */
export const reparent = <T extends TurnLike>(subagent: { parentContext: T }, turn: T) => {
  if ([...turnsUp(turn)].some((at) => at.subagent === subagent)) return false;
  subagent.parentContext = turn;
  return true;
};

/**
 * A parent turn that sends a child new work (send_input, resume_agent) takes it over: the child's
 * next turn belongs to that turn, not to the one it was spawned under, which Stop may have ended
 * (#1643). Waiting on a child gives it no work, and a child's own descendant never takes it over.
 */
export const assign = <T extends TurnLike>(
  subagents: ReadonlyMap<string, { parentContext: T; workLineage: ReadonlyArray<string> }>,
  item: { readonly tool: string; readonly receiverThreadIds: ReadonlyArray<string> },
  turn: T,
) => {
  if (item.tool !== "sendInput" && item.tool !== "resumeAgent") return;
  for (const childThreadId of item.receiverThreadIds) {
    const subagent = subagents.get(childThreadId);
    if (subagent !== undefined && reparent(subagent, turn)) subagent.workLineage = lineage(turn);
  }
};

/** Interrupts a child's turn that started for work whose lineage was already stopped. */
export const interruptLateTurn = Effect.fn("CodexAdapterV2.interruptLateSubagentTurn")(function* (
  client: CodexClient.CodexAppServerClient["Service"],
  nativeThreadId: string,
  nativeTurnId: string,
) {
  const interrupted = yield* client
    .request("turn/interrupt", { threadId: nativeThreadId, turnId: nativeTurnId })
    .pipe(
      Effect.as(true),
      Effect.catch((cause) =>
        Effect.logWarning("orchestration-v2.codex-late-subagent-interrupt-failed", {
          nativeThreadId,
          nativeTurnId,
          cause,
        }).pipe(Effect.as(false)),
      ),
      Effect.timeoutOption("10 seconds"),
    );
  if (Option.isNone(interrupted))
    yield* Effect.logWarning("orchestration-v2.codex-late-subagent-interrupt-timeout", {
      nativeThreadId,
      nativeTurnId,
    });
});
