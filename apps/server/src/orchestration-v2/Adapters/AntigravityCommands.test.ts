import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@goat/contracts";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Ref from "effect/Ref";
import * as Fiber from "effect/Fiber";
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

describe("AntigravityAdapterV2 compaction", () => {
  it.live.each([false, true])(
    "negotiates native goals (%s) without enabling manual compaction",
    (nativeGoals) =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const path = yield* Path.Path;
        const crypto = yield* SecureRandom.SecureRandom;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const instanceId = ProviderInstanceId.make("antigravity-compaction-test");
        const goalSupport = yield* Ref.make(false);
        const startupMilestone = yield* Deferred.make<void>();
        const consumeStartupCommands = yield* Deferred.make<void>();
        const workspaceCommands = yield* Ref.make<{
          readonly names: ReadonlyArray<string>;
          readonly cwd: string;
        } | null>(null);
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
              Effect.map((runtime) => ({
                ...runtime,
                drainEvents: Deferred.succeed(startupMilestone, undefined).pipe(
                  Effect.andThen(runtime.drainEvents),
                ),
              })),
            ),
          withProcess: (_stop, task) => task,
          defaultModel: Effect.undefined,
          supportsNativeGoals: Ref.get(goalSupport).pipe(
            Effect.tap(() => Deferred.succeed(startupMilestone, undefined)),
          ),
          onSessionEvent: (event, cwd) =>
            event._tag === "AvailableCommandsUpdated"
              ? Deferred.await(consumeStartupCommands).pipe(
                  Effect.andThen(Ref.set(goalSupport, nativeGoals)),
                  Effect.andThen(
                    Ref.set(workspaceCommands, {
                      names: event.availableCommands.map((command) => command.name),
                      cwd,
                    }),
                  ),
                )
              : Effect.void,
        });
        const opening = yield* adapter
          .openSession({
            threadId: ThreadId.make("thread-antigravity-compaction"),
            providerSessionId: ProviderSessionId.make("provider-session-antigravity-compaction"),
            modelSelection: { instanceId, model: "gemini-test-low" },
            runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: process.cwd(),
            }),
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(startupMilestone);
        yield* Deferred.succeed(consumeStartupCommands, undefined);
        const session = yield* Fiber.join(opening);
        assert.deepEqual(yield* Ref.get(workspaceCommands), {
          names: ["plan", "logout"],
          cwd: process.cwd(),
        });
        assert.isUndefined(session.compactThread);
        assert.equal(session.providerSession.capabilities.turns.supportsNativeGoals, nativeGoals);
        assert.equal((yield* adapter.getCapabilities()).turns.supportsNativeGoals, nativeGoals);
      }).pipe(Effect.provide(layerSession)),
  );
});
