import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2ProviderThread,
  type ProviderInstanceEnvironment,
} from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as HostProcess from "@goat/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { vi } from "vite-plus/test";
import * as Config from "../config.ts";
import { fleetSnapshot } from "../hub/parity.testkit.ts";
import * as MemoryDerivedCache from "../memory/MemoryDerivedCache.ts";
import * as Inventory from "../opencodex/OpenCodexInventory.ts";
import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as Runner from "../processRunner.ts";
import { makeClaudeTextGeneration } from "../textGeneration/ClaudeTextGeneration.ts";
import { buildClaudeCapabilitiesProbeQueryOptions } from "./ClaudeProvider.ts";
import { prepareProviderHomeRuntime } from "./ProviderHomeRuntime.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof ClaudeSdk>()),
  resolveSettings: vi.fn(),
}));
/** The policy tier Claude Code would read on this machine; nothing else in the cascade. */
const managedTier = (env: Record<string, string> | undefined) =>
  vi
    .mocked(ClaudeSdk.resolveSettings)
    .mockReset()
    .mockResolvedValue({
      effective: {},
      provenance: {},
      sources: env === undefined ? [] : [{ source: "managed", settings: { env } }],
    });

const HOME = "http://127.0.0.1:10100/v1";
const PINNED = {
  ANTHROPIC_BASE_URL: "http://127.0.0.1:10100",
  ANTHROPIC_AUTH_TOKEN: "opencodex-loopback",
  ANTHROPIC_API_KEY: "",
  CLAUDE_CODE_USE_BEDROCK: "",
  CLAUDE_CODE_USE_VERTEX: "",
};
const MODEL = {
  instanceId: ProviderInstanceId.make("claude-home"),
  model: "claude-sonnet-4-6",
} satisfies ModelSelection;
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);
const probeAbort = new AbortController();

/** The local OpenCodex boundary; its export describes one Home model for OpenCode clients. */
const layerOpenCodex = (calls: Array<Runner.ProcessRunInput>) =>
  Layer.mergeAll(
    Layer.mock(Inventory.OpenCodexInventory)({
      readParity: Effect.succeed({
        ...fleetSnapshot("mac-studio"),
        binaries: [{ path: "/fixture/ocx", version: "2.92.0" }],
      }),
    }),
    Layer.mock(Runner.ProcessRunner)({
      run: (input) =>
        Effect.sync(() => {
          calls.push(input);
          return {
            stdout: JSON.stringify({
              provider: {
                opencodex: { options: { baseURL: HOME }, models: { "claude-sonnet-4-6": {} } },
              },
              providers: {
                opencodex: { settings: { baseURL: HOME }, models: { "claude-sonnet-4-6": {} } },
              },
            }),
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    }),
    Config.layerTest(process.cwd(), { prefix: "claude-home-settings-" }),
    MemoryDerivedCache.layer,
    IdAllocator.layer,
    McpProviderSessions.layer,
  ).pipe(Layer.provideMerge(NodeServices.layer));

/** A user home and a project whose Claude settings each point somewhere other than Home. */
const conflictingSettings = Effect.fn("ClaudeHomeSettingsTest.conflictingSettings")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const user = yield* fs.makeTempDirectoryScoped({ prefix: "claude-user-home-" });
  const project = yield* fs.makeTempDirectoryScoped({ prefix: "claude-project-" });
  const write = (file: string, env: Record<string, string>) =>
    fs
      .makeDirectory(path.dirname(file), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(file, JSON.stringify({ env }))));
  yield* write(path.join(user, "settings.json"), {
    ANTHROPIC_BASE_URL: "https://user.example",
    ANTHROPIC_API_KEY: "user-fixture-key",
    CLAUDE_CODE_USE_BEDROCK: "1",
  });
  yield* write(path.join(project, ".claude", "settings.json"), {
    ANTHROPIC_BASE_URL: "https://project.example",
    ANTHROPIC_AUTH_TOKEN: "project-fixture-token",
  });
  yield* write(path.join(project, ".claude", "settings.local.json"), {
    CLAUDE_CODE_USE_VERTEX: "1",
  });
  return { user, project };
});

const routedEnvironment = (user: string) =>
  prepareProviderHomeRuntime(
    "claudeAgent",
    MODEL.instanceId,
    { modelRoute: "opencodex", opencodexBaseUrl: HOME },
    [{ name: "CLAUDE_CONFIG_DIR", value: user, sensitive: false }],
  ).pipe(Effect.provideService(HostProcess.Environment, {}));

/** Starts one turn on the real adapter and returns the options it handed the Claude SDK. */
const launchOptions = Effect.fn("ClaudeHomeSettingsTest.launchOptions")(function* (
  environment: ProviderInstanceEnvironment,
  cwd: string,
) {
  const opened: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOptions> = [];
  const adapter = yield* ClaudeAdapterV2.createClaudeAdapterV2(
    {
      instanceId: MODEL.instanceId,
      displayName: undefined,
      environment,
      enabled: true,
      config: { ...decodeClaudeSettings({}), binaryPath: "/fixture/claude" },
    },
    {},
  ).pipe(
    Effect.provideService(ClaudeAdapterV2.ClaudeAgentSdkQueryRunner, {
      allocateSessionId: Effect.succeed("native-thread-claude-home"),
      open: (input) =>
        Effect.sync(() => {
          opened.push(input.options);
          return {
            messages: Stream.never,
            offer: () => Effect.void,
            setModel: () => Effect.void,
            applyFlagSettings: () => Effect.void,
            setPermissionMode: () => Effect.void,
            backgroundTasks: () => Effect.succeed(false),
            stopTask: () => Effect.void,
            interrupt: Effect.void,
            close: Effect.void,
          };
        }),
      forkSession: () => Effect.die("unused"),
      subagentLaunchToolUseId: () => Effect.succeed(null),
      assertComplete: Effect.void,
    }),
  );
  const threadId = ThreadId.make("thread-claude-home");
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd,
  });
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("provider-session-claude-home"),
    modelSelection: MODEL,
    runtimePolicy,
  });
  const providerThread = yield* runtime.ensureThread({
    threadId,
    modelSelection: MODEL,
    runtimePolicy,
  });
  yield* runtime.startTurn(turnInput(threadId, providerThread, yield* DateTime.now, runtimePolicy));
  return opened;
});

const turnInput = (
  threadId: ThreadId,
  providerThread: OrchestrationV2ProviderThread,
  now: DateTime.Utc,
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): ProviderAdapter.ProviderAdapterV2TurnInput => ({
  appThread: {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("project-claude-home"),
    title: "Claude Home",
    providerInstanceId: MODEL.instanceId,
    modelSelection: MODEL,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: providerThread.id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
  threadId,
  runId: RunId.make("run-claude-home"),
  runOrdinal: 1,
  providerTurnOrdinal: 1,
  attemptId: RunAttemptId.make("attempt-claude-home"),
  rootNodeId: NodeId.make("node-claude-home"),
  providerThread,
  message: {
    createdBy: "user",
    creationSource: "web",
    messageId: MessageId.make("message-claude-home"),
    text: "hello",
    attachments: [],
  },
  modelSelection: MODEL,
  runtimePolicy,
});

it.effect(
  "pins Home in Claude's flag settings over conflicting user and project settings at launch",
  () =>
    Effect.gen(function* () {
      managedTier(undefined);
      const { user, project } = yield* conflictingSettings();
      const routed = yield* routedEnvironment(user);
      const [options] = yield* launchOptions(routed.environment, project);
      assert.isDefined(options);
      const settings = options?.settings;
      assert.isTrue(typeof settings === "object");
      if (typeof settings !== "object") return;
      assert.deepInclude(settings.env ?? {}, PINNED);
      assert.deepInclude(options?.env ?? {}, PINNED);

      // The default route leaves the user's own settings in charge.
      const [plain] = yield* launchOptions(
        [{ name: "CLAUDE_CONFIG_DIR", value: user, sensitive: false }],
        project,
      );
      const plainSettings = plain?.settings;
      assert.isUndefined(
        typeof plainSettings === "object" ? plainSettings.env?.ANTHROPIC_BASE_URL : undefined,
      );
    }).pipe(Effect.provide(layerOpenCodex([])), Effect.scoped),
);

it.effect("pins Home in the Claude text generation and capability probe launches", () =>
  Effect.gen(function* () {
    managedTier(undefined);
    const { user } = yield* conflictingSettings();
    const routed = yield* routedEnvironment(user);
    const environment = Object.fromEntries(
      routed.environment.map(({ name, value }) => [name, value]),
    );
    const probe = buildClaudeCapabilitiesProbeQueryOptions({
      executablePath: "/fixture/claude",
      abortController: probeAbort,
      environment,
      cwd: undefined,
      managedMcpConfig: false,
    });
    assert.deepInclude(
      typeof probe.settings === "object" ? (probe.settings.env ?? {}) : {},
      PINNED,
    );

    const spawned: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        if (ChildProcess.isStandardCommand(command)) spawned.push(command.args);
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(999_999_998),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    );
    const generation = yield* makeClaudeTextGeneration(
      { ...decodeClaudeSettings({}), binaryPath: "/fixture/claude" },
      environment,
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    yield* generation
      .generateCommitMessage({
        cwd: user,
        branch: null,
        stagedSummary: "fixture",
        stagedPatch: "fixture",
        modelSelection: MODEL,
      })
      .pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner), Effect.ignore);
    const args = spawned[0] ?? [];
    const settingsJson = args[args.indexOf("--settings") + 1] ?? "{}";
    assert.deepInclude(JSON.parse(settingsJson).env ?? {}, PINNED);
  }).pipe(Effect.provide(layerOpenCodex([])), Effect.scoped),
);

it.effect.each([
  {
    name: "an administrator policy",
    policy: { ANTHROPIC_BASE_URL: "https://corp.example" },
    cached: undefined,
  },
  {
    name: "cached server-managed settings",
    policy: undefined,
    cached: { CLAUDE_CODE_USE_BEDROCK: "1" },
  },
])("refuses Home routing when $name sets Claude's endpoint or backend", ({ policy, cached }) => {
  const calls: Array<Runner.ProcessRunInput> = [];
  return Effect.gen(function* () {
    managedTier(policy);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const user = yield* fs.makeTempDirectoryScoped({ prefix: "claude-managed-home-" });
    if (cached !== undefined)
      yield* fs.writeFileString(
        path.join(user, "remote-settings.json"),
        JSON.stringify({ env: cached }),
      );
    const result = yield* routedEnvironment(user).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.include(result.failure.message, "managed settings");
    assert.equal(calls.length, 0);
  }).pipe(Effect.provide(layerOpenCodex(calls)), Effect.scoped);
});
