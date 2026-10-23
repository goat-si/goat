import { entry } from "../entry.ts";

export const workflowEntries = {
  "workflow.stop": entry({
    resource: "workflow",
    verb: "stop",
    name: "goat_workflow_stop",
    toolkit: "orchestrator",
    summary: "Stop a workflow",
    description:
      "Stop one running Claude workflow in a GOAT thread. Use the workflow coordinator's subagentId returned by goat_thread_read with view='activity'. Stops the whole workflow, including its phases and agents. Does not stop the parent thread or other workflows. Individual workflow phases and agents cannot be stopped separately.",
    effect: "destructive",
    capability: "threads.launch",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      title: "Stop a workflow",
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
} as const;
