export interface WorkflowRunFields {
  readonly event: string;
  readonly runNumber: number;
  readonly workflow: { readonly id: string };
}

export interface WorkflowCheck {
  readonly name?: string | null | undefined;
  readonly isRequired?: boolean | null | undefined;
  readonly workflowRun?: WorkflowRunFields | null | undefined;
}

const PULL_REQUEST_EVENTS = new Set(["pull_request", "pull_request_target"]);
const lineageOf = (run: WorkflowRunFields) => `${run.workflow.id} ${run.event}`;

export function supersededChecks(checks: ReadonlyArray<WorkflowCheck>) {
  const newest = new Map<string, number>();
  const note = (key: string, runNumber: number) => {
    if (runNumber > (newest.get(key) ?? Number.NEGATIVE_INFINITY)) newest.set(key, runNumber);
  };
  for (const check of checks) {
    const run = check.workflowRun;
    if (run == null || !PULL_REQUEST_EVENTS.has(run.event)) continue;
    note(lineageOf(run), run.runNumber);
    note(`${lineageOf(run)} ${check.name?.trim() ?? ""}`, run.runNumber);
  }
  return (check: WorkflowCheck, name: string, status: string) => {
    const run = check.workflowRun;
    if (status !== "cancelled" || run == null) return false;
    const key = check.isRequired === true ? `${lineageOf(run)} ${name}` : lineageOf(run);
    return run.runNumber < (newest.get(key) ?? run.runNumber);
  };
}
