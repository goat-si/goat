import * as Schema from "effect/Schema";
import type { OrchestrationV2PlanStep, OrchestrationV2ProviderTurn } from "@goat/contracts";
import type { ActiveTurn } from "./adapter.ts";

export const NativeTodoList = Schema.Struct({
  todos: Schema.Array(
    Schema.Struct({
      content: Schema.String,
      status: Schema.Literals(["pending", "in_progress", "completed", "cancelled"]),
    }),
  ),
});
export const isNativeTodoList = Schema.is(NativeTodoList);

export const todoSteps = (
  todos: typeof NativeTodoList.Type.todos,
  nativeId: string,
): Array<OrchestrationV2PlanStep> => {
  return todos.flatMap((todo, index) =>
    todo.status === "cancelled"
      ? []
      : [
          {
            id: `${nativeId}:${index + 1}`,
            text: todo.content.trim() || `Todo ${index + 1}`,
            status:
              todo.status === "completed"
                ? "completed"
                : todo.status === "in_progress"
                  ? "running"
                  : "pending",
          },
        ],
  );
};

export const turnTokenUsage = (turn: ActiveTurn, status: OrchestrationV2ProviderTurn["status"]) => {
  // A step whose start was missed, in a reconnect gap or as an unreadable event, ran on an unreported model.
  const models =
    turn.models.size === 0 || turn.missedEvents || turn.steps > turn.startedSteps
      ? {}
      : { models: [...turn.models] };
  return turn.steps === 0
    ? {
        usageScope: "main_agent" as const,
        usageStatus: "unavailable" as const,
        hasSubagents: turn.usedSubagents,
        ...models,
      }
    : {
        ...models,
        usageScope: "main_agent" as const,
        usageStatus:
          status === "completed" && !turn.missedEvents && turn.steps >= turn.startedSteps
            ? ("complete" as const)
            : ("partial" as const),
        inputTokens: turn.usage.input,
        cachedInputTokens: turn.usage.cached,
        cacheCreationTokens: turn.usage.cacheWrite,
        outputTokens: turn.usage.output,
        reasoningTokens: turn.usage.reasoning,
        hasSubagents: turn.usedSubagents,
      };
};
