import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2PlanArtifact,
  OrchestrationV2ThreadShell,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";

/** Enough recent turns to say what the main thread is doing without flooding the side prompt. */
const MAX_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 1_200;
const MAX_TRANSCRIPT_CHARS = 9_000;
const MAX_PLAN_STEPS = 20;

export interface SideChatParentSnapshot {
  readonly shell: Pick<
    OrchestrationV2ThreadShell,
    | "title"
    | "status"
    | "latestRunStopRequested"
    | "pendingRuntimeRequest"
    | "goal"
    | "branch"
    | "worktreePath"
    | "lastError"
  >;
  readonly messages: ReadonlyArray<
    Pick<OrchestrationV2ConversationMessage, "role" | "text" | "streaming" | "createdAt">
  >;
  readonly plans: ReadonlyArray<OrchestrationV2PlanArtifact>;
}

function runStatusLine(shell: SideChatParentSnapshot["shell"]): string {
  const request = shell.pendingRuntimeRequest;
  if (request !== null) {
    return request.kind === "user_input"
      ? "waiting for the user to answer a question"
      : `waiting for the user to approve a request (${request.kind})`;
  }
  switch (shell.status) {
    case "idle":
      return "idle, no turn has run yet";
    case "preparing":
    case "queued":
    case "starting":
      return "starting a turn";
    case "running":
      return shell.latestRunStopRequested === true
        ? "running, the user asked it to stop"
        : "running a turn right now";
    case "waiting":
      return "the provider finished its turn and GOAT is settling it";
    case "completed":
      return "idle, its latest turn completed";
    case "interrupted":
      return "idle, its latest turn was interrupted by the user";
    case "failed":
      return shell.lastError
        ? `idle, its latest turn failed: ${shell.lastError}`
        : "idle, its latest turn failed";
    case "cancelled":
      return "idle, its latest turn was cancelled";
    case "rolled_back":
      return "idle, its latest turn was rolled back";
  }
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}… [truncated]`;
}

function planLines(plans: SideChatParentSnapshot["plans"]): ReadonlyArray<string> {
  const plan = plans.findLast(
    (candidate) => candidate.status === "active" || candidate.status === "draft",
  );
  if (plan === undefined) return [];
  if (plan.kind === "proposed_plan") {
    return [`Proposed plan (${plan.status}):`, clip(plan.markdown, MAX_MESSAGE_CHARS)];
  }
  const marks = { completed: "x", running: ">", pending: " " } as const;
  const done = plan.steps.filter((step) => step.status === "completed").length;
  return [
    `Task list (${done}/${plan.steps.length} done):`,
    ...plan.steps.slice(0, MAX_PLAN_STEPS).map((step) => `- [${marks[step.status]}] ${step.text}`),
  ];
}

function transcriptLines(messages: SideChatParentSnapshot["messages"]): ReadonlyArray<string> {
  const lines: Array<string> = [];
  let budget = MAX_TRANSCRIPT_CHARS;
  // Newest first so the budget keeps the latest turns, including steering sent mid-run.
  for (const message of messages.slice(-MAX_MESSAGES).toReversed()) {
    if (message.role === "system" || message.text.trim() === "") continue;
    const body = clip(message.text, Math.min(MAX_MESSAGE_CHARS, budget));
    const suffix = message.streaming ? " (still writing)" : "";
    const line = `[${message.role} ${DateTime.formatIso(message.createdAt)}${suffix}] ${body}`;
    lines.unshift(line);
    budget -= line.length;
    if (budget <= 0) break;
  }
  return lines;
}

/**
 * The main thread as it stands when a side-chat turn starts. A side chat may be a fresh thread
 * (the parent had no completed turn to fork) or a fork that stops where the parent was when it
 * was created, so this block is what keeps it aligned with the parent's progress.
 */
export function sideChatParentContext(snapshot: SideChatParentSnapshot | null): string {
  if (snapshot === null) {
    return `<parent_thread>
The main thread's current state could not be read for this message. Say so if the user asks what the main thread is doing.
</parent_thread>`;
  }
  const { shell } = snapshot;
  const goal = shell.goal;
  const workspace = [
    shell.branch === null ? null : `branch ${shell.branch}`,
    shell.worktreePath === null ? null : `checkout ${shell.worktreePath}`,
  ].filter((part) => part !== null);
  const transcript = transcriptLines(snapshot.messages);
  return [
    "<parent_thread>",
    "The main thread's live state, read when the user sent this message. Use it to answer questions about what the main thread is doing; it is newer than any earlier conversation in this chat.",
    `Title: ${shell.title}`,
    `Status: ${runStatusLine(shell)}`,
    ...(goal == null ? [] : [`Goal (${goal.status}): ${clip(goal.objective, MAX_MESSAGE_CHARS)}`]),
    ...(workspace.length === 0 ? [] : [`Workspace: ${workspace.join(", ")}`]),
    ...planLines(snapshot.plans),
    transcript.length === 0
      ? "Recent conversation: none yet."
      : "Recent conversation (oldest first):",
    ...transcript,
    "</parent_thread>",
  ].join("\n");
}
