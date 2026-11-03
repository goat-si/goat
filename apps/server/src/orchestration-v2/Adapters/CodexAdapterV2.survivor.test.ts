import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CodexSettings,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import * as CodexSurvivors from "../../provider/CodexSurvivors.ts";
import { CodexDetachedAppServerError } from "../../provider/CodexDetachedAppServer.ts";
import { makeLocalCommandHarness } from "../ProviderTurnStartService.localCommand.testkit.ts";
import * as CodexAdapter from "./CodexAdapterV2.ts";
import {
  codexReplayPreamble,
  makeCodexReplayTranscript,
  makeCodexReplayTurn,
} from "./CodexReplay.testkit.ts";
import {
  CODEX_TEST_MODEL_SELECTION,
  CODEX_TEST_RUNTIME_POLICY,
  makeCodexTestTurnInput,
  makeReplayServerConfig,
} from "./CodexAdapterV2.testkit.ts";

const layerTest = Layer.mergeAll(
  MemoryDerivedCache.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeServices.layer,
);
const decodeCodexSettings = Schema.decodeEffect(CodexSettings);

const runScenario = (
  mode:
    | "running"
    | "finished"
    | "unreadable"
    | "stop-interrupted"
    | "stop-completed"
    | "stop-fence"
    | "guard"
    | "guard-shared"
    | "guard-child"
    | "guard-unscoped"
    | "conflict"
    | "conflict-fence"
    | "goal"
    | "goal-newer"
    | "goal-release"
    | "goal-cleared"
    | "goal-burst"
    | "startup-goal-burst"
    | "startup-goal-timeout"
    | "startup-goal-release"
    | "read-failure"
    | "read-defect"
    | "read-failure-loss"
    | "read-fence-failure"
    | "loss-verified"
    | "loss-unknown"
    | "loss-pending"
    | "loss-read-fails"
    | "loss-mismatch"
    | "loss-live"
    | "loss-error",
) =>
  Effect.gen(function* () {
    const scenario = `survivor-${mode}`;
    const threadId = ThreadId.make(`thread-${scenario}`);
    const sourceRunId = RunId.make("source-run");
    const binding = {
      instanceId: CodexAdapter.CODEX_DEFAULT_INSTANCE_ID,
      recordName: "instance",
      threadId,
      sourceRunId,
      nativeThreadId: "native-thread",
      nativeTurnId: "native-turn",
    };
    const transcript = makeCodexReplayTranscript({
      scenario,
      entries: codexReplayPreamble({
        nativeThreadId: binding.nativeThreadId,
        nativeTurnId: binding.nativeTurnId,
        prompt: "unused",
      }).slice(0, 3),
    });
    const driver = yield* CodexReplay.makeReplayDriver(transcript);
    const requests: string[] = [];
    const notifications = new Map<string, Array<(payload: unknown) => Effect.Effect<void>>>();
    const stopMode = mode.startsWith("stop-");
    const guardMode = mode.startsWith("guard");
    const conflictMode = mode.startsWith("conflict");
    const goalMode = mode.startsWith("goal");
    const lossMode = mode.startsWith("loss-");
    const readFailure = mode.startsWith("read-");
    let fenceWritesFail = mode === "read-fence-failure";
    let goalBlocked = mode.startsWith("startup-goal-");
    let goalStatus: "active" | "paused" | "none" = "active";
    let goalReads = 0;
    let notifyGoalRead = false;
    let stallGoalRead = false;
    let readStalledOnce = false;
    const releaseGoalRead = yield* Deferred.make<void>();
    const stalledGoalRead = yield* Deferred.make<void>();
    const followupGoalRead = yield* Deferred.make<void>();
    const fencedGoalRead = yield* Deferred.make<void>();
    const goalCleared = yield* Deferred.make<void>();
    const lost = yield* Deferred.make<CodexErrors.CodexAppServerError>();
    const verifiedDeath =
      mode === "loss-verified" ||
      mode === "loss-pending" ||
      mode === "loss-read-fails" ||
      mode === "loss-mismatch" ||
      mode === "read-failure-loss";
    let fence = verifiedDeath && !readFailure;
    const pendingRead = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    let guard:
      | Parameters<CodexClient.CodexAppServerClient["Service"]["setRequestGuard"]>[0]
      | undefined;
    const order: string[] = [];
    const cleared = yield* Deferred.make<void>();
    const terminalObserved = yield* Deferred.make<void>();
    let status: "inProgress" | "completed" | "interrupted" =
      mode === "running" ||
      stopMode ||
      guardMode ||
      conflictMode ||
      goalMode ||
      lossMode ||
      readFailure
        ? "inProgress"
        : "completed";
    const readStarted = yield* Deferred.make<void>();
    const service = CodexSurvivors.CodexSurvivors.of({
      list: Effect.succeed(mode.startsWith("startup-goal-") ? [] : [binding]),
      startBlockedThreads: Effect.succeed([]),
      setStartWake: () => Effect.void,
      release: () => Effect.void,
      classifyRecord: () =>
        mode === "loss-error"
          ? Effect.fail(new CodexDetachedAppServerError({ detail: "inspection failed" }))
          : mode === "loss-live"
            ? Effect.succeed({ type: "verified", pgid: 12, members: [] })
            : Effect.succeed({
                type:
                  mode === "loss-mismatch" ? "mismatch" : verifiedDeath ? "gone" : "unverifiable",
              }),
      classifyExisting: () => Effect.succeed("survivor" as const),
      replace: () => Effect.void,
      get: () => Effect.succeed(binding),
      getGoalBlocks: () =>
        Effect.sync(() => (goalBlocked ? [{ record: binding, block: binding }] : [])),
      listGoalBlocksByInstance: () =>
        Effect.sync(() => (goalBlocked ? [{ record: binding, block: binding }] : [])),
      getStopObligations: () =>
        Effect.gen(function* () {
          if (fence) yield* Deferred.succeed(fencedGoalRead, undefined);
          return fence ? [{ record: binding, block: binding }] : [];
        }),
      recordStopObligation: (_record, obligation) =>
        Effect.sync(() => {
          assert.equal(
            obligation.nativeTurnId,
            conflictMode || (mode === "goal-newer" && order.includes("interrupt"))
              ? "other-turn"
              : mode === "guard-child"
                ? "child-turn"
                : binding.nativeTurnId,
          );
          assert.equal(
            obligation.nativeThreadId,
            mode === "guard-child" ? "child-thread" : binding.nativeThreadId,
          );
          order.push("record");
          fence = true;
        }).pipe(
          Effect.andThen(
            mode === "stop-fence" || mode === "conflict-fence" || fenceWritesFail
              ? Effect.fail(new CodexDetachedAppServerError({ detail: "disk" }))
              : Effect.void,
          ),
        ),
      clearStopObligation: (_record, obligation) =>
        obligation.nativeTurnId === "other-turn"
          ? Effect.sync(() => {
              order.push("clear-conflict");
            })
          : Deferred.await(terminalObserved).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  order.push("clear");
                  fence = false;
                }),
              ),
              Effect.andThen(Deferred.succeed(cleared, undefined)),
              Effect.asVoid,
            ),
      recordGoalBlock: () =>
        Effect.sync(() => {
          order.push("goal");
          goalBlocked = true;
        }),
      clearGoalBlock: () =>
        Effect.sync(() => {
          goalBlocked = false;
        }).pipe(Effect.andThen(Deferred.succeed(goalCleared, undefined)), Effect.asVoid),
      hasGoalBlock: () => Effect.sync(() => goalBlocked),
      ensureAdmission: () =>
        fence || goalBlocked
          ? Effect.fail(
              new CodexDetachedAppServerError({
                detail: "Codex is running work on this thread from before the restart.",
              }),
            )
          : Effect.void,
    });
    const adapter = yield* CodexAdapter.makeCodexAdapterV2({
      instanceId: binding.instanceId,
      settings: yield* decodeCodexSettings({}),
      environment: {},
      clientFactory: {
        open: (input) =>
          Layer.build(CodexReplay.layerReplayWithDriver(driver)).pipe(
            Effect.map((context) => Context.get(context, CodexClient.CodexAppServerClient)),
            Effect.map((client): CodexClient.CodexAppServerClient["Service"] => ({
              ...client,
              terminated:
                lossMode || mode === "read-failure-loss" ? Deferred.await(lost) : client.terminated,
              setRequestGuard: (value) =>
                Effect.sync(() => {
                  guard = value;
                }).pipe(Effect.andThen(client.setRequestGuard(value))),
              handleServerNotification: (method, handler) =>
                Effect.sync(() => {
                  const handlers = notifications.get(method) ?? [];
                  handlers.push(handler as (payload: unknown) => Effect.Effect<void>);
                  notifications.set(method, handlers);
                }).pipe(Effect.andThen(client.handleServerNotification(method, handler))),
              raw: {
                ...client.raw,
                request: (method, params) =>
                  method === "thread/resume"
                    ? Effect.gen(function* () {
                        requests.push(`resume:${(params as { threadId: string }).threadId}`);
                        assert.isDefined(guard, "request guard must be installed before resume");
                        if (guardMode) {
                          if (guard !== undefined) {
                            const denial = yield* guard("item/commandExecution/requestApproval", {
                              ...(mode === "guard-unscoped"
                                ? {}
                                : {
                                    threadId:
                                      mode === "guard-child"
                                        ? "child-thread"
                                        : binding.nativeThreadId,
                                    turnId:
                                      mode === "guard-child" ? "child-turn" : binding.nativeTurnId,
                                  }),
                              itemId: "replay",
                            }).pipe(Effect.exit);
                            assert.isTrue(Exit.isFailure(denial));
                          }
                        }
                        return {
                          thread: {
                            id: binding.nativeThreadId,
                            updatedAt: 1,
                            status: { type: "active" },
                          },
                        };
                      })
                    : client.raw.request(method, params),
              },
              request: ((method: string, params: unknown) =>
                Effect.gen(function* () {
                  requests.push(method);
                  if (method === "turn/interrupt") {
                    assert.deepEqual(
                      order,
                      goalMode
                        ? mode === "goal-newer" && order.includes("interrupt")
                          ? ["goal", "record", "interrupt", "record"]
                          : ["goal", "record"]
                        : ["record"],
                    );
                    assert.deepEqual(params, {
                      threadId: mode === "guard-child" ? "child-thread" : binding.nativeThreadId,
                      turnId:
                        conflictMode || (mode === "goal-newer" && order.includes("interrupt"))
                          ? "other-turn"
                          : mode === "guard-child"
                            ? "child-turn"
                            : binding.nativeTurnId,
                    });
                    order.push("interrupt");
                    yield* Deferred.succeed(interrupted, undefined);
                    if (
                      conflictMode ||
                      (mode === "goal-newer" &&
                        order.filter((value) => value === "interrupt").length === 2)
                    ) {
                      for (const handler of notifications.get("turn/completed") ?? []) {
                        yield* handler({
                          threadId: binding.nativeThreadId,
                          turn: makeCodexReplayTurn({ id: "other-turn", status: "interrupted" }),
                        });
                      }
                      return {};
                    }
                    status = mode === "stop-interrupted" || goalMode ? "interrupted" : "completed";
                    for (const handler of notifications.get("turn/completed") ?? []) {
                      yield* handler({
                        threadId: binding.nativeThreadId,
                        turn: makeCodexReplayTurn({ id: binding.nativeTurnId, status }),
                      });
                    }
                    return {};
                  }
                  if (method === "thread/read" && mode === "guard-child")
                    return { thread: { parentThreadId: binding.nativeThreadId } };
                  if (method === "thread/goal/get") {
                    goalReads++;
                    if (stallGoalRead) {
                      stallGoalRead = false;
                      readStalledOnce = true;
                      yield* Deferred.succeed(stalledGoalRead, undefined);
                      yield* Deferred.await(releaseGoalRead);
                    } else if (
                      (mode !== "goal-release" || notifyGoalRead) &&
                      ((!mode.endsWith("goal-burst") && mode !== "startup-goal-timeout") ||
                        readStalledOnce)
                    )
                      yield* Deferred.succeed(followupGoalRead, undefined);
                    return { goal: goalStatus === "none" ? null : { status: goalStatus } };
                  }
                  if ((readFailure || mode === "startup-goal-release") && method === "turn/start") {
                    return {
                      turn: makeCodexReplayTurn({ id: "retry-turn", status: "inProgress" }),
                    };
                  }
                  if (method === "thread/turns/list") {
                    yield* Deferred.succeed(readStarted, undefined);
                    if (mode === "read-defect")
                      return yield* Effect.die(new Error("history defect"));
                    if (readFailure)
                      return yield* CodexErrors.CodexAppServerRequestError.internalError(
                        "history unavailable",
                      );
                    if (mode === "loss-pending") yield* Deferred.await(pendingRead);
                    if (mode === "loss-read-fails")
                      return yield* new CodexErrors.CodexAppServerInputStreamEndedError({});
                    return {
                      data: [makeCodexReplayTurn({ id: binding.nativeTurnId, status })],
                      nextCursor: null,
                    };
                  }
                  if (method === "thread/items/list") {
                    if (mode === "unreadable")
                      return yield* CodexErrors.CodexAppServerRequestError.internalError(
                        "unreadable",
                      );
                    return {
                      data: [
                        {
                          turnId: binding.nativeTurnId,
                          completedAtMs: 1782622442000,
                          item: {
                            type: "agentMessage",
                            id: "answer",
                            text: "survivor",
                            phase: "final_answer",
                          },
                        },
                      ],
                      nextCursor: null,
                    };
                  }
                  return yield* client.request(method as never, params as never);
                })) as typeof client.request,
            })),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterOpenSessionError({
                  driver: CodexAdapter.CODEX_DRIVER_KIND,
                  providerSessionId: input.providerSessionId,
                  cause,
                }),
            ),
          ),
      },
      crypto: yield* Crypto.Crypto,
      fileSystem: yield* FileSystem.FileSystem,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig: yield* makeReplayServerConfig(scenario).pipe(Effect.orDie),
    }).pipe(Effect.provideService(CodexSurvivors.CodexSurvivors, service));
    const runtime = yield* adapter.openSession({
      threadId:
        mode === "guard-shared" || mode === "startup-goal-release"
          ? ThreadId.make("other-thread")
          : threadId,
      providerSessionId: ProviderSessionId.make("session"),
      modelSelection: CODEX_TEST_MODEL_SELECTION,
      runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
    });
    if (mode === "startup-goal-burst" || mode === "startup-goal-timeout") {
      const baseline = goalReads;
      stallGoalRead = true;
      const count = mode === "startup-goal-burst" ? 101 : 1;
      for (let i = 0; i < count; i++)
        for (const handler of notifications.get("thread/goal/updated") ?? [])
          yield* handler({
            threadId: binding.nativeThreadId,
            goal: { status: "active", objective: "test", tokensUsed: 0, timeUsedSeconds: 0 },
          });
      yield* Deferred.await(stalledGoalRead);
      assert.equal(goalReads, baseline + 1);
      if (mode === "startup-goal-timeout") {
        yield* TestClock.adjust("15 seconds");
        assert.isTrue(goalBlocked);
        assert.equal((yield* Effect.exit(service.ensureAdmission(threadId)))._tag, "Failure");
        goalStatus = "paused";
        for (const handler of notifications.get("thread/goal/cleared") ?? [])
          yield* handler({ threadId: binding.nativeThreadId });
        yield* Deferred.await(goalCleared);
        assert.equal(goalReads, baseline + 2);
        yield* service.ensureAdmission(threadId);
        return;
      }
      yield* Deferred.succeed(releaseGoalRead, undefined);
      yield* Deferred.await(followupGoalRead);
      assert.equal(goalReads, baseline + 2);
      return;
    }
    if (mode === "startup-goal-release") {
      assert.include(requests, `resume:${binding.nativeThreadId}`);
      assert.equal((yield* Effect.exit(service.ensureAdmission(threadId)))._tag, "Failure");
      const makeAdmissionHarness = () =>
        makeLocalCommandHarness({
          text: "Continue",
          ensureCodexAdmission: () => service.ensureAdmission(threadId),
          previousTurn: { runStatus: "completed", turnStatus: "completed" },
        });
      const blocked = makeAdmissionHarness();
      yield* blocked.start;
      assert.equal(blocked.startRootRun.mock.calls.length, 0);
      for (const handler of notifications.get("thread/goal/updated") ?? []) {
        yield* handler({
          threadId: binding.nativeThreadId,
          goal: { status: "active", objective: "work", tokensUsed: 0, timeUsedSeconds: 0 },
        });
      }
      assert.isAbove(goalReads, 0, "the persisted goal block is tracked when the session opens");
      assert.isTrue(goalBlocked);
      goalStatus = "paused";
      fence = true;
      for (const handler of notifications.get("turn/completed") ?? []) {
        yield* handler({
          threadId: binding.nativeThreadId,
          turn: makeCodexReplayTurn({ id: "goal-turn", status: "completed" }),
        });
      }
      assert.isTrue(goalBlocked, "a stop obligation keeps the paused goal blocked");
      fence = false;
      for (const handler of notifications.get("thread/goal/updated") ?? []) {
        yield* handler({
          threadId: binding.nativeThreadId,
          goal: { status: "paused", objective: "work", tokensUsed: 0, timeUsedSeconds: 0 },
        });
      }
      yield* Deferred.await(goalCleared);
      assert.equal((yield* Effect.exit(service.ensureAdmission(threadId)))._tag, "Success");
      const released = makeAdmissionHarness();
      yield* released.start;
      assert.equal(released.startRootRun.mock.calls.length, 1);
    }
    const now = yield* DateTime.now;
    const providerThread = yield* runtime.resumeThread({
      threadId,
      modelSelection: CODEX_TEST_MODEL_SELECTION,
      runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      providerThread: {
        id: ProviderThreadId.make("provider-thread"),
        driver: CodexAdapter.CODEX_DRIVER_KIND,
        providerInstanceId: binding.instanceId,
        providerSessionId: ProviderSessionId.make("old-session"),
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: {
          driver: CodexAdapter.CODEX_DRIVER_KIND,
          nativeId: binding.nativeThreadId,
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "active",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
    });
    if (guardMode) {
      if (mode === "guard-unscoped") {
        assert.deepEqual(order, []);
        assert.notInclude(requests, "turn/interrupt");
        return;
      }
      yield* Deferred.await(interrupted);
      assert.deepEqual(order, ["record", "interrupt"]);
      assert.notInclude(requests, "turn/start");
      return;
    }
    const turnInput = {
      ...makeCodexTestTurnInput({
        threadId,
        providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("attempt"),
        text: "continue",
      }),
      restartContinuationOfRunId: sourceRunId,
    };
    if (mode === "startup-goal-release") {
      const { restartContinuationOfRunId: _source, ...newTurn } = turnInput;
      yield* service.ensureAdmission(threadId);
      yield* runtime.startTurn(newTurn);
      assert.equal(requests.filter((request) => request === "turn/start").length, 1);
      return;
    }
    const start = yield* runtime.startTurn(turnInput).pipe(Effect.exit);
    assert.equal(start._tag, "Success");
    yield* Deferred.await(readStarted);
    const stopEvents =
      (stopMode && mode !== "stop-fence") || goalMode || lossMode || readFailure
        ? yield* runtime.events.pipe(
            Stream.tap((event) =>
              event.type === "turn.terminal"
                ? Deferred.succeed(terminalObserved, undefined)
                : Effect.void,
            ),
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
            Effect.forkScoped,
          )
        : undefined;
    if (lossMode)
      yield* Deferred.succeed(lost, new CodexErrors.CodexAppServerInputStreamEndedError({}));
    if (stopMode) {
      const allocator = yield* IdAllocator.IdAllocatorV2;
      const providerTurnId = allocator.derive.providerTurn({
        driver: CodexAdapter.CODEX_DRIVER_KIND,
        nativeTurnId: `${binding.nativeTurnId}:restart:${turnInput.runId}`,
      });
      if (mode === "stop-fence") {
        const error = yield* runtime
          .interruptTurn({ providerThread, providerTurnId })
          .pipe(Effect.flip);
        assert.equal(
          error.message,
          "GOAT could not record the stop of the Codex turn from before the restart",
        );
        assert.deepEqual(order, ["record"]);
        assert.notInclude(requests, "turn/interrupt");
        return;
      }
      yield* runtime.interruptTurn({ providerThread, providerTurnId });
    }
    if (conflictMode) {
      for (const handler of notifications.get("turn/started") ?? []) {
        yield* handler({
          threadId: binding.nativeThreadId,
          turn: makeCodexReplayTurn({ id: "other-turn", status: "inProgress" }),
        });
      }
      status = "completed";
      for (const handler of notifications.get("turn/completed") ?? []) {
        yield* handler({
          threadId: binding.nativeThreadId,
          turn: makeCodexReplayTurn({ id: binding.nativeTurnId, status }),
        });
      }
    }
    if (goalMode) {
      for (const handler of notifications.get("thread/goal/updated") ?? []) {
        yield* handler({
          threadId: binding.nativeThreadId,
          goal: { status: "active" },
          ...(mode === "goal-newer" ? { turnId: "other-turn" } : {}),
        });
      }
      status = "interrupted";
      for (const handler of notifications.get("turn/completed") ?? []) {
        yield* handler({
          threadId: binding.nativeThreadId,
          turn: makeCodexReplayTurn({ id: binding.nativeTurnId, status }),
        });
      }
    }
    if (mode === "running") {
      status = "completed";
      for (const handler of notifications.get("item/completed") ?? []) {
        yield* handler({
          threadId: binding.nativeThreadId,
          turnId: binding.nativeTurnId,
          completedAtMs: 1782622442000,
          item: { type: "agentMessage", id: "answer", text: "survivor", phase: "final_answer" },
        });
      }
      for (const handler of notifications.get("turn/completed") ?? []) {
        yield* handler({
          threadId: binding.nativeThreadId,
          turn: makeCodexReplayTurn({ id: binding.nativeTurnId, status: "completed" }),
        });
      }
    }
    const events =
      stopEvents === undefined
        ? yield* runtime.events.pipe(
            Stream.takeUntil((e) => e.type === "turn.terminal"),
            Stream.runCollect,
          )
        : yield* Fiber.join(stopEvents);
    assert.notInclude(requests, "turn/start");
    if (lossMode) {
      const terminal = events.find((event) => event.type === "turn.terminal");
      assert.equal(terminal?.status, "failed");
      if (terminal?.status === "failed")
        assert.equal(
          terminal.failure.message,
          verifiedDeath
            ? "The Codex process stopped while the turn that ran across the restart was still running."
            : "GOAT could not confirm the Codex process from before the restart stopped.",
        );
      const turns = events.filter((event) => event.type === "provider_turn.updated");
      assert.equal(turns.at(-1)?.providerTurn.status, "failed");
      assert.isUndefined(turns.at(-1)?.providerTurn.survivingRestart);
      if (verifiedDeath) {
        yield* Deferred.await(cleared);
        assert.isFalse(fence);
      } else {
        assert.isTrue(fence);
        assert.equal((yield* service.ensureAdmission(threadId).pipe(Effect.exit))._tag, "Failure");
      }
      return;
    }
    if (readFailure) {
      const terminal = events.find((event) => event.type === "turn.terminal");
      assert.equal(terminal?.status, "failed");
      if (terminal?.status === "failed")
        assert.equal(
          terminal.failure.message,
          mode === "read-fence-failure"
            ? "GOAT could not record the stop of the Codex turn from before the restart"
            : "Could not read the result of the turn that ran across the restart",
        );
      assert.isTrue(fence, "admission must be blocked before the failure is emitted");
      assert.equal((yield* service.ensureAdmission(threadId).pipe(Effect.exit))._tag, "Failure");
      fenceWritesFail = false;
      if (mode === "read-failure-loss") {
        yield* Deferred.succeed(lost, new CodexErrors.CodexAppServerInputStreamEndedError({}));
      } else {
        for (const handler of notifications.get("turn/completed") ?? [])
          yield* handler({
            threadId: binding.nativeThreadId,
            turn: makeCodexReplayTurn({ id: binding.nativeTurnId, status: "completed" }),
          });
      }
      yield* Deferred.await(cleared);
      assert.isFalse(fence);
      yield* service.ensureAdmission(threadId);
      assert.notInclude(requests, "turn/start");
      if (mode !== "read-failure-loss") {
        const { restartContinuationOfRunId: _source, ...retryInput } = turnInput;
        yield* runtime.startTurn({
          ...retryInput,
          runId: RunId.make("retry-run"),
          attemptId: RunAttemptId.make("retry-attempt"),
        });
        assert.equal(requests.filter((request) => request === "turn/start").length, 1);
      }
      return;
    }
    if (stopMode) {
      yield* Deferred.await(cleared);
      assert.deepEqual(order, ["record", "interrupt", "clear"]);
    }
    if (conflictMode) {
      assert.deepEqual(
        order,
        mode === "conflict-fence" ? ["record"] : ["record", "interrupt", "clear-conflict"],
      );
      if (mode === "conflict-fence") {
        assert.notInclude(requests, "turn/interrupt");
        const terminal = events.find((e) => e.type === "turn.terminal");
        assert.equal(terminal?.status, "failed");
        if (terminal?.status === "failed")
          assert.equal(
            terminal.failure.message,
            "GOAT could not record the stop of the Codex turn from before the restart",
          );
        return;
      }
    }
    if (goalMode) {
      const terminal = events.find((e) => e.type === "turn.terminal");
      assert.equal(terminal?.status, "failed");
      yield* Deferred.await(cleared);
      assert.deepEqual(
        order,
        mode === "goal-newer"
          ? ["goal", "record", "interrupt", "record", "interrupt", "clear-conflict", "clear"]
          : ["goal", "record", "interrupt", "clear"],
      );
      if (terminal?.status === "failed")
        assert.equal(
          terminal.failure.message,
          "Codex started a goal on this thread while GOAT was waiting; the turn that ran across the restart was stopped.",
        );
      if (mode === "goal-release" || mode === "goal-cleared" || mode === "goal-burst") {
        const goal = {
          threadId: binding.nativeThreadId,
          objective: "test",
          status: "active",
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 1,
        };
        assert.isTrue(goalBlocked);
        if (mode === "goal-cleared") {
          goalStatus = "none";
          const before = goalReads;
          for (const handler of notifications.get("thread/goal/cleared") ?? [])
            yield* handler({ threadId: binding.nativeThreadId });
          yield* Deferred.await(goalCleared);
          assert.isAbove(goalReads, before);
          yield* service.ensureAdmission(threadId);
          return;
        }
        if (mode === "goal-burst") {
          stallGoalRead = true;
          const before = goalReads;
          for (const handler of notifications.get("thread/goal/updated") ?? [])
            yield* handler({ threadId: binding.nativeThreadId, goal });
          yield* Deferred.await(stalledGoalRead);
          for (let i = 0; i < 100; i++)
            for (const handler of notifications.get("thread/goal/updated") ?? [])
              yield* handler({ threadId: binding.nativeThreadId, goal });
          assert.equal(goalReads, before + 1);
          yield* Deferred.succeed(releaseGoalRead, undefined);
          yield* Deferred.await(followupGoalRead);
          assert.equal(goalReads, before + 2);
          return;
        }
        const readsBeforeUpdate = goalReads;
        notifyGoalRead = true;
        for (const handler of notifications.get("thread/goal/updated") ?? [])
          yield* handler({ threadId: binding.nativeThreadId, goal });
        yield* Deferred.await(followupGoalRead);
        assert.isAbove(
          goalReads,
          readsBeforeUpdate,
          "goal state must be re-read while the session is live",
        );
        assert.isTrue(goalBlocked);
        goalStatus = "paused";
        fence = true;
        for (const handler of notifications.get("thread/goal/updated") ?? [])
          yield* handler({ threadId: binding.nativeThreadId, goal: { ...goal, status: "paused" } });
        yield* Deferred.await(fencedGoalRead);
        assert.isTrue(goalBlocked, "an outstanding stop obligation keeps the goal block");
        fence = false;
        for (const handler of notifications.get("turn/completed") ?? [])
          yield* handler({
            threadId: binding.nativeThreadId,
            turn: makeCodexReplayTurn({ id: binding.nativeTurnId, status: "completed" }),
          });
        yield* Deferred.await(goalCleared);
        assert.isFalse(goalBlocked);
        yield* service.ensureAdmission(threadId);
      }
    }
    const turns = events.filter((e) => e.type === "provider_turn.updated");
    assert.equal(turns[0]?.providerTurn.status, "running");
    assert.equal(turns[0]?.providerTurn.survivingRestart?.nativeStartedAt, null);
    const last = turns.at(-1)?.providerTurn;
    assert.equal(
      last?.status,
      mode === "unreadable"
        ? "failed"
        : mode === "stop-interrupted" || goalMode
          ? "interrupted"
          : "completed",
    );
    assert.isUndefined(last?.survivingRestart);
    const items = events.filter(
      (e) => e.type === "turn_item.updated" && e.turnItem.nativeItemRef?.nativeId === "answer",
    );
    assert.equal(items.length, mode === "unreadable" ? 0 : 1);
    const terminal = events.find((e) => e.type === "turn.terminal");
    if (mode === "unreadable") {
      assert.equal(terminal?.status, "failed");
      if (terminal?.status === "failed")
        assert.equal(
          terminal.failure.message,
          "Could not read the result of the turn that ran across the restart",
        );
    }
  }).pipe(Effect.scoped, Effect.provide(layerTest));

it.effect("running survivor shows waiting then imports exactly once without turn/start", () =>
  runScenario("running"),
);
it.effect("a turn that finished while GOAT was down settles at once", () =>
  runScenario("finished"),
);
it.effect("unreadable T fails visibly with zero starts", () => runScenario("unreadable"));

it.effect("Stop interrupts the surviving native turn and reports native evidence", () =>
  runScenario("stop-interrupted"),
);
it.effect("Stop that races completion reports completed", () => runScenario("stop-completed"));
it.effect("a failed fence write sends no interrupt", () => runScenario("stop-fence"));

it.effect("replay is guarded before resume", () => runScenario("guard"));
it.effect("replay is guarded when another thread opens the shared session first", () =>
  runScenario("guard-shared"),
);

it.effect("a conflicting turn is fenced and interrupted while the survivor keeps waiting", () =>
  runScenario("conflict"),
);
it.effect("a conflict fence failure fails the survivor without interrupting", () =>
  runScenario("conflict-fence"),
);
it.effect("an active goal is blocked and the survivor fails after native interruption", () =>
  runScenario("goal"),
);

it.effect("a descendant request is rejected and its native turn fenced", () =>
  runScenario("guard-child"),
);
it.effect("an unscoped request is rejected while a survivor waits", () =>
  runScenario("guard-unscoped"),
);

it.effect("a goal also fences the newer native turn", () => runScenario("goal-newer"));

it.effect("verified process loss fails the survivor without a new turn", () =>
  runScenario("loss-verified"),
);
it.effect("unverifiable process loss fails the survivor and blocks admission", () =>
  runScenario("loss-unknown"),
);

it.effect("verified process loss during a history read settles the survivor", () =>
  runScenario("loss-pending"),
);
it.effect("classification failure leaves survivor admission blocked", () =>
  runScenario("loss-error"),
);

it.effect("terminal transport failure during history waits for session-loss classification", () =>
  runScenario("loss-read-fails"),
);

it.effect("a record mismatch clears the survivor stop fence", () => runScenario("loss-mismatch"));
it.effect("a cleared goal releases the block after the survivor ends", () =>
  runScenario("goal-cleared"),
);
it.effect("survivor goal maintenance coalesces a burst while the read stalls", () =>
  runScenario("goal-burst"),
);
it.effect("startup goal maintenance coalesces a burst while the read stalls", () =>
  runScenario("startup-goal-burst"),
);
it.effect("a timed out goal read keeps admission blocked until a later notification", () =>
  runScenario("startup-goal-timeout"),
);
it.effect("a startup goal block is released in a shared session when the goal pauses", () =>
  runScenario("startup-goal-release"),
);
it.effect("a still-verified process leaves survivor admission blocked", () =>
  runScenario("loss-live"),
);
it.effect("live goal block stays active and releases when the goal pauses", () =>
  runScenario("goal-release"),
);
it.effect("a failed survivor history read fences the turn until native completion", () =>
  runScenario("read-failure"),
);
it.effect("a failed survivor fence write remains blocked and surfaces its error", () =>
  runScenario("read-fence-failure"),
);
it.effect("verified session loss clears a retained history-read fence", () =>
  runScenario("read-failure-loss"),
);

it.effect("a history-reader defect retains the survivor admission fence", () =>
  runScenario("read-defect"),
);
