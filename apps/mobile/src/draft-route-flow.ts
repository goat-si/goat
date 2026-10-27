import type { NavigationState } from "@react-navigation/native";

import { newTaskFlowKey } from "./features/threads/new-task-flow-state";
import {
  isDraftThreadRoute,
  type NewTaskDraftRouteParams,
} from "./features/threads/thread-route-state";

export function draftRouteFlowProps(state: NavigationState) {
  const draftRoute = state.routes.findLast(isDraftThreadRoute);
  const draftParams = (draftRoute?.params as { draft?: NewTaskDraftRouteParams } | undefined)
    ?.draft;
  return {
    active:
      draftRoute !== undefined &&
      state.routes.findLast((route) => route.name === "Thread") === draftRoute,
    flowKey: draftRoute === undefined ? undefined : newTaskFlowKey(draftRoute),
    routeDraftId: Array.isArray(draftParams?.draftId)
      ? draftParams.draftId[0]
      : draftParams?.draftId,
    routePendingTaskId: Array.isArray(draftParams?.pendingTaskId)
      ? draftParams.pendingTaskId[0]
      : draftParams?.pendingTaskId,
  };
}
