// @effect-diagnostics nodeBuiltinImport:off - ACP fixtures use Node HTTP servers and native paths
import { assert, describe, it } from "@effect/vitest";
import {
  ACP_SESSION_MODE_OPTION_ID,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type OrchestrationV2ProviderThread,
} from "@goat/contracts";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpProtocol from "effect-acp/protocol";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { AcpProviderCapabilitiesV2, makeAcpAdapterV2 } from "@goat/provider-acp/server/adapter";
import { layerTest, ACP_TEST_DRIVER } from "./AcpAdapterV2.host.testkit.ts";
import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import {
  bundledMockAgentPath,
  makeMockRuntime,
  pollProtocolMethods,
  rawProtocolMethod,
  rawProtocolRequestParam,
} from "./AcpMockRuntime.testkit.ts";

describe("AcpAdapterV2 refused before prompt", () => {
  // A start that cannot reopen its session may be on a session the agent lost. It is not a refusal
  // before the prompt, so the server's recovery for an unusable session still runs.
  it.live("does not mark a start whose session failed to reopen as refused before its prompt", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* bundledMockAgentPath;
      const protocolEvents = yield* Queue.unbounded<EffectAcpProtocol.AcpProtocolLogEvent>();
      const instanceId = ProviderInstanceId.make("acp-test-reopen-failure");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            protocolEvents,
            environment: () => ({ GOAT_ACP_FAIL_LOAD_SESSION: "1" }),
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-reopen-failure");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-reopen-failure"),
        modelSelection,
        runtimePolicy,
      });
      const thread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
      const lostThread: OrchestrationV2ProviderThread = {
        ...thread,
        nativeThreadRef: { driver: ACP_TEST_DRIVER, nativeId: "lost-session", strength: "strong" },
      };
      const now = yield* DateTime.now;
      const error = yield* runtime
        .startTurn(
          makeTurnInput({
            threadId,
            providerThread: lostThread,
            instanceId,
            runtimePolicy,
            now,
            ordinal: 1,
          }),
        )
        .pipe(Effect.flip);
      assert.instanceOf(error, ProviderAdapter.ProviderAdapterTurnStartError);
      assert.notEqual(
        (error as ProviderAdapter.ProviderAdapterTurnStartError).refusedBeforePrompt,
        true,
      );
      const methods = yield* pollProtocolMethods(protocolEvents);
      assert.isTrue(methods.includes("session/load") || methods.includes("session/resume"));
      assert.notInclude(methods, "session/prompt");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  // Only refusals that leave the session usable mark a start as refused before its prompt. A setup
  // step other than the model can fail because the session is gone.
  it.live("does not mark a start whose session setup failed as refused before its prompt", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const mockAgentPath = yield* bundledMockAgentPath;
      const protocolEvents = yield* Queue.unbounded<EffectAcpProtocol.AcpProtocolLogEvent>();
      const instanceId = ProviderInstanceId.make("acp-test-setup-failure");
      const threadId = ThreadId.make("thread-acp-setup-failure");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            protocolEvents,
            environment: { GOAT_ACP_FAIL_SET_MODE_CONFIG_OPTION: "1" },
          }),
        },
        selfInvocation: yield* resolveSelfInvocation(),
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const opened = { instanceId, model: "composer-2" } as const;
      const withMode = {
        instanceId,
        model: "composer-2",
        options: [{ id: ACP_SESSION_MODE_OPTION_ID, value: "code" }],
      } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-setup-failure"),
        modelSelection: opened,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: opened,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      const error = yield* runtime
        .startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now,
            ordinal: 1,
            modelSelection: withMode,
          }),
        )
        .pipe(Effect.flip);
      assert.instanceOf(error, ProviderAdapter.ProviderAdapterTurnStartError);
      assert.notInstanceOf(
        (error as ProviderAdapter.ProviderAdapterTurnStartError).cause,
        ProviderAdapter.ProviderCompactionUnsupportedError,
      );
      assert.notEqual(
        (error as ProviderAdapter.ProviderAdapterTurnStartError).refusedBeforePrompt,
        true,
      );
      // The start reached the mode step the agent rejected, and sent no prompt.
      const outgoing = Array.from(yield* Queue.takeAll(protocolEvents)).filter(
        (event) => event.direction === "outgoing",
      );
      assert.isTrue(
        outgoing.some(
          (event) =>
            rawProtocolMethod(event) === "session/set_config_option" &&
            rawProtocolRequestParam(event, "configId") === "mode",
        ),
      );
      assert.notInclude(outgoing.map(rawProtocolMethod), "session/prompt");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
