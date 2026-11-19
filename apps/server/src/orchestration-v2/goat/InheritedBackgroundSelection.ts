import type { OrchestrationV2ProviderThread, OrchestrationV2Run } from "@goat/contracts";
import type * as ProjectionStore from "../ProjectionStore.ts";
import * as RunExecutionService from "../RunExecutionService.ts";

export const makeInheritedBackgroundSelection = (
  providerThread: OrchestrationV2ProviderThread,
  run: OrchestrationV2Run,
) => {
  return (
    current: ProjectionStore.ProjectionRuntimeRecoveryState,
  ): ReturnType<typeof RunExecutionService.selectInheritedBackgroundTurnItems> =>
    RunExecutionService.selectInheritedBackgroundTurnItems({
      threadId: current.thread.id,
      currentProviderThreadId: providerThread.id,
      currentRunOrdinal: run.ordinal,
      runs: current.runs,
      turnItems: current.turnItems,
    });
};
