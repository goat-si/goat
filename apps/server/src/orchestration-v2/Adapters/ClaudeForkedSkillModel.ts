import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { OrchestrationV2Subagent } from "@goat/contracts";
import * as Effect from "effect/Effect";

/** The model of the latest assistant message in a subagent transcript. */
export function lastClaudeTranscriptModel(messages: ReadonlyArray<SessionMessage>): string | null {
  for (const message of messages.toReversed()) {
    if (message.type !== "assistant" || typeof message.message !== "object") continue;
    const model = message.message === null ? undefined : Reflect.get(message.message, "model");
    if (typeof model === "string" && model.trim().length > 0) return model;
  }
  return null;
}

type Registered = {
  readonly runToolUseId: string | null;
  readonly task: Pick<OrchestrationV2Subagent, "model" | "status">;
};

/**
 * A `context: fork` skill has no Agent call and streams none of its own frames; only its
 * transcript, written after the fork reports its outcome, records the model it ran on.
 */
export const claudeForkedSkillModels = Effect.fn("ClaudeForkedSkillModel.models")(function* <
  E,
>(input: {
  readonly taskIds: Iterable<string>;
  readonly registered: Effect.Effect<ReadonlyMap<string, Registered>>;
  readonly lookup: ((taskId: string) => Effect.Effect<string | null, E>) | undefined;
  readonly canonical: (model: string) => string;
}) {
  const updates: Array<{
    readonly taskId: string;
    readonly model: string;
    readonly status: "completed" | "failed" | "cancelled";
  }> = [];
  const { lookup } = input;
  if (lookup === undefined) return updates;
  for (const taskId of input.taskIds) {
    const before = (yield* input.registered).get(taskId);
    if (
      before === undefined ||
      before.runToolUseId !== null ||
      before.task.model !== null ||
      before.task.status === "running"
    )
      continue;
    const model = yield* lookup(taskId).pipe(
      Effect.catch(() =>
        Effect.logWarning("orchestration-v2.claude-subagent-model-lookup-failed", { taskId }).pipe(
          Effect.as(null),
        ),
      ),
    );
    const status = (yield* input.registered).get(taskId)?.task.status;
    if (
      model !== null &&
      model !== "<synthetic>" &&
      (status === "completed" || status === "failed" || status === "cancelled")
    )
      updates.push({ taskId, model: input.canonical(model), status });
  }
  return updates;
});
