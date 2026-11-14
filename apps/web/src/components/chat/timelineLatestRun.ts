import type { ThreadRunSummary } from "@goat/client-runtime/state/shell";
export type TimelineLatestRun = Pick<
  ThreadRunSummary,
  | "runId"
  | "status"
  | "startedAt"
  | "completedAt"
  | "turnEnded"
  | "survivingRestartNotice"
  | "providerStartingLabel"
>;
