import { BotId, ChannelTaskId, EnvironmentId } from "@goat/contracts";
import { attentionCursorKey } from "@goat/client-runtime/goatBot";
import { vi } from "vite-plus/test";
import { stubGlobal } from "../../test/render";
import * as DateTime from "effect/DateTime";

export const thread = {
  id: "thread",
  creationSource: undefined as "mcp" | undefined,
  title: "Test thread",
  archivedAt: null as string | null,
  snoozedUntil: null as string | null,
  subagentOf: null as string | null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  pendingRequestId: "request-1",
  session: null as { status: string } | null,
  completionNotification: undefined as string | undefined,
  launchedBy: undefined as
    | undefined
    | {
        kind: "launch";
        via: "delegate_task";
        threadId: string;
        environmentId: string;
        environmentLabel: null;
        threadTitle: null;
      },
  latestTurn: { turnId: "turn", state: "running", completedAt: null as string | null },
};
const SHELL_NOW = DateTime.makeUnsafe("2026-09-13T07:00:00.000Z");

export function toV2ThreadShell(input: typeof thread) {
  const latestTurn = input.latestTurn;
  return {
    id: input.id,
    projectId: "project",
    title: input.title,
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: input.subagentOf ?? input.id,
      parentThreadId: input.subagentOf,
      relationshipToParent: input.subagentOf === null ? null : "subagent",
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: input.creationSource ?? (input.subagentOf === null ? "web" : "mcp"),
    launchedBy: input.launchedBy,
    latestRunId: latestTurn.turnId,
    activeRunId: null,
    status:
      latestTurn.state === "completed"
        ? "completed"
        : latestTurn.state === "error" || input.session?.status === "error"
          ? "failed"
          : "running",
    pendingRuntimeRequest: input.hasPendingUserInput
      ? { id: input.pendingRequestId, kind: "user_input", createdAt: SHELL_NOW }
      : input.hasPendingApprovals
        ? { id: input.pendingRequestId, kind: "command", createdAt: SHELL_NOW }
        : null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: SHELL_NOW,
    updatedAt: SHELL_NOW,
    latestRunRequestedAt: SHELL_NOW,
    latestRunStartedAt: SHELL_NOW,
    latestRunCompletionNotification: input.completionNotification,
    notificationCompletedAt: null,
    latestRunCompletedAt: latestTurn.completedAt
      ? DateTime.makeUnsafe(latestTurn.completedAt)
      : undefined,
    archivedAt: input.archivedAt ? DateTime.makeUnsafe(input.archivedAt) : null,
    snoozedUntil: input.snoozedUntil ? DateTime.makeUnsafe(input.snoozedUntil) : null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

export class TestNotification extends EventTarget {
  static permission = "granted";
  static sent: TestNotification[] = [];
  close = vi.fn();
  get tag() {
    return this.options.tag ?? "";
  }
  constructor(
    readonly title: string,
    readonly options: NotificationOptions,
  ) {
    super();
    TestNotification.sent.push(this);
  }
}

export const attentionEnvironment = EnvironmentId.make("one");
export const cursorKey = attentionCursorKey(attentionEnvironment);
export const attentionEvent = {
  environmentId: attentionEnvironment,
  botId: BotId.make("main"),
  taskId: ChannelTaskId.make("task"),
  eventId: "event",
  sequence: 1,
  generation: 1,
  occurredAt: "2026-11-21T00:00:00Z",
  kind: "question",
  requestId: "ask",
  botName: "Scout",
} as const;

export function approvalDecisionFeed(
  worker: { id: string; title: string },
  botAttentionOwned: boolean,
) {
  return {
    handoffs: [
      {
        handoff: {
          handoffId: "approval",
          requestedBy: { threadId: worker.id },
          title: "Private approval",
          createdAt: DateTime.makeUnsafe("2026-11-21T00:00:00Z"),
        },
        threadTitle: worker.title,
        ...(botAttentionOwned ? { botAttentionOwned: true } : {}),
      },
    ],
  };
}

export function stubAttentionStorage() {
  const storage = new Map([[cursorKey, "0"]]);
  return stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
}
