import { entry } from "../entry.ts";

export const scheduleEntries = {
  "schedule.create": entry({
    resource: "schedule",
    verb: "create",
    name: "schedule_task",
    toolkit: "orchestrator",
    summary: "Schedule a recurring task",
    description:
      "Create persistent recurring timer or webhook work in the app scheduler; runs continue without an active turn. Runs post into this thread by default; bindToCurrentThread=false gives a fresh thread per run. Webhook data reaches the run only through prompt placeholders; unsigned URLs let anyone trigger work. webhookUrl may be absent, and a returned one does not prove the tunnel runs.",
    guide:
      "Pass schedule as a structured object, never JSON text. For hourly runs, use {type:'interval', everyMs:3600000}. For weekday mornings, use {type:'fixed_time', timeOfDay:'09:00', weekdays:[1,2,3,4,5]}. Report the returned nextRunAt.\n\nUse {type:'webhook'} for a generated request URL. Accepted requests can trigger runs, subject to filters, replay suppression, coalescing and admission checks. Configure webhook dedupe with replayKey and coalesceKey templates and coalesceWindowSeconds (10–3600, default 120). Replay keys expire after 7 days. Coalescing retains the latest payload in a fixed window measured from its first delivery.\n\nExpose request data through {{body.path}}, such as {{body.action}} or {{body.release.tag_name}}, {{headers.name}}, {{query.name}}, {{body}} or {{request}}. {{request}} includes the method, headers with credentials redacted, and body. Values arrive framed as untrusted request data; $skill, @file and /command mentions inside them do not act.\n\nFor a sender that signs requests, first call goat_handoff_create so the user enters the secret privately. Never ask for the secret in chat or invent one. Set signature with the returned secretRef. For GitHub, use {type:'webhook', signature:{header:'x-hub-signature-256', encoding:'hex', prefix:'sha256=', secretRef}}.\n\nAdd filters to restrict triggering; all filters must match. For example: filters:[{path:'headers.x-github-event', op:'equals', value:'pull_request'}, {path:'body.action', op:'in', value:['opened','reopened']}]. Supported operators are equals, notEquals, in, startsWith and exists. A path segment ending in [] fans out over an array: {path:'body.issue.labels[].name', op:'equals', value:'needs more info'} matches when any label has that name. With notEquals, no label may equal the value.\n\nGive the user the returned webhookUrl. If absent, report webhookUrlUnavailableReason, which explains why and what to do. Public URLs need GOAT Connect, which is coming soon. A sender that reaches the server directly can use the address in Settings → Scheduled Tasks. Never share a path instead of a URL. A webhookUrl confirms tunnel configuration; it does not confirm the tunnel is running.\n\nOmit projectId for this thread's project. Keeping runs in this thread suits an orchestrator that sees triggers, delegates work and deduplicates against work in flight. Use bindToCurrentThread=false only when the user wants a fresh top-level thread for each run. In another project, each run launches a fresh thread.\n\nProvider and model inherit from this thread, or from the project default when no thread calls. Runtime and interaction modes come from the caller's limits. Bound runs follow the bound thread's current provider.",
    effect: "destructive",
    capability: "threads.launch",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: ["secret"],
    annotations: {
      title: "Schedule a recurring task",
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
  "schedule.list": entry({
    resource: "schedule",
    verb: "list",
    name: "list_scheduled_tasks",
    toolkit: "orchestrator",
    summary: "List scheduled tasks",
    description:
      "Read recurring scheduled tasks, including their schedule, prompt, enabled state, bound thread, next run time and last run status. Omit projectId for this thread's project, or all projects when no thread calls.",
    guide: "Use the returned scheduledTaskId with goat_schedule_update or goat_schedule_delete.",
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      title: "List scheduled tasks",
      idempotentHint: true,
      openWorldHint: true,
    },
  }),
  "schedule.update": entry({
    resource: "schedule",
    verb: "update",
    name: "update_scheduled_task",
    toolkit: "orchestrator",
    summary: "Update a scheduled task",
    description:
      "Update a scheduled task, pause it with enabled=false, or switch between this thread and a fresh top-level thread per run. Omitted top-level fields stay unchanged. Supplying a webhook schedule without signature clears signature checks.",
    guide:
      "Pass scheduledTaskId from goat_schedule_list.\n\nOmit a top-level field to keep its stored value. Set enabled=false to pause future automatic runs without deleting the task. Set bindToCurrentThread=true to post runs into this thread, or false to launch a fresh thread per run.\n\nWebhook dedupe accepts replayKey, coalesceKey and coalesceWindowSeconds (10–3600, default 120). Replay keys suppress replays for 7 days. Coalescing retains the latest payload in each fixed window.\n\nWhen supplying a webhook schedule, omitted filters keep the stored filters; pass filters to replace them or filters:[] to clear them. Supplying schedule replaces other trigger settings except the explicitly preserved filters and dedupe settings; include signature to keep signature checks.",
    effect: "destructive",
    capability: "threads.launch",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: ["secret"],
    annotations: {
      title: "Update a scheduled task",
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
  "schedule.delete": entry({
    resource: "schedule",
    verb: "delete",
    name: "delete_scheduled_task",
    toolkit: "orchestrator",
    summary: "Delete a scheduled task",
    description:
      "Permanently delete a scheduled task and prevent future scheduled runs. Already dispatched provider work continues. To pause the schedule instead, use goat_schedule_update with enabled=false.",
    guide: "Pass scheduledTaskId from goat_schedule_list.",
    effect: "destructive",
    capability: "threads.launch",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      title: "Delete a scheduled task",
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
  "schedule.run": entry({
    resource: "schedule",
    verb: "run",
    name: "run_scheduled_task_now",
    toolkit: "thread",
    summary: "Run a scheduled task now through the existing scheduler.",
    description:
      "Dispatch a manual run of a scheduled task. Each call is a new run, so retries can duplicate work. Completion covers dispatch and bookkeeping; the provider turn can still be running. The returned threadId reflects the stored task binding, so it can be null after a successful fresh-thread launch.",
    guide:
      "Requires a full-access/default caller. Each call requests a new manual run. Webhook tasks refuse manual runs. The response includes taskId, threadId, lastRunStatus, runCount and nextRunAt. A bound task can return its bound threadId even when dispatch fails.",
    effect: "destructive",
    capability: "threads.launch",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
} as const;
