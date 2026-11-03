import { assert, describe, it } from "@effect/vitest";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import { MessageId, ProviderTurnId, RunId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";

import { fixture, layerAdapterTest } from "./CodexAdapterV2.attachment.testkit.ts";
import { makeCodexReplayTurn } from "./CodexReplay.testkit.ts";

type Fixture = ReturnType<typeof fixture>;
type Replay = Effect.Success<Fixture["open"]>;

const text = (value: string) => [{ type: "text", text: value }];
const steer = (f: Fixture, id: number, expectedTurnId: string, input: string) =>
  f.entries.push({
    type: "expect_outbound",
    frame: {
      id,
      method: "turn/steer",
      params: { threadId: f.nativeThreadId, expectedTurnId, input: text(input) },
    },
  });
const answer = (f: Fixture, id: number, result: Record<string, unknown>, afterMs?: number) =>
  f.entries.push({
    type: "emit_inbound",
    ...(afterMs === undefined ? {} : { afterMs }),
    frame: { id, result },
  });
const notify = (f: Fixture, method: string, params: Record<string, unknown>, afterMs?: number) =>
  f.entries.push({
    type: "emit_inbound",
    ...(afterMs === undefined ? {} : { afterMs }),
    frame: { method, params },
  });
const turnEnded = (
  f: Fixture,
  turnId: string,
  status: "completed" | "interrupted",
  afterMs?: number,
) => {
  notify(
    f,
    "thread/status/changed",
    { threadId: f.nativeThreadId, status: { type: "idle" } },
    afterMs,
  );
  notify(f, "turn/completed", {
    threadId: f.nativeThreadId,
    turn: makeCodexReplayTurn({ id: turnId, status }),
  });
};
const interrupt = (f: Fixture, id: number, turnId: string) => {
  f.entries.push({
    type: "expect_outbound",
    frame: { id, method: "turn/interrupt", params: { threadId: f.nativeThreadId, turnId } },
  });
  answer(f, id, {});
};
// The provider turn the adapter reported for a run, as the orchestrator would see it.
const runTurn = (
  replay: Replay,
  scenario: string,
  ordinal: number,
  matches: (turn: { readonly nativeId: string | null; readonly status: string }) => boolean = () =>
    true,
) => replay.providerTurn((turn) => turn.runAttemptId === `${scenario}-${ordinal}` && matches(turn));
const stop = (replay: Replay, providerTurnId: string) =>
  replay.runtime.interruptTurn({
    providerThread: replay.providerThread,
    providerTurnId: ProviderTurnId.make(providerTurnId),
  });
const open = (scenario: string) =>
  Effect.gen(function* () {
    const f = fixture(scenario);
    yield* (yield* McpProviderSessions.McpProviderSessions).set(f.config);
    f.start();
    return f;
  });

describe("Codex turn start on a busy native thread", () => {
  it.effect(
    "regression: a run started while a goal turn runs steers into it instead of queueing a turn (H2)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const scenario = "guard-tracked-goal-turn";
          const f = yield* open(scenario);
          yield* f.turnStart(3, 1, false);
          steer(f, 4, "turn-1", "turn-2");
          answer(f, 4, { turnId: "turn-1" });
          // H3: a steer of the new run names the turn Codex is actually running.
          steer(f, 5, "turn-1", "follow-up");
          answer(f, 5, { turnId: "turn-1" });
          interrupt(f, 6, "turn-1");
          turnEnded(f, "turn-1", "interrupted");
          const replay = yield* f.open;
          yield* replay.startTurn(1);
          yield* replay.startTurn(2);
          const adopted = yield* runTurn(replay, scenario, 2);
          assert.deepStrictEqual([adopted.nativeId, adopted.status], ["turn-1", "running"]);
          yield* replay.runtime.steerTurn({
            threadId: replay.threadId,
            runId: RunId.make(`run-${scenario}-2`),
            providerThread: replay.providerThread,
            providerTurnId: ProviderTurnId.make(adopted.id),
            message: {
              createdBy: "user",
              creationSource: "web",
              messageId: MessageId.make("follow-up"),
              text: "follow-up",
              attachments: [],
            },
          });
          yield* stop(replay, adopted.id);
          const terminal = yield* replay.terminal;
          assert.deepStrictEqual(terminal, { providerTurnId: adopted.id, status: "interrupted" });
          assert.notInclude(replay.requests.slice(3), "turn/start");
        }),
      ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect("steers into a turn Codex runs that GOAT does not track", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = "guard-untracked-turn";
        const f = yield* open(scenario);
        notify(f, "thread/status/changed", {
          threadId: f.nativeThreadId,
          status: { type: "active", activeFlags: [] },
        });
        notify(f, "turn/started", {
          threadId: f.nativeThreadId,
          turn: makeCodexReplayTurn({ id: "native-turn", status: "inProgress" }),
        });
        // The turn's start is the last event before the run starts.
        notify(f, "thread/tokenUsage/updated", {
          threadId: f.nativeThreadId,
          turnId: "native-turn",
          tokenUsage: {
            total: {
              totalTokens: 1,
              inputTokens: 1,
              cachedInputTokens: 0,
              outputTokens: 0,
              reasoningOutputTokens: 0,
            },
            last: {
              totalTokens: 1,
              inputTokens: 1,
              cachedInputTokens: 0,
              outputTokens: 0,
              reasoningOutputTokens: 0,
            },
            modelContextWindow: 200_000,
          },
        });
        steer(f, 3, "native-turn", "turn-1");
        answer(f, 3, { turnId: "native-turn" });
        turnEnded(f, "native-turn", "completed");
        const replay = yield* f.open;
        yield* replay.startTurn(1);
        const terminal = yield* replay.terminal;
        assert.deepStrictEqual(terminal, {
          providerTurnId: (yield* runTurn(replay, scenario, 1)).id,
          status: "completed",
        });
        assert.notInclude(replay.requests, "turn/start");
      }),
    ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect("holds a run the running turn cannot take and starts it once the thread is idle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = "guard-hold-then-start";
        const f = yield* open(scenario);
        yield* f.turnStart(3, 1, false);
        steer(f, 4, "turn-1", "turn-2");
        f.entries.push({
          type: "emit_inbound",
          frame: { id: 4, error: { code: -32600, message: "cannot steer a review turn" } },
        });
        turnEnded(f, "turn-1", "completed", 5_000);
        yield* f.turnStart(5, 2, false);
        f.turnCompleted(2);
        const replay = yield* f.open;
        yield* replay.startTurn(1);
        yield* replay.startTurn(2);
        assert.deepStrictEqual(
          replay.requests.filter((method) => method === "turn/start"),
          ["turn/start"],
        );
        yield* TestClock.adjust("5 seconds");
        const terminals = [yield* replay.terminal, yield* replay.terminal];
        assert.deepStrictEqual(
          terminals.map((terminal) => terminal.status),
          ["completed", "completed"],
        );
        assert.equal(terminals[1]?.providerTurnId, (yield* runTurn(replay, scenario, 2)).id);
      }),
    ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect("Stop ends a held run at once and the held turn never starts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = "guard-stop-held";
        const f = yield* open(scenario);
        yield* f.turnStart(3, 1, false);
        steer(f, 4, "turn-1", "turn-2");
        f.entries.push({
          type: "emit_inbound",
          frame: { id: 4, error: { code: -32600, message: "cannot steer a review turn" } },
        });
        turnEnded(f, "turn-1", "completed", 5_000);
        const replay = yield* f.open;
        yield* replay.startTurn(1);
        yield* replay.startTurn(2);
        const held = yield* runTurn(replay, scenario, 2);
        yield* stop(replay, held.id);
        assert.deepStrictEqual(yield* replay.terminal, {
          providerTurnId: held.id,
          status: "interrupted",
        });
        yield* TestClock.adjust("5 seconds");
        assert.equal((yield* replay.terminal).status, "completed");
        assert.deepStrictEqual(
          replay.requests.filter((method) => method === "turn/start"),
          ["turn/start"],
        );
      }),
    ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect(
    "a steer of a turn Codex never started fails clearly instead of naming that turn (H3)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const scenario = "guard-steer-unstarted";
          const f = yield* open(scenario);
          yield* f.turnStart(3, 1, false);
          // Codex answers without a start time and never starts this turn.
          f.entries.splice(-2, 2);
          const answered = f.entries.at(-1);
          if (answered?.type === "emit_inbound")
            f.entries.splice(-1, 1, {
              ...answered,
              frame: {
                id: 3,
                result: {
                  turn: {
                    ...makeCodexReplayTurn({ id: "turn-1", status: "inProgress" }),
                    startedAt: null,
                  },
                },
              },
            });
          const replay = yield* f.open;
          yield* replay.startTurn(1);
          const queued = yield* runTurn(replay, scenario, 1);
          const steered = yield* replay.runtime
            .steerTurn({
              threadId: replay.threadId,
              runId: RunId.make(`run-${scenario}-1`),
              providerThread: replay.providerThread,
              providerTurnId: ProviderTurnId.make(queued.id),
              message: {
                createdBy: "user",
                creationSource: "web",
                messageId: MessageId.make("late"),
                text: "late",
                attachments: [],
              },
            })
            .pipe(Effect.exit, Effect.forkScoped);
          yield* TestClock.adjust("10 seconds");
          const exit = yield* Fiber.join(steered);
          assert.isTrue(Exit.isFailure(exit));
          assert.include(String(Exit.isFailure(exit) ? exit.cause : ""), "has not started");
          assert.notInclude(replay.requests, "turn/steer");
        }),
      ).pipe(Effect.provide(layerAdapterTest)),
  );
});
