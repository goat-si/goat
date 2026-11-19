import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@goat/contracts";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import type * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";
import { makeAntigravityAcpRuntime } from "../../provider/acp/AntigravityAcpSupport.ts";
import { makeAntigravityAdapterV2 } from "./AntigravityAdapterV2.ts";
const layerSession = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

describe("AntigravityAdapterV2 harness recovery", () => {
  const recoverHarnessFailure = (
    harnessFailure: "1" | "pending" | "after-end-turn",
    firstTurnStatuses: ReadonlyArray<"failed" | "completed">,
  ) => {
    let terminationCount = 0;
    return Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const workspace = yield* fileSystem.makeTempDirectoryScoped();
      const requestLogPath = path.join(workspace, "requests.jsonl");
      let processCount = 0;
      const firstRuntimeTerminated = yield* Deferred.make<void>();
      let firstRuntime: AcpSessionRuntime.AcpSessionRuntime["Service"] | undefined;
      const instanceId = ProviderInstanceId.make("antigravity-recovery-test");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          Effect.suspend(() => {
            processCount += 1;
            const processNumber = processCount;
            return makeAntigravityAcpRuntime({
              ...input,
              onTermination: (error) =>
                (input.onTermination?.(error) ?? Effect.void).pipe(
                  Effect.tap(
                    Effect.sync(() => {
                      terminationCount += 1;
                    }),
                  ),
                  Effect.andThen(
                    processNumber === 1
                      ? Deferred.succeed(firstRuntimeTerminated, undefined)
                      : Effect.void,
                  ),
                ),
              childProcessSpawner,
              spawn: {
                command: process.execPath,
                args: [mockAgentPath],
                cwd: input.cwd,
                env: {
                  GOAT_ACP_ANTIGRAVITY: "1",
                  GOAT_ACP_REQUEST_LOG_PATH: requestLogPath,
                  ...(processNumber === 1
                    ? { GOAT_ACP_ANTIGRAVITY_HARNESS_FAILURE: harnessFailure }
                    : {}),
                },
              },
            }).pipe(
              Effect.provideService(SecureRandom.SecureRandom, crypto),
              Effect.tap((runtime) =>
                Effect.sync(() => {
                  if (processNumber === 1) firstRuntime = runtime;
                }),
              ),
            );
          }),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const threadId = ThreadId.make("thread-antigravity-recovery");
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-recovery"),
        modelSelection,
        runtimePolicy,
      });
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      yield* session.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      const terminal = Stream.fromQueue(events).pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );
      yield* session.startTurn(
        makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, modelSelection, now }),
      );
      const first = yield* terminal;
      assert.equal(first._tag, "Some");
      if (first._tag === "Some") assert.include(firstTurnStatuses, first.value.status);
      if (harnessFailure === "after-end-turn") {
        assert.exists(firstRuntime);
        yield* firstRuntime!.notify("_test/harness-failure", {});
      }
      // The adapter must retire the first process even when end_turn won the race.
      yield* Deferred.await(firstRuntimeTerminated);
      yield* session.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          modelSelection,
          now,
          ordinal: 2,
        }),
      );
      const completed = yield* terminal;
      assert.equal(completed._tag, "Some");
      if (completed._tag === "Some") assert.equal(completed.value.status, "completed");
      assert.equal(processCount, 2);
      assert.equal(terminationCount, 1);
      const requests = (yield* fileSystem.readFileString(requestLogPath))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { method?: string; params?: { sessionId?: string } });
      const resumeRequests = requests.filter((request) => request.method === "session/resume");
      assert.equal(resumeRequests.length, 1);
      assert.equal(resumeRequests[0]?.params?.sessionId, "mock-session-1");
    }).pipe(
      Effect.provide(layerSession),
      Effect.scoped,
      Effect.tap(Effect.sync(() => assert.equal(terminationCount, 1))),
    );
  };

  it.live("fails an open turn and resumes its saved session after a harness failure", () =>
    recoverHarnessFailure("pending", ["failed"]),
  );

  it.live("resumes the saved session after a harness failure races end_turn", () =>
    recoverHarnessFailure("1", ["failed", "completed"]),
  );

  it.live("resumes in a fresh process when the native failure arrives after end_turn", () =>
    recoverHarnessFailure("after-end-turn", ["completed"]),
  );
});
