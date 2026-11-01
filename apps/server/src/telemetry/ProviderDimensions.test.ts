import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId, type ServerProvider } from "@goat/contracts";
import { ingestDrops } from "./ingestAllowlist.testkit.ts";
import { agentToolProperties, handoffSettings, type AgentThread } from "./ProviderDimensions.ts";

const provider = (
  instanceId: string,
  driver: string,
  models: ReadonlyArray<{ slug: string; isCustom: boolean }>,
) =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver,
    models,
  }) as unknown as ServerProvider;

const providers = [
  provider("work-codex", "codex", [{ slug: "gpt-5.5", isCustom: false }]),
  provider("claudeAgent", "claudeAgent", [
    { slug: "claude-opus-5-5", isCustom: false },
    { slug: "my-private-finetune", isCustom: true },
  ]),
  provider("opencode", "opencode", [{ slug: "ollama/acme-internal", isCustom: false }]),
];

const thread = (
  instanceId: string,
  model: string,
  overrides: Partial<AgentThread> = {},
): AgentThread => ({
  modelSelection: { instanceId: ProviderInstanceId.make(instanceId), model },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make("t") },
  ...overrides,
});

it("omits custom, user-configured, and unknown models and instance names", () => {
  expect(
    agentToolProperties({
      tool: "goat_thread_send",
      providers,
      caller: thread("claudeAgent", "my-private-finetune"),
      targets: [thread("opencode", "ollama/acme-internal"), thread("removed-instance", "gpt-5.5")],
      outcome: { outcome: "ok" },
    }).map(({ callerProvider, callerModel, targetProvider, targetModel }) => ({
      callerProvider,
      callerModel,
      targetProvider,
      targetModel,
    })),
  ).toEqual([
    {
      callerProvider: "claudeAgent",
      callerModel: undefined,
      targetProvider: "opencode",
      targetModel: undefined,
    },
    {
      callerProvider: "claudeAgent",
      callerModel: undefined,
      targetProvider: "unknown",
      targetModel: undefined,
    },
  ]);
});

it("drops input strings outside the schema's literals, since rejected calls are recorded too", () => {
  expect(handoffSettings("delegate_task", { mode: "/home/me/secret" }, undefined)).toEqual({
    targetChosen: false,
    mode: "async",
  });
  expect(
    handoffSettings("goat_thread_launch", { workspaceStrategy: { type: "/home/me/secret" } }, {}),
  ).toEqual({ targetChosen: false, workspace: "root" });
});

it("reports only properties GOAT's ingest stores for mcp.tool.invoked", () => {
  const settings = [
    handoffSettings("delegate_task", { target: {}, mode: "wait" }, { waitTimedOut: true }),
    handoffSettings("create_threads", { threads: [{ target: {} }] }, {}),
    handoffSettings("goat_thread_launch", { scratch: true, modelSelection: {} }, {}),
    handoffSettings("goat_thread_send", {}, { delivery: "steer" }),
    handoffSettings("schedule_task", { bindToCurrentThread: false }, {}),
  ];
  const recorded = settings.flatMap((setting) =>
    agentToolProperties({
      tool: "delegate_task",
      providers,
      caller: thread("work-codex", "gpt-5.5"),
      callerDepth: 2,
      callerScheduledRun: true,
      targets: [thread("claudeAgent", "claude-opus-5-5")],
      outcome: { outcome: "error", errorCode: "not_found" },
      settings: setting,
      durationMs: 12,
    }).map((properties) => ({ event: "mcp.tool.invoked", properties })),
  );
  expect(ingestDrops(recorded)).toEqual([]);
});
