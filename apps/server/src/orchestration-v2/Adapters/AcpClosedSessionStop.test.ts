import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  ThreadId,
} from "@goat/contracts";
import { AcpProviderCapabilitiesV2, makeAcpAdapterV2 } from "@goat/provider-acp/server/adapter";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as DocumentText from "../../provider/DocumentText.ts";
import { makeMockRuntime } from "./AcpMockRuntime.testkit.ts";

const platform = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
const layerTest = Layer.mergeAll(
  DocumentText.layer.pipe(Layer.provide(platform)),
  platform,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(platform)),
);

it.live("a Stop sent after its ACP session closed gets an outcome, not a bare interrupt", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const instanceId = ProviderInstanceId.make("acp-test-closed-session-stop");
    const threadId = ThreadId.make("thread-acp-closed-session-stop");
    const adapter = yield* makeAcpAdapterV2({
      instanceId,
      selfInvocation: yield* resolveSelfInvocation(),
      flavor: {
        driver: ProviderDriverKind.make("acp-test"),
        capabilities: AcpProviderCapabilitiesV2,
        makeRuntime: makeMockRuntime({
          childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
          mockAgentPath: yield* path.fromFileUrl(
            new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
          ),
        }),
      },
    });
    const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: process.cwd(),
    });
    const modelSelection = { instanceId, model: "default" } as const;
    const sessionScope = yield* Scope.make();
    const runtime = yield* adapter
      .openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-closed-session-stop"),
        modelSelection,
        runtimePolicy,
      })
      .pipe(Effect.provideService(Scope.Scope, sessionScope));
    const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
    yield* Scope.close(sessionScope, Exit.void);
    // A run whose provider exited stops its turn this way after the session was released.
    const stopped = yield* runtime
      .interruptTurn({
        providerThread,
        providerTurnId: ProviderTurnId.make("provider-turn-acp-closed-session-stop"),
        requestRuntimeRestart: true,
      })
      .pipe(Effect.exit);
    assert.isFalse(Exit.isFailure(stopped) && Cause.hasInterruptsOnly(stopped.cause));
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);
