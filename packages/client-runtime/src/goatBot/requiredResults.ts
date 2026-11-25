import type { BotThreadRow, BotWorkResult } from "@goat/contracts";

export function currentRequiredResults(
  result: BotWorkResult | undefined,
  task: Extract<BotThreadRow, { kind: "task" }>["task"] | undefined,
) {
  const items = result?.requiredDeliverables;
  if (!result || !items?.length || !task) return null;
  const observed = result.task.state === "known" ? result.task.row.task : result.task.task;
  if (
    observed.taskId !== task.taskId ||
    (observed.generation ?? 1) !== (task.generation ?? 1) ||
    observed.updatedAt !== task.updatedAt ||
    observed.status !== task.status
  )
    return null;

  return { items, accepted: items.filter((item) => item.state === "accepted").length };
}

export type RequiredResults = NonNullable<ReturnType<typeof currentRequiredResults>>;
