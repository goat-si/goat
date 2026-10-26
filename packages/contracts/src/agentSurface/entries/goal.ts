import { entry } from "../entry.ts";

export const goalEntries = {
  "goal.apply": entry({
    resource: "goal",
    verb: "apply",
    name: "goat_goal_apply",
    toolkit: "fleet",
    summary: "Declare or update a fleet goal.",
    description:
      "Declare or update a durable fleet goal that the controller reconciles by launching and steering worker threads in worktrees. The goal acts with its owner's authority, the GOAT thread or outside MCP client that declares it; its runtime ceiling is captured at creation and updates can only lower it. No controller work runs until fleet.controllerEnabled is on.",
    guide:
      "The design is described in docs/internals/agentic-k8s.md.\n\nSet the spec's project, repo, targets (issues, pull requests, branches or prompts), workers, doneWhen and limits. Configure a worker count or one worker per target, model, runtime mode, prompt template, worktree base and branch prefix. The template supports {{target}}, {{branch}}, {{attempt}} and {{previousAttempt}}. doneWhen accepts pull_requests_merged, checks_green, thread_reported_result and issues_closed. Limits cover workers, attempts, turns and wall clock.\n\nThe owner's runtime mode sets the goal's ceiling: a thread's mode, or an outside client's approved access. Updates can lower that ceiling; they cannot raise it. The controller rechecks the owner's authority right before each worker action; an outside client's goal stops while its session is revoked or expired. It launches missing workers, sends at most one follow-up per run for cases such as red CI on the worker's PR or a missing report, steers a stall once, and uses configured fallback and rescheduling to recover failed attempts.\n\nStatus reports pending, progressing, blocked, degraded, succeeded, failed, paused or deleting, with conditions and events.\n\nOmit id to create. Reuse clientRequestId when retrying a create to return the same goal. Pass id to update. A changed spec, title or runtime ceiling bumps generation. Pass expectedGeneration to reject a stale update with conflict. Set dryRun:true to validate and return the proposed goal without storing it.\n\nCall from a GOAT thread in default interaction mode, or from an outside MCP client approved for more than read-only access.",
    effect: "write",
    capability: "goals.apply",
    hostRoutable: false,
    requires: "either",
    dryRun: "supported",
    humanSteps: [],
    idempotencyReason:
      "A create stores clientRequestId with the goal under a unique owner and key, so a retried create returns that goal; an update sets the spec, so repeating it changes nothing.",
    annotations: { idempotentHint: false, openWorldHint: true },
  }),
  "goal.get": entry({
    resource: "goal",
    verb: "get",
    name: "goat_goal_get",
    toolkit: "fleet",
    summary: "Read one of your fleet goals.",
    description:
      "Read a fleet goal and its last 20 events without changing it. Another owner's goal reads as not found unless the caller is a full-access/default GOAT thread; an outside client reads only its own.",
    guide:
      "The result includes spec, generation, owner and status: phase, observedGeneration, conditions, workers (attempt, host, thread, branch, model, state and pull request), usage and next pass.",
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { idempotentHint: true, openWorldHint: false },
  }),
  "goal.list": entry({
    resource: "goal",
    verb: "list",
    name: "goat_goal_list",
    toolkit: "fleet",
    summary: "List your fleet goals.",
    description:
      "Read the fleet goals the caller declared, as a thread or an outside client, oldest first. Filter by phase and page through results with a numeric cursor.",
    guide:
      "Pass the returned nextCursor to read the next page. nextCursor is null on the last page.",
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { idempotentHint: true, openWorldHint: false },
  }),
  "goal.pause": entry({
    resource: "goal",
    verb: "pause",
    name: "goat_goal_pause",
    toolkit: "fleet",
    summary: "Pause a fleet goal.",
    description:
      "Pause ordinary reconciliation of a fleet goal. Running workers keep running. Use goat_goal_resume to resume; deletion still interrupts live workers.",
    guide:
      "Changing an unpaused goal to paused bumps generation. Repeating pause on an already paused goal leaves generation unchanged. The owner or a full-access/default GOAT thread may pause.",
    effect: "write",
    capability: "goals.apply",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    idempotencyReason:
      "GoalService.setPaused returns the goal unchanged when paused is already true; only a changed pause flag advances generation through a compare-and-swap.",
    annotations: { idempotentHint: true, openWorldHint: false },
  }),
  "goal.resume": entry({
    resource: "goal",
    verb: "resume",
    name: "goat_goal_resume",
    toolkit: "fleet",
    summary: "Resume a paused fleet goal.",
    description:
      "Resume a paused fleet goal by clearing its pause flag. Reconciliation becomes eligible on a controller tick when fleet.controllerEnabled is on.",
    guide:
      "Changing a paused goal to unpaused bumps generation. Repeating resume on an unpaused goal leaves generation unchanged. The owner or a full-access/default GOAT thread may resume. Controller tick budgets can defer the next pass.",
    effect: "write",
    capability: "goals.apply",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    idempotencyReason:
      "GoalService.setPaused returns the goal unchanged when paused is already false; only a changed pause flag advances generation through a compare-and-swap.",
    annotations: { idempotentHint: true, openWorldHint: false },
  }),
  "goal.delete": entry({
    resource: "goal",
    verb: "delete",
    name: "goat_goal_delete",
    toolkit: "fleet",
    summary: "Delete a fleet goal.",
    description:
      "Request deletion of a fleet goal: the controller then interrupts its live workers and removes it, so nothing happens while fleet.controllerEnabled is off. Threads, worktrees and branches stay. force:true removes the goal at once and leaves running workers alone.",
    guide:
      "Deletion uses a finalizer: the controller removes the goal after confirming its workers have stopped. The owner or a full-access/default GOAT thread may delete.",
    effect: "destructive",
    capability: "goals.apply",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    idempotencyReason:
      "Graceful deletion marks the goal id with COALESCE(deletion_requested_at), preserving its first deletion request; force removes only that id. A removed goal is not found, and threads, worktrees and branches stay.",
    annotations: { idempotentHint: false, openWorldHint: true },
  }),
} as const;
