import { entry } from "../entry.ts";

export const workflowEntries = {
  "workflow.stop": entry({
    resource: "workflow",
    verb: "stop",
    name: "goat_workflow_stop",
    toolkit: "orchestrator",
    summary: "Stop a workflow",
    description:
      "Stop one running Claude workflow, including its phases and agents. The parent thread and other workflows keep running. Individual workflow phases and agents cannot be stopped separately.",
    guide:
      "Use the workflow coordinator's subagentId returned by goat_thread_read with view='activity'. The workflow must be running in the target GOAT thread.",
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
