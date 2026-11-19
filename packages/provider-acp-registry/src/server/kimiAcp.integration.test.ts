import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { makeTurnInput } from "../../../../apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.testkit.ts";
import { makeMockRuntime } from "../../../../apps/server/src/orchestration-v2/Adapters/AcpMockRuntime.testkit.ts";
import { AcpProviderCapabilitiesV2, makeAcpAdapterV2 } from "@goat/provider-acp/server/adapter";
import { kimiRecordedEnvironment, makeKimiPromptOutcomeWatch } from "./kimiAcp.ts";
import { AcpRegistrySettings } from "../settings.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import { makeAcpRegistryAdapterV2 } from "./adapter.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const layerTest = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
);

it.effect.each([false, true])(
  "a Kimi turn uses only its recorded launch environment (known: %s)",
  (known) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const path = yield* Path.Path;
      const directory = path.join(
        home,
        "sessions",
        "workspace",
        "mock-session-1",
        "agents",
        "main",
      );
      yield* fs.makeDirectory(directory, { recursive: true });
      const wire = path.join(directory, "wire.jsonl");
      yield* fs.writeFileString(wire, "");
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../../apps/server/scripts/acp-mock-agent.ts", import.meta.url),
      );
      const makeRuntime = makeMockRuntime({
        childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
        mockAgentPath,
        wrapRuntime: (runtime) => ({
          ...runtime,
          prompt: () =>
            fs
              .writeFileString(
                wire,
                JSON.stringify({ type: "turn.prompt", agentId: "main", turnId: 1 }) +
                  "\n" +
                  JSON.stringify({
                    type: "turn.ended",
                    agentId: "main",
                    turnId: 1,
                    reason: "failed",
                    error: { message: "fixture failure" },
                  }) +
                  "\n",
                { flag: "a" },
              )
              .pipe(Effect.orDie, Effect.as({ stopReason: "end_turn" as const })),
        }),
      });
      const instanceId = ProviderInstanceId.make("kimi-no-session-environment");
      const watch = yield* makeKimiPromptOutcomeWatch();
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        currentEnvironment: Effect.succeed({ HOME: home, KIMI_CODE_HOME: home }),
        selfInvocation: yield* resolveSelfInvocation(),
        flavor: {
          driver: ProviderDriverKind.make("acpRegistry"),
          capabilities: AcpProviderCapabilitiesV2,
          resolveSessionLaunch: () =>
            Effect.succeed(
              known ? { spawn: { env: { HOME: home, KIMI_CODE_HOME: home } } } : undefined,
            ),
          watchPromptOutcome: (sessionId, session) =>
            watch(
              sessionId,
              kimiRecordedEnvironment(
                session.recordedEnvironment,
                session.runtimeEnvironment,
                session.sessionLaunch,
              ),
            ),
          makeRuntime,
        },
      });
      const threadId = ThreadId.make("thread-kimi-no-environment");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("kimi-no-environment"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        }),
      );
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
      );
      const terminal = [...events].find((event) => event.type === "turn.terminal");
      assert.equal(
        terminal?.type === "turn.terminal" ? terminal.status : undefined,
        known ? "failed" : "completed",
      );
      if (terminal?.type === "turn.terminal" && terminal.status === "failed")
        assert.equal(terminal.failure.message, "fixture failure");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
);

it.live.each([
  { source: "local", commandPath: "kimi" },
  { source: "local", commandPath: "C:\\tools\\kimi.exe" },
  { source: "registry", agentId: "kimi-code" },
] as const)("the Kimi registry adapter attributes a session's recorded failure (%o)", (settings) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    const directory = path.join(home, "sessions", "workspace", "mock-session-1", "agents", "main");
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.writeFileString(path.join(directory, "wire.jsonl"), "");
    const script = path.join(home, "agent.mjs");
    yield* fs.writeFileString(
      script,
      `
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
createInterface({input: process.stdin}).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result = {};
  if (request.method === "initialize") result = { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
  if (request.method === "session/new") result = { sessionId: "mock-session-1" };
  if (request.method === "session/prompt") {
    const file = join(process.env.KIMI_CODE_HOME, "sessions", "workspace", "mock-session-1", "agents", "main", "wire.jsonl");
    appendFileSync(file, JSON.stringify({ type: "turn.prompt", agentId: "main", turnId: 1 }) + "\\n" + JSON.stringify({ type: "turn.ended", agentId: "main", turnId: 1, reason: "failed", error: { message: "registry fixture failure" } }) + "\\n");
    result = { stopReason: "end_turn" };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});
`,
    );
    const instanceId = ProviderInstanceId.make("kimi-registry-integration");
    const environment = { HOME: home, KIMI_CODE_HOME: home };
    const adapter = yield* makeAcpRegistryAdapterV2({
      instanceId,
      settings: decodeSettings(settings),
      environment,
      selfInvocation: yield* resolveSelfInvocation(),
    }).pipe(
      Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, {
        search: () => Effect.die("unexpected search"),
        prepare: () => Effect.die("unexpected prepare"),
        inspect: () => Effect.die("unexpected inspect"),
        uninstallManagedBinary: () => Effect.die("unexpected uninstall"),
        resolve: (_settings, cwd) =>
          Effect.succeed({
            distribution: "local" as const,
            spawn: { command: process.execPath, args: [script], cwd, env: environment },
          }),
      }),
    );
    const threadId = ThreadId.make("thread-kimi-registry-integration");
    const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: home,
    });
    const modelSelection = { instanceId, model: "default" } as const;
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("kimi-registry-integration"),
      modelSelection,
      runtimePolicy,
    });
    const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
    yield* runtime.startTurn(
      makeTurnInput({
        threadId,
        providerThread,
        instanceId,
        runtimePolicy,
        now: yield* DateTime.now,
      }),
    );
    const events = yield* runtime.events.pipe(
      Stream.takeUntil((event) => event.type === "turn.terminal"),
      Stream.runCollect,
    );
    const terminal = [...events].find((event) => event.type === "turn.terminal");
    assert.equal(terminal?.type === "turn.terminal" ? terminal.status : undefined, "failed");
    if (terminal?.type === "turn.terminal" && terminal.status === "failed")
      assert.equal(terminal.failure.message, "registry fixture failure");
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);
