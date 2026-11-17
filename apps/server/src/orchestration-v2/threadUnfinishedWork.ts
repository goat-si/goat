/** Unfinished runs (including queued) or open requests block moving a thread to another project. */
export function threadHasUnfinishedWork(records: {
  readonly runs: ReadonlyArray<{ readonly status: string }>;
  readonly runtimeRequests: ReadonlyArray<{ readonly status: string }>;
}): boolean {
  return (
    records.runs.some(
      (run) =>
        run.status !== "completed" &&
        run.status !== "failed" &&
        run.status !== "cancelled" &&
        run.status !== "interrupted" &&
        run.status !== "rolled_back",
    ) || records.runtimeRequests.some((request) => request.status === "pending")
  );
}
