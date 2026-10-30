/**
 * Replay frames and turn inputs shared by the OpenCode 2 adapter tests.
 */
import {
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type ProviderReplayEntry,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { OPENCODE_PROVIDER, openCode2DurableVersion } from "@goat/provider-opencode/testing";
import { openCode2ReplayRuntime } from "./OpenCode2AdapterV2.testkit.ts";
import { type ProviderReplayGate } from "@goat/provider-testing/replayGate";

export const SESSION = "ses_f148ca2deffeJcwCnRQtb0YFNX";
export const WORK = "/work/opencode2";
export const instanceId = ProviderInstanceId.make("opencode");
export const threadId = ThreadId.make("thread:opencode2-adapter");

export const out = (type: string, input?: unknown): ProviderReplayEntry => ({
  type: "expect_outbound",
  frame: input === undefined ? { type } : { type, input },
});
export const reply = (operation: string, data: unknown): ProviderReplayEntry => ({
  type: "emit_inbound",
  frame: { type: "sdk.response", operation, data },
});
export const replyData = (operation: string, data: unknown) => reply(operation, { data });
export const event = (
  type: string,
  data: Record<string, unknown>,
  label?: string,
): ProviderReplayEntry => {
  const version = openCode2DurableVersion(type);
  const durable =
    version === undefined ? {} : { durable: { aggregateID: SESSION, seq: 1, version } };
  return {
    type: "emit_inbound",
    frame: {
      type: "sdk.event",
      event: { id: `evt_${type.replaceAll(".", "")}0000`, created: 1, type, data, ...durable },
    },
    ...(label === undefined ? {} : { label }),
  };
};

export const mcpRules = [
  { action: "t3-code-*", resource: "*", effect: "deny" },
  { action: "goat-*", resource: "*", effect: "deny" },
  { action: "goat-c26f2f1fb6fbbcc2_*", resource: "*", effect: "allow" },
  { action: "cua-driver-*", resource: "*", effect: "deny" },
];
export const goatRules = [{ action: "*", resource: "*", effect: "allow" }, ...mcpRules];
const TITLE = "Prime check";
export const sessionInfo = (overrides: Record<string, unknown> = {}) => ({
  id: SESSION,
  title: TITLE,
  permissions: goatRules,
  projectID: "global",
  model: { id: "big-pickle", providerID: "opencode", variant: "default" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1790656601394, updated: 1790656601394 },
  location: { directory: WORK },
  ...overrides,
});
export const modelCatalog = {
  location: { directory: WORK },
  data: [
    {
      id: "big-pickle",
      modelID: "big-pickle",
      providerID: "opencode",
      family: "big-pickle",
      name: "Big Pickle",
      compatibility: { reasoningField: "reasoning_content" },
      package: "@opencode/ai/providers/openai-compatible",
      settings: { apiKey: "public", baseURL: "https://opencode.ai/zen/v1", provider: "opencode" },
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      variants: [],
      time: { released: 1760659200000 },
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      status: "active",
      enabled: true,
      limit: { context: 200000, input: 160000, output: 32000 },
    },
  ],
};

export const PROMPT_ID = "msg_0eb735d41001NJee1EvVePJAK5";
export const promptAccepted = replyData("session.prompt", {
  id: PROMPT_ID,
  sessionID: SESSION,
  time: { created: 1790656601410 },
  type: "user",
  payload: { text: "hi" },
  delivery: "steer",
});

export const noOpenRequests: ReadonlyArray<ProviderReplayEntry> = [
  out("permission.list", { sessionID: SESSION }),
  replyData("permission.list", []),
  out("session.form.list", { sessionID: SESSION }),
  replyData("session.form.list", []),
];

const withInstructions = (
  entries: ReadonlyArray<ProviderReplayEntry>,
): ReadonlyArray<ProviderReplayEntry> => {
  const first = entries.findIndex(
    (entry) =>
      entry.type === "expect_outbound" &&
      typeof entry.frame === "object" &&
      entry.frame !== null &&
      "type" in entry.frame &&
      [
        "session.prompt",
        "session.command",
        "session.compact",
        "command.list",
        "skill.list",
      ].includes(String(entry.frame.type)),
  );
  if (
    entries
      .slice(0, first)
      .some(
        (entry) =>
          entry.type === "expect_outbound" &&
          typeof entry.frame === "object" &&
          entry.frame !== null &&
          "type" in entry.frame &&
          entry.frame.type === "session.instructions.entry.put" &&
          "input" in entry.frame &&
          typeof entry.frame.input === "object" &&
          entry.frame.input !== null &&
          "key" in entry.frame.input &&
          entry.frame.input.key === "goat",
      )
  )
    return entries;
  // T3's MCP server is added before the entry that describes it.
  const after = entries.findIndex(
    (entry, index) =>
      index < first &&
      entry.type === "emit_inbound" &&
      typeof entry.frame === "object" &&
      entry.frame !== null &&
      "operation" in entry.frame &&
      entry.frame.operation === "mcp.add",
  );
  const at = after < 0 ? first : after + 1;
  return first < 0
    ? entries
    : [
        ...entries.slice(0, at),
        out("session.instructions.entry.put", {
          sessionID: SESSION,
          key: "goat",
          value: "<any>",
        }),
        reply("session.instructions.entry.put", null),
        ...entries.slice(at),
      ];
};

export const openCode2ReplayRuntimeWithInstructions = (
  entries: ReadonlyArray<ProviderReplayEntry>,
  options?: Parameters<typeof openCode2ReplayRuntime>[1],
) => openCode2ReplayRuntime(withInstructions(entries), options);

export const opening: ReadonlyArray<ProviderReplayEntry> = [
  out("event.subscribe"),
  out("model.list", "<any>"),
  reply("model.list", modelCatalog),
];
export const directoryModels = (directory: string): ReadonlyArray<ProviderReplayEntry> => [
  out("model.list", { "location[directory]": directory }),
  reply("model.list", { ...modelCatalog, location: { directory } }),
];

export const bigPickle: ModelSelection = { instanceId, model: "opencode/big-pickle" };
export const policy = (runtimeMode: "full-access" | "approval-required" = "full-access") => ({
  runtimeMode,
  interactionMode: "default" as const,
  cwd: WORK,
});

export const providerThread = (now: DateTime.Utc): OrchestrationV2ProviderThread => ({
  id: ProviderThreadId.make("provider-thread:opencode2-adapter"),
  driver: OPENCODE_PROVIDER,
  providerInstanceId: instanceId,
  providerSessionId: ProviderSessionId.make("provider-session:opencode2-adapter"),
  appThreadId: threadId,
  ownerNodeId: null,
  nativeThreadRef: { driver: OPENCODE_PROVIDER, nativeId: SESSION, strength: "strong" },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
});

export const turnInput = (
  thread: OrchestrationV2ProviderThread,
  modelSelection: ModelSelection = bigPickle,
  runtimeMode: "full-access" | "approval-required" = "full-access",
) => ({
  appThread: { title: TITLE } as OrchestrationV2AppThread,
  threadId,
  runId: RunId.make("run:opencode2-adapter"),
  runOrdinal: 1,
  providerTurnOrdinal: 1,
  attemptId: RunAttemptId.make("attempt:opencode2-adapter"),
  rootNodeId: NodeId.make("node:opencode2-adapter"),
  providerThread: thread,
  message: {
    messageId: MessageId.make("message:opencode2-adapter"),
    text: "hi",
    attachments: [],
    createdBy: "user" as const,
    creationSource: "web" as const,
    scheduledTaskId: undefined,
    senderThreadId: undefined,
  },
  modelSelection,
  runtimePolicy: policy(runtimeMode),
});

const buildPaths = [
  {
    action: "external_directory",
    resource: "/home/.local/share/opencode/tool-output/*",
    effect: "allow",
  },
];
export const agentList = {
  location: { directory: WORK },
  data: [
    {
      id: "build",
      name: "Build",
      request: { settings: {}, headers: {}, body: {} },
      description: "The default agent.",
      mode: "primary",
      hidden: false,
      permissions: [{ action: "*", resource: "*", effect: "allow" }, ...buildPaths],
    },
  ],
};
export const supervisedRules = [
  { action: "shell", resource: "*", effect: "ask" },
  { action: "edit", resource: "*", effect: "ask" },
  { action: "external_directory", resource: "*", effect: "ask" },
  ...buildPaths,
  ...mcpRules,
];

export const shellAsk = {
  data: {
    id: "per_0eb7c4d7e001Pyt8o50Vi4KrOO",
    sessionID: SESSION,
    action: "shell",
    resources: ["echo FIRST"],
    save: ["echo *"],
    source: { type: "tool", messageID: "msg_0eb7c4330001dYFQKuTpfD780v", id: "call_1" },
  },
};
export const shellAskEvent = event("permission.asked", shellAsk.data);
export const colorForm = {
  id: "frm_0eb79ab35001fkvFECSh3wYNVD",
  sessionID: SESSION,
  title: "Questions",
  metadata: { kind: "question" },
  fields: [
    {
      key: "q0",
      title: "Color preference",
      description: "Which color do you prefer?",
      type: "string",
      options: [{ value: "Red", label: "Red" }],
      custom: true,
    },
  ],
};

export const resumed = (
  entries: ReadonlyArray<ProviderReplayEntry>,
  options?: {
    readonly external?: boolean;
    readonly supervised?: boolean;
    readonly memoryInstructions?: (value: string) => Response;
    readonly onInstructions?: (key: string, value: string) => void;
    readonly replayGate?: ProviderReplayGate;
    readonly attachmentsDir?: string;
    readonly resolveExtractedTextPath?: (path: string) => Effect.Effect<string | undefined>;
    readonly fileSystem?: FileSystem.FileSystem;
    readonly onPrompt?: (input: unknown) => void;
  },
) =>
  Effect.gen(function* () {
    const runtime = yield* openCode2ReplayRuntime(
      withInstructions([
        ...opening,
        out("session.get", { sessionID: SESSION }),
        replyData("session.get", sessionInfo()),
        ...noOpenRequests,
        ...(options?.supervised === true
          ? [
              out("agent.list", "<any>"),
              reply("agent.list", agentList),
              out("session.update", { sessionID: SESSION, permissions: supervisedRules }),
              reply("session.update", null),
            ]
          : []),
        ...entries,
      ]),
      {
        ...(options?.onInstructions === undefined
          ? {}
          : { onInstructions: options.onInstructions }),
        ...(options?.memoryInstructions === undefined
          ? {}
          : { memoryInstructions: options.memoryInstructions }),
        ...(options?.fileSystem === undefined ? {} : { fileSystem: options.fileSystem }),
        ...(options?.onPrompt === undefined ? {} : { onPrompt: options.onPrompt }),
        ...(options?.external === undefined ? {} : { external: options.external }),
        ...(options?.replayGate === undefined ? {} : { replayGate: options.replayGate }),
        ...(options?.attachmentsDir === undefined
          ? {}
          : { attachmentsDir: options.attachmentsDir }),
        ...(options?.resolveExtractedTextPath === undefined
          ? {}
          : { resolveExtractedTextPath: options.resolveExtractedTextPath }),
      },
    );
    const thread = yield* runtime.resumeThread({
      providerThread: providerThread(yield* DateTime.now),
      threadId,
      modelSelection: bigPickle,
      runtimePolicy: policy(options?.supervised === true ? "approval-required" : "full-access"),
    });
    return { runtime, thread };
  });

export const requestOf = (runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime) =>
  runtime.events.pipe(
    Stream.filter(
      (
        event,
      ): event is Extract<
        ProviderAdapter.ProviderAdapterV2Event,
        { type: "runtime_request.updated" }
      > => event.type === "runtime_request.updated",
    ),
    Stream.map((event) => event.runtimeRequest),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );

export const terminalOf = (runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime) =>
  runtime.events.pipe(
    Stream.filter(
      (
        event,
      ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }> =>
        event.type === "turn.terminal",
    ),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );

export const history = {
  data: [
    {
      id: "msg_0eb732081001RntUJfRtTXOAjd",
      time: { created: 1790656585885 },
      text: "Think carefully step by step about whether 391 is prime, showing your reasoning, then answer in one short sentence.",
      type: "user",
    },
    {
      id: "msg_0eb7320a9001vve3OV5uNi2HRT",
      time: { created: 1790656585925, streamed: 1790656590719, completed: 1790656590736 },
      type: "assistant",
      agent: "build",
      model: { id: "space-bunny-free", providerID: "opencode", variant: "high" },
      content: [
        { type: "reasoning", text: "Check divisibility up to sqrt(391)." },
        { type: "text", text: "391 is not prime: it's the product 17 × 23." },
      ],
      finish: "stop",
      cost: 0,
      tokens: { input: 8701, output: 113, reasoning: 147, cache: { read: 489, write: 0 } },
    },
    {
      id: "msg_0eb733399001NhwTrB32UU6d6H",
      time: { created: 1790656590745 },
      type: "idle",
      outcome: "succeeded",
    },
  ],
  cursor: {},
};

export const childCreated = (child: string) => ({
  sessionID: child,
  slug: "proud-canyon",
  version: "2.0.18",
  projectID: "global",
  parentID: SESSION,
  location: { directory: WORK },
  subpath: "",
  title: "Sleep",
  agent: "general",
  model: { id: "big-pickle", providerID: "opencode", variant: "default" },
});
export const backgroundLaunch = (child: string): ReadonlyArray<ProviderReplayEntry> => {
  const call = "call-background";
  const tool = { sessionID: SESSION, assistantMessageID: "msg_assistant", id: call };
  return [
    out("session.prompt", { sessionID: SESSION, text: "<any>" }),
    promptAccepted,
    event("session.execution.started", { sessionID: SESSION }),
    event("session.tool.input.started", { ...tool, name: "subagent" }),
    event("session.tool.called", {
      ...tool,
      name: "subagent",
      input: { description: "Sleep", prompt: "sleep", background: true },
      executed: false,
    }),
    event("session.created", childCreated(child)),
    event("session.tool.progress", {
      ...tool,
      metadata: { sessionID: child, status: "running" },
    }),
  ];
};
export const withLineage = (thread: OrchestrationV2ProviderThread) => ({
  ...turnInput(thread),
  appThread: {
    id: threadId,
    title: TITLE,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  } as OrchestrationV2AppThread,
});
export const CHILD = "ses_f1485c529ffea4URrYruwEg0Ja";
