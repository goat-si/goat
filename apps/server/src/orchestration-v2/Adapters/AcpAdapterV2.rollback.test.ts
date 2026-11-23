// @effect-diagnostics nodeBuiltinImport:off - ACP fixtures use Node HTTP servers and native paths
import { acpMcpAuthorization, makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import { makeMockRuntime, bundledMockAgentPath } from "./AcpMockRuntime.testkit.ts";
import * as NodeHttp from "node:http";
import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointId,
  EnvironmentId,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@goat/contracts";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import {
  AcpProviderCapabilitiesV2,
  acpScopedNativeId,
  makeAcpAdapterV2,
  type AcpAdapterV2ExtensionContext,
  type AcpAdapterV2RuntimeInput,
} from "@goat/provider-acp/server/adapter";
import { layerTest, ACP_TEST_DRIVER } from "./AcpAdapterV2.host.testkit.ts";

describe("AcpAdapterV2 rollback", () => {
  it.effect("replaces the ACP session and clears conversation state on rollback", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* bundledMockAgentPath;
      const instanceId = ProviderInstanceId.make("acp-test-rollback-session");
      const rollbackThreadId = ThreadId.make("thread-acp-rollback-session-target");
      yield* (yield* McpProviderSessions.McpProviderSessions).set({
        environmentId: EnvironmentId.make("environment-acp-rollback-session-target"),
        threadId: rollbackThreadId,
        providerSessionId: "mcp-session-acp-rollback-session-target",
        providerInstanceId: instanceId,
        endpoint: "http://127.0.0.1:43124/mcp",
        authorizationHeader: "Bearer rollback-target-token",
        browserToolsAvailable: false,
      });
      const runtimeInputs: Array<AcpAdapterV2RuntimeInput> = [];
      const nativeRuntimes: Array<AcpSessionRuntime.AcpSessionRuntime["Service"]> = [];
      let sessionEventCount = 0;
      const makeRuntime = makeMockRuntime({
        childProcessSpawner,
        mockAgentPath,
        environment: { GOAT_ACP_PROMPT_DELAY_MS: "100" },
        wrapRuntime: (nativeRuntime) => {
          nativeRuntimes.push(nativeRuntime);
          return nativeRuntime;
        },
      });
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          onSessionEvent: () =>
            Effect.sync(() => {
              sessionEventCount++;
            }),
          makeRuntime: (runtimeInput) =>
            Effect.sync(() => runtimeInputs.push(runtimeInput)).pipe(
              Effect.andThen(makeRuntime(runtimeInput)),
            ),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-rollback-session");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-rollback-session"),
        modelSelection,
        runtimePolicy,
      });
      assert.isTrue(runtime.providerSession.capabilities.threads.canRollbackThread);
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const firstSessionId = providerThread.nativeThreadRef?.nativeId;
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        }),
      );
      const activeRollback = yield* runtime
        .rollbackThread({
          providerThread,
          providerThreadTurns: [],
          target: {
            type: "thread_start",
            checkpointId: CheckpointId.make("checkpoint-acp-active-rollback"),
            appRunOrdinal: 0,
          },
        })
        .pipe(Effect.result);
      assert.equal(activeRollback._tag, "Failure");
      if (activeRollback._tag === "Failure") {
        assert.include(String(activeRollback.failure.cause), "while turn");
      }
      const firstProviderTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: acpScopedNativeId(instanceId, `${firstSessionId}:turn:1`),
      });
      while (true) {
        const event = yield* Queue.take(events);
        if (event.type === "turn.terminal" && event.providerTurnId === firstProviderTurnId) break;
      }
      const rolledBack = yield* runtime.rollbackThread({
        providerThread: { ...providerThread, appThreadId: rollbackThreadId },
        providerThreadTurns: [],
        target: {
          type: "thread_start",
          checkpointId: CheckpointId.make("checkpoint-acp-rollback-session"),
          appRunOrdinal: 0,
        },
      });
      assert.isString(rolledBack.providerThread.nativeThreadRef?.nativeId);
      assert.equal(
        runtimeInputs[1]?.processEnvironment?.GOAT_ACP_MCP_AUTHORIZATION,
        "Bearer rollback-target-token",
      );
      assert.equal(acpMcpAuthorization(runtimeInputs[1]), "Bearer rollback-target-token");
      const snapshotAfterRollback = yield* runtime.readThreadSnapshot({
        providerThread: rolledBack.providerThread,
      });
      assert.deepEqual(snapshotAfterRollback.messages, []);
      const sessionEventsBeforeSecondTurn = sessionEventCount;
      yield* runtime.startTurn(
        makeTurnInput({
          threadId: rollbackThreadId,
          providerThread: rolledBack.providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
          ordinal: 2,
        }),
      );
      const secondProviderTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: acpScopedNativeId(
          instanceId,
          `${rolledBack.providerThread.nativeThreadRef?.nativeId}:turn:2`,
        ),
      });
      let secondStatus: string | null = null;
      while (secondStatus === null) {
        const event = yield* Queue.take(events);
        if (event.type === "turn.terminal" && event.providerTurnId === secondProviderTurnId) {
          secondStatus = event.status;
        }
      }
      assert.equal(secondStatus, "completed");
      yield* nativeRuntimes[1]!.drainEvents;
      assert.isAbove(sessionEventCount, sessionEventsBeforeSecondTurn);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live.each([
    "rollback removal",
    "rollback rotation",
    "failed rollback",
    "fork removal",
    "snapshot removal",
  ] as const)("keeps the ACP MCP bridge current through %s", (transition) =>
    Effect.gen(function* () {
      const requests: Array<{ path: string; authorization: string }> = [];
      const server = yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<NodeHttp.Server>((resolve) => {
              const fixture = NodeHttp.createServer(async (request, response) => {
                const chunks: Buffer[] = [];
                for await (const chunk of request) chunks.push(Buffer.from(chunk));
                const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
                requests.push({
                  path: request.url ?? "",
                  authorization: request.headers.authorization ?? "",
                });
                response.setHeader("content-type", "application/json");
                response.end(
                  JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [] } }),
                );
              });
              fixture.listen(0, "127.0.0.1", () => resolve(fixture));
            }),
        ),
        (fixture) =>
          Effect.promise(
            () =>
              new Promise<void>((resolve, reject) =>
                fixture.close((error) => (error ? reject(error) : resolve())),
              ),
          ),
      );
      const address = server.address();
      if (address === null || typeof address === "string")
        return yield* Effect.die("No fixture port");
      const fixtureId = transition.replaceAll(" ", "-");
      const instanceId = ProviderInstanceId.make(`acp-bridge-${fixtureId}`);
      const threadId = ThreadId.make(`acp-bridge-${fixtureId}`);
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const config = (credential: "A" | "B", targetThreadId = threadId) => ({
        environmentId: EnvironmentId.make("bridge-fixture"),
        threadId: targetThreadId,
        providerSessionId: "bridge-fixture",
        providerInstanceId: instanceId,
        endpoint: `http://127.0.0.1:${address.port}/${credential}`,
        authorizationHeader: `Bearer fixture-${credential}`,
        browserToolsAvailable: false,
        grantedScopes: ["memory:read"] as const,
      });
      const initiallyEmpty = transition === "rollback removal";
      if (!initiallyEmpty) yield* sessions.set(config("A"));
      const mockAgentPath = yield* bundledMockAgentPath;
      type Runtime = AcpSessionRuntime.AcpSessionRuntime["Service"];
      const handlers = new Map<
        number,
        {
          connect?: Parameters<Runtime["handleMcpConnect"]>[0];
          message?: Parameters<Runtime["handleMcpMessage"]>[0];
        }
      >();
      let runtimeOrdinal = 1;
      const prompts: ReadonlyArray<{ type: string; text?: string }>[] = [];
      const makeRuntime = makeMockRuntime({
        childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
        mockAgentPath,
        wrapRuntime: (runtime, ordinal) => {
          const captured: NonNullable<ReturnType<typeof handlers.get>> = {};
          handlers.set(ordinal, captured);
          const observed = Effect.sync(() => {
            runtimeOrdinal = ordinal;
          });
          return {
            ...runtime,
            start:
              transition === "failed rollback" && ordinal > 1
                ? () =>
                    Effect.fail(
                      new EffectAcpErrors.AcpTransportError({
                        detail: "Fixture replacement failure",
                        cause: new Error("Fixture candidate rejected"),
                      }),
                    )
                : () => runtime.start().pipe(Effect.tap(() => observed)),
            loadSession: (...args) => runtime.loadSession(...args).pipe(Effect.tap(() => observed)),
            resumeSession: (...args) =>
              runtime.resumeSession(...args).pipe(Effect.tap(() => observed)),
            forkSession: (...args) => runtime.forkSession(...args).pipe(Effect.tap(() => observed)),
            prompt: (input) =>
              Effect.sync(() => prompts.push(input.prompt)).pipe(
                Effect.andThen(runtime.prompt(input)),
              ),
            handleMcpConnect: (handler) =>
              Effect.sync(() => {
                captured.connect = handler;
              }).pipe(Effect.andThen(runtime.handleMcpConnect(handler))),
            handleMcpMessage: (handler) =>
              Effect.sync(() => {
                captured.message = handler;
              }).pipe(Effect.andThen(runtime.handleMcpMessage(handler))),
          };
        },
      });
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        flavor: { driver: ACP_TEST_DRIVER, capabilities: AcpProviderCapabilitiesV2, makeRuntime },
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make(`bridge-${fixtureId}`),
        modelSelection,
        runtimePolicy,
      });
      let thread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
      let currentThreadId = threadId;
      const callTools = Effect.fnUntraced(function* () {
        const active = handlers.get(runtimeOrdinal)!;
        const connection = yield* active.connect!({ serverId: "goat" }, undefined as never);
        yield* active.message!(
          { connectionId: connection.connectionId, method: "tools/list" },
          undefined as never,
        );
        return connection.connectionId;
      });
      const originalConnection = initiallyEmpty ? undefined : yield* callTools();
      if (transition === "fork removal") {
        currentThreadId = ThreadId.make(`${threadId}-fork`);
        yield* sessions.set(config("B", currentThreadId));
        thread = yield* runtime.forkThread({
          sourceProviderThread: thread,
          targetThreadId: currentThreadId,
        });
      } else {
        yield* sessions.set(config("B"));
        if (transition === "snapshot removal") {
          thread = {
            ...thread,
            nativeThreadRef: {
              driver: ACP_TEST_DRIVER,
              nativeId: "mock-session-snapshot",
              strength: "strong",
            },
          };
          yield* runtime.readThreadSnapshot({ providerThread: thread });
        } else {
          const rolledBack = yield* runtime
            .rollbackThread({
              providerThread: thread,
              providerThreadTurns: [],
              target: {
                type: "thread_start",
                checkpointId: CheckpointId.make("bridge-checkpoint"),
                appRunOrdinal: 0,
              },
            })
            .pipe(Effect.exit);
          if (transition === "failed rollback") {
            assert.isTrue(Exit.isFailure(rolledBack));
          } else {
            if (Exit.isFailure(rolledBack)) return yield* Effect.failCause(rolledBack.cause);
            thread = rolledBack.value.providerThread;
          }
        }
      }
      let previousConnection: string;
      if (transition === "failed rollback") {
        yield* sessions.set(config("A"));
        previousConnection = originalConnection!;
      } else {
        previousConnection = yield* callTools();
        assert.deepEqual(requests.at(-1), { path: "/B", authorization: "Bearer fixture-B" });
        if (transition === "rollback rotation") yield* sessions.set(config("A"));
        else yield* sessions.clear(currentThreadId);
      }
      const beforeAdmission = requests.length;
      yield* runtime.startTurn(
        makeTurnInput({
          threadId: currentThreadId,
          providerThread: thread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        }),
      );
      yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runDrain,
      );
      const active = handlers.get(runtimeOrdinal)!;
      if (transition === "rollback rotation" || transition === "failed rollback") {
        if (transition === "failed rollback") {
          // The original live connection survives both failed candidates.
          yield* active.message!(
            { connectionId: previousConnection, method: "tools/list" },
            undefined as never,
          );
        } else yield* callTools();
        assert.deepEqual(requests.at(-1), { path: "/A", authorization: "Bearer fixture-A" });
        assert.isTrue(
          requests
            .slice(beforeAdmission)
            .every((request) => request.authorization === "Bearer fixture-A"),
        );
      } else {
        for (const denied of [
          active.connect!({ serverId: "goat" }, undefined as never),
          active.message!(
            { connectionId: previousConnection, method: "tools/list" },
            undefined as never,
          ),
        ]) {
          const result = yield* denied.pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(result));
          if (Exit.isFailure(result))
            assert.include(Cause.pretty(result.cause), "GOAT MCP is unavailable");
        }
        assert.equal(requests.length, beforeAdmission, "removed B must receive no HTTP requests");
        // No prompt advertised tools on this native ID; bridge calls are not claims.
        assert.isUndefined(
          prompts.at(-1)?.find((part) => part.text?.startsWith("GOAT memory tools:")),
        );
      }
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("quarantines callbacks from a failed rollback replacement before retrying", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* bundledMockAgentPath;
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      const sessionUpdateHandlers: Array<
        Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined
      > = [];
      const backgroundMutationHandlers: Array<
        AcpAdapterV2ExtensionContext["applyBackgroundTaskMutation"] | undefined
      > = [];
      const availableCommandUpdates: Array<ReadonlyArray<EffectAcpSchema.AvailableCommand>> = [];
      let registeredExtensionOrdinal = 0;
      let runtimeOrdinalSeen = 0;
      const makeRuntime = makeMockRuntime({
        childProcessSpawner,
        mockAgentPath,
        wrapRuntime: (runtime, runtimeOrdinal) => {
          runtimeOrdinalSeen = runtimeOrdinal;
          return {
            ...runtime,
            handleSessionUpdate: (handler) =>
              Effect.sync(() => {
                sessionUpdateHandlers[runtimeOrdinal - 1] = handler;
              }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
            ...(runtimeOrdinal === 2
              ? {
                  start: () =>
                    Effect.fail(
                      new EffectAcpErrors.AcpTransportError({
                        detail: "Forced first rollback replacement failure",
                        cause: "test",
                      }),
                    ),
                }
              : runtimeOrdinal === 3
                ? {
                    start: () =>
                      Effect.suspend(() => {
                        const stagedSessionUpdate = sessionUpdateHandlers[2];
                        if (stagedSessionUpdate === undefined) {
                          return Effect.die("replacement startup must buffer session updates");
                        }
                        return stagedSessionUpdate({
                          sessionId: "mock-session-3",
                          update: {
                            sessionUpdate: "available_commands_update",
                            availableCommands: [
                              {
                                name: "staged-command",
                                description: "published while the replacement starts",
                              },
                            ],
                          },
                        }).pipe(Effect.andThen(runtime.start()));
                      }),
                  }
                : {}),
          };
        },
      });
      const instanceId = ProviderInstanceId.make("acp-test-rollback-retry-generation");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          enablePostSettleContinuation: true,
          onAvailableCommandsUpdate: (commands) =>
            Effect.sync(() => {
              availableCommandUpdates.push(commands);
            }),
          registerExtensions: (context) =>
            Effect.sync(() => {
              backgroundMutationHandlers[registeredExtensionOrdinal] =
                context.applyBackgroundTaskMutation;
              registeredExtensionOrdinal += 1;
            }),
          makeRuntime,
        },
        selfInvocation,
        continuationRequests: { offer: () => Effect.void },
      });
      const threadId = ThreadId.make("thread-acp-rollback-retry-generation");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-rollback-retry-generation"),
        modelSelection,
        runtimePolicy,
      });
      if (runtime.hasPendingBackgroundWork === undefined) {
        return yield* Effect.die("ACP runtime must expose background work state");
      }
      const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });

      yield* runtime.rollbackThread({
        providerThread,
        providerThreadTurns: [],
        target: {
          type: "thread_start",
          checkpointId: CheckpointId.make("checkpoint-acp-rollback-retry-generation"),
          appRunOrdinal: 0,
        },
      });

      assert.equal(runtimeOrdinalSeen, 3);
      assert.deepEqual(
        availableCommandUpdates.map((commands) => commands.map((command) => command.name)),
        [["staged-command"]],
      );
      const failedReplacementHandler = sessionUpdateHandlers[1];
      const failedBackgroundMutationHandler = backgroundMutationHandlers[1];
      assert.isDefined(failedReplacementHandler);
      assert.isDefined(failedBackgroundMutationHandler);
      while (Option.isSome(yield* Queue.poll(events))) {}
      yield* failedReplacementHandler!({
        sessionId: "failed-replacement-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "stale failed replacement callback" },
        },
      });
      assert.isTrue(Option.isNone(yield* Queue.poll(events)));
      yield* failedBackgroundMutationHandler!({
        sessionId: "mock-session-3",
        taskId: "stale-failed-replacement-task",
        status: "running",
      });
      assert.isFalse(yield* hasPendingBackgroundWork);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
