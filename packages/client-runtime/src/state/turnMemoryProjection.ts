import type { OrchestrationV2Run, OrchestrationV2TurnItem, RunId } from "@goat/contracts";

export interface TurnMemoryProjection {
  readonly projection: {
    readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status">>;
    readonly turnItems: ReadonlyArray<
      Pick<OrchestrationV2TurnItem, "id" | "type" | "runId" | "status"> & {
        readonly updatedAt?: OrchestrationV2TurnItem["updatedAt"];
      }
    >;
  };
}

const final = new Set<OrchestrationV2Run["status"]>([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

/** A late projected tool row may make the query text of a committed receipt readable. */
export function turnMemoryReadVersion(thread: TurnMemoryProjection | null, runId: RunId) {
  const run = thread?.projection.runs.find((candidate) => candidate.id === runId);
  if (!thread || !run) return undefined;
  const calls = thread.projection.turnItems.filter(
    (item) => item.runId === runId && item.type === "dynamic_tool" &&
      (final.has(run.status) || item.status === "completed"),
  ).slice(-256);
  return JSON.stringify([run.status, calls.map((call) => [call.id, call.status, call.updatedAt])]);
}
