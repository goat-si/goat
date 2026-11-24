// @effect-diagnostics nodeBuiltinImport:off - ACP fixtures use Node HTTP servers and native paths
import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import { makeMockRuntime, bundledMockAgentPath } from "./AcpMockRuntime.testkit.ts";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@goat/contracts";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { AcpProviderCapabilitiesV2, makeAcpAdapterV2 } from "@goat/provider-acp/server/adapter";
import { layerTest, ACP_TEST_DRIVER } from "./AcpAdapterV2.host.testkit.ts";

describe("AcpAdapterV2 broken thread", () => {
  it.live("marks the thread broken when its saved history is unusable and refuses resume", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("acp-test-broken-thread");
      const threadId = ThreadId.make("thread-acp-broken-thread");
      const poisoned = {
        class: "provider_error",
        message: "Saved history is unusable.",
        code: "INVALID_THINKING_SIGNATURE",
        retryable: true,
      } as const;
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          watchPromptOutcome: () => Effect.succeed(() => Effect.succeed(poisoned)),
          makeRuntime: makeMockRuntime({
            childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
            mockAgentPath: yield* bundledMockAgentPath,
            wrapRuntime: (runtime) => ({
              ...runtime,
              prompt: () => Effect.succeed({ stopReason: "end_turn" as const }),
            }),
          }),
        },
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-broken-thread"),
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
          ordinal: 1,
        }),
      );
      const events = Array.from(
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      );
      const broken = events.at(-1);
      assert.equal(broken?.type === "turn.terminal" ? broken.threadDisposition : null, "broken");
      const brokenThread = events.findLast((event) => event.type === "provider_thread.updated");
      assert.equal(
        brokenThread?.type === "provider_thread.updated"
          ? brokenThread.providerThread.status
          : null,
        "error",
      );
      const resumed = yield* Effect.result(
        runtime.resumeThread({
          threadId,
          providerThread: { ...providerThread, status: "error" },
          modelSelection,
          runtimePolicy,
        }),
      );
      assert.equal(
        resumed._tag === "Failure" ? resumed.failure._tag : null,
        "ProviderAdapterResumeThreadError",
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
