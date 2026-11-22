import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@goat/contracts";
import { AcpProviderCapabilitiesV2, makeAcpAdapterV2 } from "@goat/provider-acp/server/adapter";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { ACP_TEST_DRIVER, layerTest } from "./AcpAdapterV2.host.testkit.ts";
import {
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
  makeTurnInput,
} from "./AcpAdapterV2.testkit.ts";

// regression: #27646 an agent that leaves its mode itself must not be forced back, but picking
// the old mode again must reach it, even when a v1 agent reports only the mode update.
it.live("reports a mode the agent left itself so picking it again is sent", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-acp-mode-only-" });
    const statusPath = path.join(directory, "status.json");
    const sessionId = "mode-only-session";
    const modeOption = (currentValue: string) => ({
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue,
      options: [
        { value: "ask", name: "Ask" },
        { value: "architect", name: "Architect" },
      ],
    });
    const setArchitect = [
      {
        type: "expect_outbound" as const,
        frame: {
          kind: "request",
          method: "session/set_config_option",
          params: { sessionId, configId: "mode", value: "architect" },
        },
      },
      {
        type: "emit_inbound" as const,
        frame: {
          kind: "response",
          method: "session/set_config_option",
          result: { configOptions: [modeOption("architect")] },
        },
      },
    ];
    const prompt = (updates: ReadonlyArray<unknown>) => [
      {
        type: "expect_outbound" as const,
        frame: { kind: "request", method: "session/prompt", params: "<any>" },
      },
      ...updates.map((update) => ({
        type: "emit_inbound" as const,
        frame: { kind: "notification", method: "session/update", params: { sessionId, update } },
      })),
      {
        type: "emit_inbound" as const,
        frame: { kind: "response", method: "session/prompt", result: { stopReason: "end_turn" } },
      },
    ];
    const transcript = yield* decodeAcpReplayTranscript(
      {
        provider: ACP_TEST_DRIVER,
        protocol: "acp.ndjson-jsonrpc",
        version: "1",
        scenario: "mode-only-update",
        entries: [
          {
            type: "expect_outbound",
            frame: { kind: "request", method: "initialize", params: "<any>" },
          },
          {
            type: "emit_inbound",
            frame: {
              kind: "response",
              method: "initialize",
              result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
            },
          },
          {
            type: "expect_outbound",
            frame: { kind: "request", method: "session/new", params: "<any>" },
          },
          {
            type: "emit_inbound",
            frame: {
              kind: "response",
              method: "session/new",
              result: { sessionId, configOptions: [modeOption("ask")] },
            },
          },
          ...setArchitect,
          ...prompt([{ sessionUpdate: "current_mode_update", currentModeId: "ask" }]),
          ...prompt([]),
          ...setArchitect,
          ...prompt([]),
        ],
      },
      ACP_TEST_DRIVER,
    );
    const instanceId = ProviderInstanceId.make("acp-test-mode-only");
    const threadId = ThreadId.make("thread-acp-mode-only");
    const adapter = yield* makeAcpAdapterV2({
      instanceId,
      flavor: {
        driver: ACP_TEST_DRIVER,
        capabilities: AcpProviderCapabilitiesV2,
        makeRuntime: makeAcpReplayRuntime({
          transcript,
          statusPath,
          fileSystem,
          scriptPath: yield* path.fromFileUrl(
            new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
          ),
          childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
        }),
      },
      selfInvocation: yield* resolveSelfInvocation(),
    });
    const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: directory,
    });
    const architect = {
      instanceId,
      model: "default",
      options: [{ id: "mode", value: "architect" }],
    } as const;
    const ask = { ...architect, options: [{ id: "mode", value: "ask" }] };
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("provider-session-acp-mode-only"),
      modelSelection: architect,
      runtimePolicy,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection: architect,
      runtimePolicy,
    });
    const now = yield* DateTime.now;
    const reported: Array<unknown> = [];
    // The thread follows the agent to ask; only the user's renewed pick sets architect again.
    for (const [ordinal, modelSelection] of [
      [1, architect],
      [2, ask],
      [3, architect],
    ] as const) {
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now,
          ordinal,
          modelSelection,
        }),
      );
      yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.type === "thread_model_selection.updated") {
              reported.push({
                threadId: event.threadId,
                instanceId: event.instanceId,
                changes: event.changes,
              });
            }
          }),
        ),
      );
    }
    assert.deepStrictEqual(reported, [
      { threadId, instanceId, changes: [{ id: "mode", from: "architect", to: "ask" }] },
    ]);
    yield* makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript);
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);
