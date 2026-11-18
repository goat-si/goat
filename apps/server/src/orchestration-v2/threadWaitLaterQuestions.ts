import type { OrchestrationV2Run, ProjectId, RuntimeRequestId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";

import type { ThreadManagementServiceShape } from "./ThreadManagementService.ts";

/**
 * Pending user-input questions of runs after `run`: with untilDelegatedWorkSettled, a run the
 * thread's background work woke can ask one while the wait still holds. Reads only the thread's
 * pending requests and, when one is a question, the question items of those later runs.
 */
export const laterRunQuestions = Effect.fn("ThreadManagementService.laterRunQuestions")(function* (
  read: ThreadManagementServiceShape["getProjectThreadRecords"],
  target: { readonly projectId: ProjectId; readonly threadId: ThreadId },
  input: {
    readonly runs: ReadonlyArray<OrchestrationV2Run>;
    readonly run: OrchestrationV2Run;
    readonly ignored: ReadonlySet<RuntimeRequestId>;
  },
) {
  const later = input.runs.filter((candidate) => candidate.ordinal > input.run.ordinal);
  if (later.length === 0) return [];
  const { runtimeRequests } = yield* read(target, ["runtimeRequests"], {
    runtimeRequestStatuses: ["pending"],
  });
  const asked = new Set(
    runtimeRequests
      .filter(
        (request) =>
          request.kind === "user_input" &&
          request.status === "pending" &&
          !input.ignored.has(request.id),
      )
      .map((request) => request.id),
  );
  if (asked.size === 0) return [];
  const laterIds = new Set(later.map((candidate) => candidate.id));
  const { turnItems } = yield* read(target, ["turnItems"], {
    turnItemTypes: ["user_input_request"],
    turnItemRunIds: [...laterIds],
  });
  return turnItems
    .flatMap((item) =>
      item.type === "user_input_request" &&
      item.runId !== null &&
      laterIds.has(item.runId) &&
      asked.has(item.requestId)
        ? [item.requestId]
        : [],
    )
    .toSorted();
});
