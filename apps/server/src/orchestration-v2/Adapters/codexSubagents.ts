/**
 * Codex native subagents: how a finished one reads in its parent's wake, and which ones a Stop
 * leaves behind (#1636). Stop interrupts a root turn and every descendant turn it knows of, but
 * a child that registered before its first turn/started has no turn to interrupt yet, and its
 * later lifecycle notifications arrive on the stopped turn, which the adapter drops. Its task
 * would stay running and keep its thread busy.
 *
 * @module codexSubagents
 */
import type { OrchestrationV2Subagent } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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
  readonly subagent: { readonly parentContext: TurnLike } | null;
}

/**
 * Registered subagents under the stopped turn that are still active but run no known turn,
 * marked endedByStop so that their first real turn reopens them.
 */
export const stopped = <
  S extends {
    readonly parentContext: TurnLike;
    readonly nativeTurnIds: ReadonlySet<string>;
    readonly task: { readonly status: string };
    endedByStop?: boolean;
  },
>(
  subagents: ReadonlyMap<string, S>,
  turn: TurnLike,
  activeTurns: ReadonlyMap<string, unknown>,
) =>
  [...subagents.values()].filter((subagent) => {
    if (subagent.task.status !== "running" && subagent.task.status !== "pending") return false;
    if ([...subagent.nativeTurnIds].some((turnId) => activeTurns.has(turnId))) return false;
    for (let parent: TurnLike | undefined = subagent.parentContext; parent;) {
      if (parent === turn) return (subagent.endedByStop = true);
      parent = parent.subagent?.parentContext;
    }
    return false;
  });

/** Whether any of these lineages runs through a turn that Stop or a failure ended. */
export const stoppedLineage = (
  starts: ReadonlyArray<TurnLike>,
  terminalized: ReadonlySet<string>,
) =>
  starts.some((start) => {
    for (let turn: TurnLike | undefined = start; turn; turn = turn.subagent?.parentContext)
      if (terminalized.has(turn.nativeTurnId)) return true;
    return false;
  });

/**
 * A parent turn that sends a child new work (send_input, resume_agent) takes it over: the child's
 * next turn belongs to that turn, not to the one it was spawned under, which Stop may have ended
 * (#1643). Waiting on a child gives it no work.
 */
export const assign = <T>(
  subagents: ReadonlyMap<string, { parentContext: T }>,
  item: { readonly tool: string; readonly receiverThreadIds: ReadonlyArray<string> },
  turn: T,
) => {
  if (item.tool !== "sendInput" && item.tool !== "resumeAgent") return;
  for (const childThreadId of item.receiverThreadIds) {
    const subagent = subagents.get(childThreadId);
    if (subagent !== undefined) subagent.parentContext = turn;
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
