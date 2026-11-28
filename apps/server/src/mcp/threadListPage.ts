import type { OrchestratorMcpThreadListInput, OrchestrationV2ThreadShell } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { isSnoozed } from "../orchestration-v2/ThreadSettlementService.ts";
import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type { McpPageStatus } from "../orchestration-v2/ProjectionMcpThreadPage.ts";
import { listedThreadStatus, threadSettlement } from "./threadListView.ts";

const CANDIDATE_PAGE_SIZE = 200;

export const listThreadPage = Effect.fn("OrchestratorMcpService.listThreadPage")(function* (
  threads: ThreadManagementService.ThreadManagementService["Service"],
  input: OrchestratorMcpThreadListInput,
  query: Parameters<
    ThreadManagementService.ThreadManagementService["Service"]["listMcpThreadPage"]
  >[0],
  nowMs: number,
) {
  const statuses =
    input.statuses === undefined || input.statuses.length === 0 ? null : new Set(input.statuses);
  const sqlStatuses =
    input.statuses !== undefined &&
    input.statuses.length > 0 &&
    input.statuses.every(
      (status): status is McpPageStatus =>
        status === "preparing" || status === "starting" || status === "running",
    )
      ? input.statuses
      : undefined;
  const needsScan =
    input.snoozed !== undefined ||
    input.titleContains !== undefined ||
    (statuses !== null && sqlStatuses === undefined);
  if (!needsScan) return yield* threads.listMcpThreadPage({ ...query, statuses: sqlStatuses });
  const page: Array<OrchestrationV2ThreadShell> = [];
  let offset = 0;
  let total = 0;
  let initialTotal: number | undefined;
  while (true) {
    const candidates = yield* threads.listMcpThreadPage({
      ...query,
      statuses: sqlStatuses,
      offset,
      limit: CANDIDATE_PAGE_SIZE,
    });
    initialTotal ??= candidates.total;
    const batch = candidates.threads.slice(0, Math.max(0, initialTotal - offset));
    for (const thread of batch) {
      if (statuses !== null && !statuses.has(listedThreadStatus(thread))) continue;
      if (input.settled !== undefined && threadSettlement(thread).settled !== input.settled)
        continue;
      if (input.snoozed !== undefined && isSnoozed(thread, nowMs) !== input.snoozed) continue;
      if (
        input.titleContains !== undefined &&
        !thread.title.toLocaleLowerCase().includes(input.titleContains.toLocaleLowerCase())
      )
        continue;
      if (total >= query.offset && page.length < query.limit) page.push(thread);
      total++;
    }
    offset += batch.length;
    if (batch.length === 0 || offset >= initialTotal) break;
    yield* Effect.yieldNow;
  }
  return { threads: page, total };
});
