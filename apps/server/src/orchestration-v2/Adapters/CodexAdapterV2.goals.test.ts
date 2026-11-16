import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import { makeProviderFailure } from "@goat/provider-core/server/failure";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  type OrchestrationV2ProviderThread,
  ProviderInstanceId,
  RunAttemptId,
  ThreadId,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import { assert, describe, it } from "@effect/vitest";

import * as CodexReplay from "effect-codex-app-server/replay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Layer from "effect/Layer";

import { TestClock } from "effect/testing";

import { makeCodexReplayTurn, makeCodexReplayTranscript } from "./CodexReplay.testkit.ts";

import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import {
  CODEX_TEST_MODEL_SELECTION,
  CODEX_TEST_RUNTIME_POLICY,
  makeCodexTestTurnInput,
} from "./CodexAdapterV2.testkit.ts";
import { codexReplayPreamble, makeCodexReplayHarness } from "./CodexAdapterV2.replay.testkit.ts";

const layerAdapterTest = Layer.mergeAll(
  MemoryDerivedCache.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeServices.layer,
);

describe("CodexAdapterV2 post-settle continuation", () => {
  describe("native goals", () => {
    const nativeThreadId = "goal-thread";
    const objective = "Ship the feature";
    const codexGoal = (status: string, tokensUsed: number) => ({
      threadId: nativeThreadId,
      objective,
      status,
      tokenBudget: null,
      tokensUsed,
      timeUsedSeconds: 3,
      createdAt: 1782622440,
      updatedAt: 1782622450,
    });
    const notification = (
      label: string,
      method: string,
      params: unknown,
    ): CodexReplay.CodexAppServerReplayEntry => ({
      type: "emit_inbound",
      label,
      frame: { method, params },
    });
    const request = (id: number, method: string, params: unknown, result: unknown) =>
      [
        { type: "expect_outbound", label: method, frame: { id, method, params } },
        { type: "emit_inbound", label: method, frame: { id, result } },
      ] satisfies Array<CodexReplay.CodexAppServerReplayEntry>;
    const withReplayRequestId = (
      entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>,
      id: number,
    ) =>
      entries.map((entry) =>
        "frame" in entry && Predicate.isObject(entry.frame) && "id" in entry.frame
          ? { ...entry, frame: { ...entry.frame, id } }
          : entry,
      );
    const sessionStart = codexReplayPreamble({
      nativeThreadId,
      nativeTurnId: "unused",
      prompt: "unused",
    }).slice(0, 5);
    const goalTurnInput = (
      harness: {
        readonly threadId: ThreadId;
        readonly providerThread: OrchestrationV2ProviderThread;
      },
      text: string,
    ) =>
      DateTime.now.pipe(
        Effect.map((now) =>
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("goal-attempt"),
            text,
          }),
        ),
      );
    const providerGoals = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
      events.flatMap((event) =>
        event.type === "provider_thread.updated" ? [event.providerThread.goal?.status ?? null] : [],
      );

    it.effect("keeps a /goal run open across the turns Codex continues on its own", () =>
      Effect.gen(function* () {
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-continuation",
          entries: [
            ...sessionStart,
            ...request(3, "thread/goal/get", { threadId: nativeThreadId }, { goal: null }),
            ...request(
              4,
              "thread/goal/set",
              { threadId: nativeThreadId, objective, status: "paused" },
              { goal: codexGoal("paused", 0) },
            ),
            ...withReplayRequestId(
              codexReplayPreamble({
                nativeThreadId,
                nativeTurnId: "goal-turn-1",
                prompt: objective,
                sentPrompt: `This thread's goal is already set. Do not call create_goal. Start working on it now: ${objective}`,
              }).slice(5),
              5,
            ),
            ...request(
              6,
              "thread/goal/set",
              { threadId: nativeThreadId, status: "active" },
              { goal: codexGoal("active", 0) },
            ),
            notification("goal active", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn-1",
              goal: codexGoal("active", 0),
            }),
            notification("first turn done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-1", status: "completed" }),
            }),
            notification("continuation", "turn/started", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-2", status: "inProgress" }),
            }),
            notification("goal complete", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn-2",
              goal: codexGoal("complete", 1200),
            }),
            notification("continuation done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-2", status: "completed" }),
            }),
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(yield* goalTurnInput(harness, `/goal ${objective}`));
        yield* harness.firstTerminal;

        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const providerTurnId = (nativeTurnId: string) =>
          idAllocator.derive.providerTurn({
            driver: CodexAdapterV2.CODEX_DRIVER_KIND,
            nativeTurnId,
          });
        assert.deepEqual(
          harness.terminalEvents().map((event) => [event.providerTurnId, event.status]),
          [[providerTurnId("goal-turn-2"), "completed"]],
        );
        assert.deepEqual(
          harness.events.flatMap((event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "running"
              ? [
                  [
                    event.providerTurn.id,
                    event.providerTurn.runAttemptId,
                    event.providerTurn.ordinal,
                  ],
                ]
              : [],
          ),
          [
            [providerTurnId("goal-turn-1"), RunAttemptId.make("goal-attempt"), 1],
            [providerTurnId("goal-turn-2"), RunAttemptId.make("goal-attempt"), 2],
          ],
        );
        // The goal is set paused until its first turn starts; only the result shows.
        assert.notInclude(providerGoals(harness.events), "paused");
        assert.equal(providerGoals(harness.events).at(-1), "complete");
      }).pipe(Effect.scoped, Effect.provide(layerAdapterTest)),
    );

    it.effect("rejects an oversized /goal objective before any goal request", () =>
      Effect.gen(function* () {
        const oversized = "😀".repeat(4001);
        const requests: string[] = [];
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({ scenario: "goal-oversized", entries: sessionStart }),
          () => Effect.void,
          (method) =>
            Effect.sync(() => {
              requests.push(method);
            }),
        );
        const start = yield* harness.runtime
          .startTurn(yield* goalTurnInput(harness, `/goal ${oversized}`))
          .pipe(Effect.result);

        assert.deepEqual(
          requests.filter((method) => method.startsWith("thread/goal/") || method === "turn/start"),
          [],
        );
        assert.equal(start._tag, "Failure");
        if (start._tag === "Failure") {
          const { message } = makeProviderFailure({ cause: start.failure });
          assert.match(message, /4,?001/u);
          assert.match(message, /4,?000/u);
        }
      }).pipe(Effect.scoped, Effect.provide(layerAdapterTest)),
    );

    it.effect("sends a /goal objective at the 4000 character limit unchanged", () =>
      Effect.gen(function* () {
        const atLimit = "y".repeat(4000);
        const goal = (status: string) => ({ ...codexGoal(status, 0), objective: atLimit });
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-at-limit",
          entries: [
            ...sessionStart,
            ...request(3, "thread/goal/get", { threadId: nativeThreadId }, { goal: null }),
            ...request(
              4,
              "thread/goal/set",
              { threadId: nativeThreadId, objective: atLimit, status: "paused" },
              { goal: goal("paused") },
            ),
            ...withReplayRequestId(
              codexReplayPreamble({
                nativeThreadId,
                nativeTurnId: "goal-turn-limit",
                prompt: atLimit,
                sentPrompt: `This thread's goal is already set. Do not call create_goal. Start working on it now: ${atLimit}`,
              }).slice(5),
              5,
            ),
            ...request(
              6,
              "thread/goal/set",
              { threadId: nativeThreadId, status: "active" },
              { goal: goal("active") },
            ),
            notification("goal complete", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn-limit",
              goal: goal("complete"),
            }),
            notification("turn done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-limit", status: "completed" }),
            }),
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(yield* goalTurnInput(harness, `/goal ${atLimit}`));
        yield* harness.firstTerminal;

        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["completed"],
        );
      }).pipe(Effect.scoped, Effect.provide(layerAdapterTest)),
    );

    it.effect("settles a run held for the next goal turn when Stop arrives in between", () =>
      Effect.gen(function* () {
        const prompt = "Keep going";
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-stop-between-turns",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "goal-turn", prompt }),
            notification("goal active", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn",
              goal: codexGoal("active", 10),
            }),
            notification("turn done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn", status: "completed" }),
            }),
            notification("goal accounted", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: null,
              goal: codexGoal("active", 11),
            }),
            ...request(
              4,
              "thread/goal/set",
              { threadId: nativeThreadId, status: "paused" },
              { goal: codexGoal("paused", 10) },
            ),
            notification("goal paused", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: null,
              goal: codexGoal("paused", 10),
            }),
          ],
        });
        const requests: Array<string> = [];
        const harness = yield* makeCodexReplayHarness(
          transcript,
          () => Effect.void,
          (method) =>
            Effect.sync(() => {
              requests.push(method);
            }),
        );
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-hold-attempt"),
            text: prompt,
          }),
        );
        const providerTurnId = (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
          driver: CodexAdapterV2.CODEX_DRIVER_KIND,
          nativeTurnId: "goal-turn",
        });
        const turnStatuses = () =>
          harness.events.flatMap((event) =>
            event.type === "provider_turn.updated" && event.providerTurn.id === providerTurnId
              ? [event.providerTurn.status]
              : [],
          );
        yield* harness.awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "provider_thread.updated" &&
                event.providerThread.goal?.tokensUsed === 11,
            ),
          "the completed turn to be held",
        );
        assert.deepEqual(turnStatuses(), ["running"]);
        assert.lengthOf(harness.terminalEvents(), 0);

        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId,
        });
        yield* harness.firstTerminal;

        assert.notInclude(requests, "turn/interrupt");
        assert.deepEqual(turnStatuses(), ["running", "completed"]);
        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["interrupted"],
        );
      }).pipe(Effect.scoped, Effect.provide(layerAdapterTest)),
    );

    it.effect("moves a Stop that names an earlier goal turn to the turn Codex continued with", () =>
      Effect.gen(function* () {
        const prompt = "Keep going";
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-stop-after-continuation",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "goal-turn-a", prompt }),
            notification("goal active", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn-a",
              goal: codexGoal("active", 10),
            }),
            notification("first turn done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-a", status: "completed" }),
            }),
            notification("continuation", "turn/started", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-b", status: "inProgress" }),
            }),
            notification("goal accounted", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn-b",
              goal: codexGoal("active", 11),
            }),
            ...request(
              4,
              "thread/goal/set",
              { threadId: nativeThreadId, status: "paused" },
              { goal: codexGoal("paused", 11) },
            ),
            ...request(
              5,
              "turn/interrupt",
              { threadId: nativeThreadId, turnId: "goal-turn-b" },
              {},
            ),
            notification("continuation interrupted", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-b", status: "interrupted" }),
            }),
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-successor-attempt"),
            text: prompt,
          }),
        );
        yield* harness.awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "provider_thread.updated" &&
                event.providerThread.goal?.tokensUsed === 11,
            ),
          "the continuation to be adopted",
        );
        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId: (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
            driver: CodexAdapterV2.CODEX_DRIVER_KIND,
            nativeTurnId: "goal-turn-a",
          }),
          requestRuntimeRestart: true,
        });
        yield* harness.firstTerminal;
        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["interrupted"],
        );
      }).pipe(Effect.scoped, Effect.provide(layerAdapterTest)),
    );

    it.effect("pauses a goal Codex does not continue before its run settles", () =>
      Effect.gen(function* () {
        const prompt = "Keep going";
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-continuation-expired",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "goal-turn", prompt }),
            notification("goal active", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn",
              goal: codexGoal("active", 10),
            }),
            notification("turn done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn", status: "completed" }),
            }),
            notification("goal accounted", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: null,
              goal: codexGoal("active", 11),
            }),
            ...request(
              4,
              "thread/goal/set",
              { threadId: nativeThreadId, status: "paused" },
              { goal: codexGoal("paused", 11) },
            ),
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-expired-attempt"),
            text: prompt,
          }),
        );
        yield* harness.awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "provider_thread.updated" &&
                event.providerThread.goal?.tokensUsed === 11,
            ),
          "goal accounting observed",
        );
        assert.lengthOf(harness.terminalEvents(), 0);
        yield* TestClock.adjust("5 seconds");
        yield* harness.firstTerminal;

        assert.deepEqual(providerGoals(harness.events), ["active", "active", "paused"]);
        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["completed"],
        );
      }).pipe(Effect.scoped, Effect.provide(layerAdapterTest)),
    );

    it.effect("pauses a goal at once while a delegated task will wake the thread", () =>
      Effect.gen(function* () {
        const lookupStarted = yield* Deferred.make<void>();
        const lookupAnswered = yield* Deferred.make<void>();
        const turnStart = (id: number, text: string) =>
          Effect.map(
            CodexAdapterV2.buildCodexTurnStartParams({
              nativeThreadId,
              codexInput: [{ type: "text", text }],
              runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
              modelSelection: CODEX_TEST_MODEL_SELECTION,
              hasGoatMcp: true,
            }),
            (params): CodexReplay.CodexAppServerReplayEntry => ({
              type: "expect_outbound",
              label: "turn/start",
              frame: { id, method: "turn/start", params },
            }),
          );
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-paused-for-wake",
          entries: [
            ...sessionStart,
            // A changed MCP credential makes GOAT check the thread before reloading it; an
            // unexplained goal read counts as busy and defers the reload.
            {
              type: "expect_outbound",
              label: "busy check",
              frame: { id: 3, method: "thread/goal/get", params: { threadId: nativeThreadId } },
            },
            {
              type: "emit_inbound",
              label: "busy check",
              frame: { id: 3, error: { code: -32000, message: "Unavailable." } },
            },
            yield* turnStart(4, "Delegate and wait"),
            ...withReplayRequestId(
              codexReplayPreamble({ nativeThreadId, nativeTurnId: "goal-turn", prompt: "" }).slice(
                6,
              ),
              4,
            ),
            notification("goal active", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn",
              goal: codexGoal("active", 10),
            }),
            notification("turn done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn", status: "completed" }),
            }),
            // Codex continues before the wake lookup answers.
            notification("continuation", "turn/started", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-2", status: "inProgress" }),
            }),
            ...request(
              5,
              "thread/goal/set",
              { threadId: nativeThreadId, status: "paused" },
              { goal: codexGoal("paused", 10) },
            ),
            ...request(
              6,
              "thread/goal/set",
              { threadId: nativeThreadId, status: "paused" },
              { goal: codexGoal("paused", 10) },
            ),
            ...request(
              7,
              "turn/interrupt",
              { threadId: nativeThreadId, turnId: "goal-turn-2" },
              {},
            ),
            ...request(
              8,
              "thread/goal/get",
              { threadId: nativeThreadId },
              { goal: codexGoal("paused", 10) },
            ),
            // A changed MCP credential makes GOAT check the thread before reloading it; an
            // unexplained goal read counts as busy and defers the reload.
            {
              type: "expect_outbound",
              label: "busy check",
              frame: { id: 9, method: "thread/goal/get", params: { threadId: nativeThreadId } },
            },
            {
              type: "emit_inbound",
              label: "busy check",
              frame: { id: 9, error: { code: -32000, message: "Unavailable." } },
            },
            yield* turnStart(10, "Child finished"),
            ...withReplayRequestId(
              codexReplayPreamble({ nativeThreadId, nativeTurnId: "wake-turn", prompt: "" }).slice(
                6,
              ),
              10,
            ),
            ...request(
              11,
              "thread/goal/set",
              { threadId: nativeThreadId, status: "active" },
              { goal: codexGoal("active", 10) },
            ),
            notification("goal resumed", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "wake-turn",
              goal: codexGoal("active", 10),
            }),
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* (yield* McpProviderSessions.McpProviderSessions).set({
          environmentId: EnvironmentId.make("test"),
          threadId: harness.threadId,
          providerSessionId: "wake-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
          endpoint: "http://127.0.0.1:43123/mcp",
          authorizationHeader: "Bearer test",
          browserToolsAvailable: true,
          hasPendingWake: Deferred.succeed(lookupStarted, undefined).pipe(
            Effect.andThen(Deferred.await(lookupAnswered)),
            Effect.as(true),
          ),
        });
        yield* harness.runtime.startTurn(yield* goalTurnInput(harness, "Delegate and wait"));
        yield* Deferred.await(lookupStarted);
        yield* Deferred.succeed(lookupAnswered, undefined);
        // Settles without waiting out the continuation grace.
        yield* harness.firstTerminal;
        assert.deepEqual(providerGoals(harness.events), ["active", "paused"]);
        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["completed"],
        );
        assert.deepEqual(
          harness.events.flatMap((event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "running"
              ? [event.providerTurn.ordinal]
              : [],
          ),
          [1],
        );

        // Inspecting the goal must not cancel its resume on the wake.
        yield* harness.runtime.startTurn(yield* goalTurnInput(harness, "/goal"));
        yield* harness.runtime.startTurn(yield* goalTurnInput(harness, "Child finished"));
        yield* harness.awaitUntil(
          () => providerGoals(harness.events).at(-1) === "active",
          "goal resumed on the wake",
        );
      }).pipe(Effect.scoped, Effect.provide(layerAdapterTest)),
    );

    it.effect("stops a turn Codex starts while the expiry pause is in flight", () =>
      Effect.gen(function* () {
        const prompt = "Keep going";
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-continuation-during-expiry",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "goal-turn", prompt }),
            notification("goal active", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn",
              goal: codexGoal("active", 10),
            }),
            notification("turn done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn", status: "completed" }),
            }),
            notification("goal accounted", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: null,
              goal: codexGoal("active", 11),
            }),
            {
              type: "expect_outbound",
              label: "pause",
              frame: {
                id: 4,
                method: "thread/goal/set",
                params: { threadId: nativeThreadId, status: "paused" },
              },
            },
            notification("goal paused", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: null,
              goal: codexGoal("paused", 11),
            }),
            notification("late continuation", "turn/started", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-2", status: "inProgress" }),
            }),
            ...request(
              5,
              "thread/goal/set",
              { threadId: nativeThreadId, status: "paused" },
              { goal: codexGoal("paused", 11) },
            ),
            ...request(
              6,
              "turn/interrupt",
              { threadId: nativeThreadId, turnId: "goal-turn-2" },
              {},
            ),
            {
              type: "emit_inbound",
              label: "paused",
              frame: { id: 4, result: { goal: codexGoal("paused", 11) } },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-race-attempt"),
            text: prompt,
          }),
        );
        yield* harness.awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "provider_thread.updated" &&
                event.providerThread.goal?.tokensUsed === 11,
            ),
          "goal accounting observed",
        );
        yield* TestClock.adjust("5 seconds");
        yield* harness.firstTerminal;

        assert.deepEqual(
          harness.terminalEvents().map((event) => [event.providerTurnId, event.status]),
          [
            [
              (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
                driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                nativeTurnId: "goal-turn",
              }),
              "completed",
            ],
          ],
        );
        assert.equal(providerGoals(harness.events).at(-1), "paused");
      }).pipe(Effect.scoped, Effect.provide(layerAdapterTest)),
    );

    it.effect("settles the run when Codex never answers the expiry pause", () =>
      Effect.gen(function* () {
        const prompt = "Keep going";
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-expiry-pause-unanswered",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "goal-turn", prompt }),
            notification("goal active", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn",
              goal: codexGoal("active", 10),
            }),
            notification("turn done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn", status: "completed" }),
            }),
            notification("goal accounted", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: null,
              goal: codexGoal("active", 11),
            }),
            {
              type: "expect_outbound",
              label: "pause",
              frame: {
                id: 4,
                method: "thread/goal/set",
                params: { threadId: nativeThreadId, status: "paused" },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-unanswered-attempt"),
            text: prompt,
          }),
        );
        yield* harness.awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "provider_thread.updated" &&
                event.providerThread.goal?.tokensUsed === 11,
            ),
          "goal accounting observed",
        );
        yield* TestClock.adjust("5 seconds");
        yield* TestClock.adjust("10 seconds");
        yield* harness.firstTerminal;

        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["completed"],
        );
      }).pipe(Effect.scoped, Effect.provide(layerAdapterTest)),
    );

    it.effect("pauses an active goal before Stop interrupts its turn", () =>
      Effect.gen(function* () {
        const prompt = "Keep going";
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-stop",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "goal-turn", prompt }),
            notification("goal active", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn",
              goal: codexGoal("active", 10),
            }),
            ...request(
              4,
              "thread/goal/set",
              { threadId: nativeThreadId, status: "paused" },
              { goal: codexGoal("paused", 10) },
            ),
            ...request(5, "turn/interrupt", { threadId: nativeThreadId, turnId: "goal-turn" }, {}),
            notification("interrupted", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn", status: "interrupted" }),
            }),
          ],
        });
        const requests: Array<string> = [];
        const harness = yield* makeCodexReplayHarness(
          transcript,
          () => Effect.void,
          (method) =>
            Effect.sync(() => {
              requests.push(method);
            }),
        );
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-stop-attempt"),
            text: prompt,
          }),
        );
        yield* harness.awaitUntil(
          () => providerGoals(harness.events).includes("active"),
          "the active goal to reach the provider thread",
        );
        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId: (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
            driver: CodexAdapterV2.CODEX_DRIVER_KIND,
            nativeTurnId: "goal-turn",
          }),
        });
        yield* harness.firstTerminal;

        assert.deepEqual(requests.slice(-2), ["thread/goal/set", "turn/interrupt"]);
        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["interrupted"],
        );
      }).pipe(Effect.scoped, Effect.provide(layerAdapterTest)),
    );
  });
});
