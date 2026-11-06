import type { OrchestrationV2ThreadProjection } from "@goat/contracts";
import * as Option from "effect/Option";
import type { EnvironmentThreadState, EnvironmentThreadStatus } from "./threadState.ts";

export function hasMissingPendingRequestCard(projection: OrchestrationV2ThreadProjection): boolean {
  const pending = new Set(
    projection.runtimeRequests
      .filter((request) => request.status === "pending" && request.kind === "user_input")
      .map((request) => request.id),
  );
  for (const item of projection.turnItems) {
    if (item.type === "user_input_request" || item.type === "approval_request")
      pending.delete(item.requestId);
  }
  return pending.size > 0;
}

export function statusWithoutLiveData(
  data: Option.Option<OrchestrationV2ThreadProjection>,
): EnvironmentThreadStatus {
  return Option.isSome(data) ? "cached" : "empty";
}

export function cachedThreadState(value: EnvironmentThreadState): EnvironmentThreadState {
  return {
    ...value,
    status:
      value.status === "deleted" || (value.status === "live" && Option.isSome(value.data))
        ? value.status
        : statusWithoutLiveData(value.data),
    error: Option.none(),
    history: { ...value.history, loading: false, error: null },
  };
}
