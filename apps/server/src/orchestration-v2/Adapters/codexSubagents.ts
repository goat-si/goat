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

/** Registered subagents under the stopped turn that are still active but run no known turn. */
export const stopped = <
  S extends {
    readonly parentContext: TurnLike;
    readonly nativeTurnIds: ReadonlySet<string>;
    readonly task: { readonly status: string };
  },
>(
  subagents: ReadonlyMap<string, S>,
  stopped: TurnLike,
  activeTurns: ReadonlyMap<string, unknown>,
) =>
  [...subagents.values()].filter((subagent) => {
    if (subagent.task.status !== "running" && subagent.task.status !== "pending") return false;
    if ([...subagent.nativeTurnIds].some((turnId) => activeTurns.has(turnId))) return false;
    for (let parent: TurnLike | undefined = subagent.parentContext; parent;) {
      if (parent === stopped) return true;
      parent = parent.subagent?.parentContext;
    }
    return false;
  });
