import type { ScheduledTask } from "@goat/contracts";
export function scheduledTaskRunPresentation(
  task: Pick<ScheduledTask, "lastRun" | "lastRunStatus">,
) {
  if (task.lastRun === undefined) {
    if (task.lastRunStatus === "succeeded")
      return { label: "Dispatched (legacy)", tone: "outline" } as const;
    if (task.lastRunStatus === "never") return { label: "Not run", tone: "outline" } as const;
    if (task.lastRunStatus === "failed") return { label: "Failed", tone: "error" } as const;
    return { label: "Outcome unavailable", tone: "outline" } as const;
  }
  const status = task.lastRun.status;
  if (status === "dispatching") return { label: "Dispatching", tone: "info" } as const;
  if (status === "queued") return { label: "Queued", tone: "info" } as const;
  if (status === "running") return { label: "Running", tone: "info" } as const;
  if (status === "completed") return { label: "Completed", tone: "success" } as const;
  if (status === "failed")
    return {
      label: task.lastRun.dispatchStatus === "failed" ? "Dispatch failed" : "Failed",
      tone: "error",
    } as const;
  if (status === "interrupted") return { label: "Interrupted", tone: "warning" } as const;
  if (status === "cancelled") return { label: "Cancelled", tone: "outline" } as const;
  if (status === "rolled_back") return { label: "Rolled back", tone: "warning" } as const;
  return { label: "Outcome unavailable", tone: "outline" } as const;
}
