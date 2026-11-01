# Scheduled tasks

A scheduled task is a server-owned prompt that fires on a clock or on a webhook, then enters
orchestration through the same launch and send services a person uses. The transport that creates
the task does not launch the thread itself.

Rows live in `scheduled_tasks`. Webhook deliveries live beside them. Both are written by
`ScheduledTaskService` in `apps/server/src/scheduledTasks/ScheduledTaskService.ts`. Schedule
arithmetic (`nextScheduledRunAt`, `isSameSchedule`, `isMissedFixedTimeRun`) is
`apps/server/src/scheduledTasks/Schedule.ts`.

## Clock

`Scheduler.register` in `apps/server/src/scheduling/Scheduler.ts` forks each source on a loop that
sleeps 5 seconds. The scheduled-task source is registered as `"scheduled-tasks"` and calls
`runDueTasks`. One source does not overlap itself.

`ScheduledTaskRuns` admits a firing receipt; `runTask` dispatches it through the existing services:

- if the task has no bound thread, `ThreadLaunchService.launch` starts one;
- if it has a bound thread, `ThreadManagementService.sendToThread` queues the prompt.

Both calls become a [command commit](server.md#command-commit). Receipts track dispatch and actual
run outcomes separately. The [completion batch](../apps/server/src/orchestration-v2/ScheduledTaskCompletionBatch.ts)
freezes one notification decision before appending terminal events, using final message attribution
and the current task policies. Any applicable firing requiring notification wins; replay consumes
the recorded decision and retains the thread's independent notification cursor.

The command id is derived from the
task id and the fire key, so the same webhook delivery does not dispatch twice.

## Webhook

`apps/server/src/scheduledTasks/webhookRoute.ts` is the HTTP entry. Verification lives in
`apps/server/src/scheduledTasks/webhookVerification.ts`. A queued webhook run uses the same
`runTask` path. The prompt for that delivery is rendered when the request arrives.

The MCP tool `goat_schedule_create` in `apps/server/src/mcp/toolkits/orchestrator/tools.ts` builds an
upsert and calls `ScheduledTaskService.upsert` from `apps/server/src/mcp/OrchestratorMcpService.ts`.
The WebSocket methods in `apps/server/src/ws.ts` call `list`, `upsert`, and `setEnabled` on that
same service.
