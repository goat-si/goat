import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@goat/contracts";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
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
  it.live.each([
    { nativeGoals: false, compact: false },
    { nativeGoals: true, compact: false },
    { nativeGoals: false, compact: true },
  ])(
    "negotiates native goals ($nativeGoals) and advertised compaction ($compact)",
    ({ nativeGoals, compact }) =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* SecureRandom.SecureRandom;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const logs = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-ag-compact-" });
        const requestLog = path.join(logs, "requests.ndjson");
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
                env: {
                  GOAT_ACP_ANTIGRAVITY: "1",
                  GOAT_ACP_AVAILABLE_COMMANDS: compact ? "compact" : "",
                  GOAT_ACP_REQUEST_LOG_PATH: requestLog,
                },
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
        const threadId = ThreadId.make("thread-antigravity-compaction");
        const modelSelection = { instanceId, model: "gemini-test-low" } as const;
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const opening = yield* adapter
          .openSession({
            threadId,
            providerSessionId: ProviderSessionId.make("provider-session-antigravity-compaction"),
            modelSelection,
            runtimePolicy,
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(startupMilestone);
        yield* Deferred.succeed(consumeStartupCommands, undefined);
        const session = yield* Fiber.join(opening);
        assert.deepEqual(yield* Ref.get(workspaceCommands), {
          names: compact ? ["compact"] : ["plan", "logout"],
          cwd: process.cwd(),
        });
        const compactThread = session.compactThread;
        assert.isDefined(compactThread);
        assert.equal(session.providerSession.capabilities.turns.supportsNativeGoals, nativeGoals);
        assert.equal((yield* adapter.getCapabilities()).turns.supportsNativeGoals, nativeGoals);
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const turnInput = makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          modelSelection,
          runtimePolicy,
          now: yield* DateTime.now,
          messageText: "Compact the conversation.",
        });
        if (compact) {
          yield* compactThread!(turnInput);
          const events = yield* session.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
          );
          assert.isTrue(
            events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "compaction" &&
                event.turnItem.status === "completed",
            ),
          );
        } else {
          const error = yield* compactThread!(turnInput).pipe(Effect.flip);
          assert.instanceOf(error, ProviderAdapter.ProviderAdapterTurnStartError);
          assert.instanceOf(error.cause, ProviderAdapter.ProviderCompactionUnsupportedError);
        }
        const prompts = (yield* fileSystem.readFileString(requestLog))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { method?: string; params?: { prompt?: unknown } })
          .filter((request) => request.method === "session/prompt")
          .map((request) => request.params?.prompt);
        assert.deepEqual(prompts, compact ? [[{ type: "text", text: "/compact" }]] : []);
      }).pipe(Effect.provide(layerSession)),
  );
});
