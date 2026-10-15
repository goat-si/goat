import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Acp from "effect-acp/compat";
import type * as Adapter from "@goat/provider-core/server/ProviderAdapter";
import type { CloudRelay } from "../relay.ts";
import { DRIVER } from "../capabilities.ts";
import type { TaskInput } from "../task.ts";

export const instanceId = ProviderInstanceId.make("cloud-fixture");
export const sessionId = ProviderSessionId.make("runtime-fixture");
export const at = DateTime.makeUnsafe("2026-10-13T00:00:00Z");
export const binding = "sibling-fixture";
export const thread: OrchestrationV2ProviderThread = {
  id: ProviderThreadId.make("provider-thread-fixture"),
  driver: DRIVER,
  providerInstanceId: instanceId,
  providerSessionId: sessionId,
  appThreadId: ThreadId.make("thread-fixture"),
  ownerNodeId: null,
  nativeThreadRef: {
    driver: DRIVER,
    nativeId: "devin-fixture-session",
    strength: "strong",
    fingerprint: binding,
    ordinal: 1,
  },
  nativeConversationHeadRef: null,
  status: "active",
  firstRunOrdinal: 1,
  lastRunOrdinal: 1,
  handoffIds: [],
  forkedFrom: null,
  pendingBackgroundTasks: [],
  contextUsage: null,
  nativeMetadata: null,
  goal: null,
  createdAt: at,
  updatedAt: at,
  cloudTask: {
    taskId: "devin-fixture-session",
    status: "submitting",
    tracking: "live",
    source: {
      repository: "https://github.com/example/project",
      branch: "published",
      sha: "a".repeat(40),
    },
    localChangesExcluded: true,
    updatedAt: DateTime.formatIso(at),
  },
};
export const taskInput: TaskInput = {
  threadId: thread.appThreadId!,
  runId: RunId.make("run-fixture"),
  runOrdinal: 1,
  attemptId: RunAttemptId.make("attempt-fixture"),
  rootNodeId: NodeId.make("root-fixture"),
  providerThread: thread,
  providerTurnOrdinal: 1,
  commitCloudTask: () => Effect.void,
  commitCloudTaskMetadata: () => Effect.void,
};
export const launch = {
  sourceInstanceId: ProviderInstanceId.make("devin-sibling"),
  command: "/selected/devin",
  cwd: "/trusted/project",
  env: {},
  binding,
};
export const opened: Adapter.ProviderAdapterV2OpenSessionInput = {
  threadId: taskInput.threadId,
  providerSessionId: sessionId,
  modelSelection: { instanceId, model: "default" },
  runtimePolicy: { cwd: launch.cwd, runtimeMode: "full-access", interactionMode: "default" },
};
export const appThread: OrchestrationV2AppThread = {
  id: taskInput.threadId,
  projectId: ProjectId.make("project-fixture"),
  title: "Cloud fixture",
  providerInstanceId: instanceId,
  modelSelection: opened.modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "published",
  worktreePath: null,
  activeProviderThreadId: thread.id,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: taskInput.threadId },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
};
export const turnInput: Adapter.ProviderAdapterV2TurnInput = {
  ...taskInput,
  appThread,
  modelSelection: opened.modelSelection,
  runtimePolicy: opened.runtimePolicy,
  // Adapter boundary fixture only; integrated CI supplies the real sink callback.
  commitCloudTaskMetadata: () => Effect.void,
  cloudSource: thread.cloudTask!.source,
  message: {
    messageId: MessageId.make("user-fixture"),
    text: "make the change",
    attachments: [],
    createdBy: "user",
    creationSource: "web",
  },
};
export const textUpdate = (
  text: string,
  session = "devin-fixture-session",
  messageId = "message-1",
): Acp.SessionNotification => ({
  sessionId: session,
  update: { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } },
});
export const repoOptions: ReadonlyArray<Acp.SessionConfigOption> = [
  {
    id: "org_id",
    name: "Organization",
    type: "select",
    currentValue: "org-fixture",
    options: [{ name: "Fixture", value: "org-fixture" }],
  },
  {
    id: "repos",
    name: "Repositories",
    type: "select",
    currentValue: "",
    options: [{ name: "Project", value: "example/project" }],
  },
];
export const selectedRepoOptions: ReadonlyArray<Acp.SessionConfigOption> = repoOptions.map(
  (option) =>
    option.id === "repos" && option.type === "select"
      ? { ...option, currentValue: "example/project" }
      : option,
);
export const sessionUrl = "https://app.devin.ai/sessions/fixture-session";
export const sessionMeta = (status = "working") => ({
  "cognition.ai/session": {
    "cognition.ai/url": sessionUrl,
    "cognition.ai/statusEnum": status,
    "cognition.ai/sessionStatus": "running",
    "cognition.ai/userActionRequired": status === "blocked" ? "Provide instructions" : null,
  },
});
export const relay = (overrides: Partial<CloudRelay> = {}): CloudRelay => ({
  capabilities: { loadSession: true },
  create: Effect.succeed({ sessionId: "devin-fixture-session", configOptions: repoOptions }),
  configureSource: () => Effect.void,
  attach: () => Effect.succeed({ configOptions: selectedRepoOptions }),
  prompt: () => Effect.succeed({ stopReason: "end_turn" }),
  cancel: () => Effect.void,
  ...overrides,
});
