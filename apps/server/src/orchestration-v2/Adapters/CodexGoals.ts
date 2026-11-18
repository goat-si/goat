import { OrchestrationV2ProviderGoal } from "@goat/contracts";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

class CodexGoalObjectiveTooLongError extends Schema.TaggedError<CodexGoalObjectiveTooLongError>()(
  "CodexGoalObjectiveTooLongError",
  { length: Schema.Number, limit: Schema.Number },
) {
  override get message() {
    return `The goal objective is ${this.length} characters; Codex supports at most ${this.limit}. Shorten it and send /goal again. The current goal was not changed.`;
  }
}

function validateCodexGoalObjective(objective: string) {
  let length = 0;
  for (const _ of objective) length++;
  return length > CodexSchema.MAX_THREAD_GOAL_OBJECTIVE_CHARS
    ? Effect.fail(
        new CodexGoalObjectiveTooLongError({
          length,
          limit: CodexSchema.MAX_THREAD_GOAL_OBJECTIVE_CHARS,
        }),
      )
    : Effect.void;
}

type CodexThreadGoal = CodexSchema.V2ThreadGoalUpdatedNotification["goal"];

const CODEX_GOAL_STATUSES = {
  active: "active",
  paused: "paused",
  blocked: "blocked",
  usageLimited: "usage_limited",
  budgetLimited: "budget_limited",
  complete: "complete",
} as const satisfies Record<CodexThreadGoal["status"], OrchestrationV2ProviderGoal["status"]>;

function providerGoalFromCodex(goal: CodexThreadGoal): OrchestrationV2ProviderGoal | null {
  const objective = goal.objective.trim();
  if (objective.length === 0) return null;
  return {
    objective,
    status: CODEX_GOAL_STATUSES[goal.status],
    tokensUsed: Math.max(0, goal.tokensUsed),
    tokenBudget: goal.tokenBudget ?? null,
    timeUsedSeconds: Math.max(0, goal.timeUsedSeconds),
  };
}

const providerGoalsEqual = Schema.toEquivalence(Schema.NullOr(OrchestrationV2ProviderGoal));

function describeCodexGoal(goal: OrchestrationV2ProviderGoal): string {
  return `Goal ${goal.status.replace("_", " ")}: ${goal.objective}`;
}

export { describeCodexGoal, providerGoalFromCodex, providerGoalsEqual, validateCodexGoalObjective };
