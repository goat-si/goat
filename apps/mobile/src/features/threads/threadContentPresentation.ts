import type { EnvironmentThreadStatus } from "@goat/client-runtime/state/threads";
import { type EnvironmentConnectionPhase } from "@goat/client-runtime/connection";

export type ThreadContentPresentation =
  | { readonly kind: "ready" }
  | { readonly kind: "loading" }
  | {
      readonly kind: "unavailable";
      readonly title: string;
      readonly detail: string;
    };

// Shared so the thread screen's props keep their identity across renders.
export const THREAD_CONTENT_READY: ThreadContentPresentation = { kind: "ready" };
const THREAD_CONTENT_LOADING: ThreadContentPresentation = { kind: "loading" };

export function projectThreadContentPresentation(input: {
  readonly hasDetail: boolean;
  readonly detailError: string | null;
  readonly detailDeleted: boolean;
  readonly connectionState: EnvironmentConnectionPhase;
}): ThreadContentPresentation {
  if (input.hasDetail) {
    return THREAD_CONTENT_READY;
  }
  if (input.detailDeleted) {
    return {
      kind: "unavailable",
      title: "Thread unavailable",
      detail: "This thread was deleted or is no longer available.",
    };
  }
  if (input.detailError !== null) {
    return {
      kind: "unavailable",
      title: "Could not load conversation",
      detail: input.detailError,
    };
  }
  if (
    input.connectionState === "connected" ||
    input.connectionState === "connecting" ||
    input.connectionState === "reconnecting"
  ) {
    return THREAD_CONTENT_LOADING;
  }
  return {
    kind: "unavailable",
    title: "Messages not cached",
    detail: "Reconnect this environment to load the conversation.",
  };
}

export function threadSyncStatusLabel(
  status: EnvironmentThreadStatus,
  presentation: ThreadContentPresentation["kind"],
): string | null {
  if (status !== "empty" && status !== "cached" && status !== "synchronizing") return null;
  if (presentation === "ready") return "Syncing messages…";
  return presentation === "loading" ? "Loading messages…" : null;
}
