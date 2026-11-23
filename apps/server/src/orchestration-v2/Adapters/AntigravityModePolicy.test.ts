import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@goat/contracts";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";
import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import * as Queue from "effect/Queue";
import type * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { makeAntigravityAcpRuntime } from "../../provider/acp/AntigravityAcpSupport.ts";
import { makeAntigravityAdapterV2 } from "./AntigravityAdapterV2.ts";
const layerSession = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

describe("AntigravityAdapterV2 runtime mode ceiling", () => {
  const modesSetFor = (
    pickedMode: string,
    modes: Pick<ProviderAdapter.ProviderAdapterV2RuntimePolicy, "runtimeMode">,
  ) =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      const modesSet: Array<string> = [];
      const instanceId = ProviderInstanceId.make("antigravity-ceiling-test");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { GOAT_ACP_ANTIGRAVITY: "1" },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              setMode: (modeId) =>
                Effect.sync(() => {
                  modesSet.push(modeId);
                }).pipe(Effect.andThen(runtime.setMode(modeId))),
            })),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const threadId = ThreadId.make("thread-antigravity-ceiling");
      yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-ceiling"),
        modelSelection: {
          instanceId,
          model: "gemini-test-low",
          options: [{ id: "_t3/session-mode", value: pickedMode }],
        },
        runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          ...modes,
          interactionMode: "default",
          cwd: process.cwd(),
        }),
      });
      return modesSet;
    }).pipe(Effect.provide(layerSession), Effect.scoped);

  it.effect("does not apply a picked session mode above the thread's runtime mode", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* modesSetFor("yolo", { runtimeMode: "approval-required" }), [
        "default",
      ]);
      assert.deepEqual(yield* modesSetFor("auto", { runtimeMode: "approval-required" }), [
        "default",
      ]);
      // A narrower mode is still the user's to pick.
      assert.deepEqual(yield* modesSetFor("default", { runtimeMode: "auto-accept-edits" }), [
        "auto_edit",
        "default",
      ]);
    }),
  );

  it.effect("leaving Plan keeps the permission mode the thread has now", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      let runtime: AcpSessionRuntime.AcpSessionRuntime["Service"] | undefined;
      const instanceId = ProviderInstanceId.make("antigravity-plan-exit-test");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { GOAT_ACP_ANTIGRAVITY: "1" },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.tap((made) =>
              Effect.sync(() => {
                runtime = made;
              }),
            ),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const threadId = ThreadId.make("thread-antigravity-plan-exit");
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const planPolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "plan",
        cwd: process.cwd(),
      });
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-plan-exit"),
        modelSelection,
        runtimePolicy: planPolicy,
      });
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      yield* session.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: planPolicy,
      });
      const supervisedPolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      yield* session.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy: supervisedPolicy,
          modelSelection,
          now: yield* DateTime.now,
        }),
      );
      yield* Stream.fromQueue(events).pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );
      assert.equal((yield* runtime!.getModeState)?.currentModeId, "default");
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );
});
