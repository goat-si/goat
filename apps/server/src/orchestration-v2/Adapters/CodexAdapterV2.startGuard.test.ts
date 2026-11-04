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
const expect = (f: Fixture, id: number, method: string, params: Record<string, unknown>) =>
  f.entries.push({ type: "expect_outbound", frame: { id, method, params } });
const steer = (f: Fixture, id: number, expectedTurnId: string, input: string) =>
  expect(f, id, "turn/steer", { threadId: f.nativeThreadId, expectedTurnId, input: text(input) });
const answer = (f: Fixture, id: number, result: Record<string, unknown>) =>
  f.entries.push({ type: "emit_inbound", frame: { id, result } });
const notify = (f: Fixture, method: string, params: Record<string, unknown>) =>
  f.entries.push({ type: "emit_inbound", frame: { method, params } });
const turnEnded = (f: Fixture, turnId: string, status: "completed" | "interrupted") => {
  notify(f, "thread/status/changed", { threadId: f.nativeThreadId, status: { type: "idle" } });
  notify(f, "turn/completed", {
    threadId: f.nativeThreadId,
    turn: makeCodexReplayTurn({ id: turnId, status }),
  });
};
const interrupt = (f: Fixture, id: number, turnId: string) => {
  expect(f, id, "turn/interrupt", { threadId: f.nativeThreadId, turnId });
  answer(f, id, {});
};
const goal = (f: Fixture, status: "active" | "paused") => ({
  threadId: f.nativeThreadId,
  objective: "keep going",
  status,
  tokenBudget: null,
  tokensUsed: 1,
  timeUsedSeconds: 1,
  createdAt: 1782622440,
  updatedAt: 1782622450,
});
// Codex starts a turn of its own that no GOAT run owns.
const codexStartsTurn = (f: Fixture, turnId: string) => {
  notify(f, "thread/status/changed", {
    threadId: f.nativeThreadId,
    status: { type: "active", activeFlags: [] },
  });
  notify(f, "turn/started", {
    threadId: f.nativeThreadId,
    turn: makeCodexReplayTurn({ id: turnId, status: "inProgress" }),
  });
};
// A goal update after Codex's own turn tells the test the adapter has seen that turn.
const fence = (f: Fixture) =>
  notify(f, "thread/goal/updated", { threadId: f.nativeThreadId, goal: goal(f, "paused") });
// The provider turn the adapter reported for a run, as the orchestrator would see it.
const runTurn = (replay: Replay, scenario: string, ordinal: number) =>
  replay.providerTurn((turn) => turn.runAttemptId === `${scenario}-${ordinal}`);
const message = (text: string) => ({
  createdBy: "user" as const,
  creationSource: "web" as const,
  messageId: MessageId.make(text),
  text,
  attachments: [],
});
const open = (scenario: string) =>
  Effect.gen(function* () {
    const f = fixture(scenario);
    yield* (yield* McpProviderSessions.McpProviderSessions).set(f.config);
    f.start();
    return f;
  });
const starts = (replay: Replay) => replay.requests.filter((method) => method === "turn/start");

describe("Codex turn start on a busy native thread", () => {
  // Was: steer into the earlier run's turn. The maintainer chose to stop such a turn instead. The
  // likely incident path: a Stop Codex never confirmed ends the run in GOAT while Codex keeps the turn
  // running, and the next message used to send turn/start onto it.
  it.effect(
    "regression: after a Stop Codex never confirmed, the next run stops that turn before starting instead of queueing one (H2)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const scenario = "guard-unconfirmed-stop";
          const f = yield* open(scenario);
          yield* f.turnStart(3, 1, false);
          expect(f, 4, "turn/interrupt", { threadId: f.nativeThreadId, turnId: "turn-1" });
          f.entries.push({ type: "emit_inbound", afterMs: 1_000, frame: { id: 4, result: {} } });
          interrupt(f, 5, "turn-1");
          turnEnded(f, "turn-1", "interrupted");
          yield* f.turnStart(6, 2, false);
          f.turnCompleted(2);
          const replay = yield* f.open;
          yield* replay.startTurn(1);
          const stopped = yield* replay.runtime
            .interruptTurn({
              providerThread: replay.providerThread,
              providerTurnId: ProviderTurnId.make((yield* runTurn(replay, scenario, 1)).id),
            })
            .pipe(Effect.forkScoped);
          yield* TestClock.adjust("12 seconds");
          yield* Fiber.join(stopped);
          assert.equal((yield* replay.terminal).status, "interrupted");
          yield* replay.startTurn(2);
          assert.equal((yield* replay.terminal).status, "completed");
          assert.deepStrictEqual(
            replay.requests.filter(
              (method) => method === "turn/interrupt" || method === "turn/start",
            ),
            ["turn/start", "turn/interrupt", "turn/interrupt", "turn/start"],
          );
        }),
      ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect(
    "steers into a turn Codex runs that GOAT never owned, and the run's steer and Stop reach that turn (H2, H3)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const scenario = "guard-unowned-turn";
          const f = yield* open(scenario);
          yield* f.turnStart(3, 1, false);
          f.turnCompleted(1);
          codexStartsTurn(f, "native-turn");
          fence(f);
          steer(f, 4, "native-turn", "turn-2");
          answer(f, 4, { turnId: "native-turn" });
          steer(f, 5, "native-turn", "follow-up");
          answer(f, 5, { turnId: "native-turn" });
          interrupt(f, 6, "native-turn");
          turnEnded(f, "native-turn", "interrupted");
          const replay = yield* f.open;
          yield* replay.startTurn(1);
          yield* replay.terminal;
          yield* replay.goalTokens;
          yield* replay.startTurn(2);
          const adopted = yield* runTurn(replay, scenario, 2);
          assert.deepStrictEqual([adopted.nativeId, adopted.status], ["native-turn", "running"]);
          yield* replay.runtime.steerTurn({
            threadId: replay.threadId,
            runId: RunId.make(`run-${scenario}-2`),
            providerThread: replay.providerThread,
            providerTurnId: ProviderTurnId.make(adopted.id),
            message: message("follow-up"),
          });
          yield* replay.runtime.interruptTurn({
            providerThread: replay.providerThread,
            providerTurnId: ProviderTurnId.make(adopted.id),
          });
          assert.deepStrictEqual(yield* replay.terminal, {
            providerTurnId: adopted.id,
            status: "interrupted",
          });
          assert.deepStrictEqual(starts(replay), ["turn/start"]);
        }),
      ).pipe(Effect.provide(layerAdapterTest)),
  );

  // Was: hold the run until the turn ends. Fail-closed by the maintainer's choice: Codex took
  // nothing, so the person sends it again.
  it.effect("fails clearly when a turn GOAT never owned refuses the steer, sending no turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = "guard-unowned-refused";
        const f = yield* open(scenario);
        yield* f.turnStart(3, 1, false);
        f.turnCompleted(1);
        codexStartsTurn(f, "review-turn");
        fence(f);
        steer(f, 4, "review-turn", "turn-2");
        f.entries.push({
          type: "emit_inbound",
          frame: { id: 4, error: { code: -32600, message: "cannot steer a review turn" } },
        });
        const replay = yield* f.open;
        yield* replay.startTurn(1);
        yield* replay.terminal;
        yield* replay.goalTokens;
        const error = yield* replay.startTurn(2).pipe(Effect.flip);
        assert.include(String(error.cause), "refused this message, so it was not sent");
        assert.deepStrictEqual(starts(replay), ["turn/start"]);
      }),
    ).pipe(Effect.provide(layerAdapterTest)),
  );

  // Was: Stop of a held run. With no hold, the case that remains is a turn GOAT already stopped
  // that Codex keeps running: it is stopped again before the next start, never steered.
  it.effect("stops a turn GOAT already stopped again before the next run starts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = "guard-stopped-orphan";
        const f = yield* open(scenario);
        yield* f.turnStart(3, 1, false);
        f.turnCompleted(1);
        notify(f, "thread/goal/updated", { threadId: f.nativeThreadId, goal: goal(f, "active") });
        codexStartsTurn(f, "orphan-turn");
        // GOAT pauses the goal and stops the turn no run owns; Codex keeps running it.
        expect(f, 4, "thread/goal/set", { threadId: f.nativeThreadId, status: "paused" });
        answer(f, 4, { goal: goal(f, "paused") });
        notify(f, "thread/goal/updated", { threadId: f.nativeThreadId, goal: goal(f, "paused") });
        interrupt(f, 5, "orphan-turn");
        interrupt(f, 6, "orphan-turn");
        turnEnded(f, "orphan-turn", "interrupted");
        yield* f.turnStart(7, 2, false);
        f.turnCompleted(2);
        const replay = yield* f.open;
        yield* replay.startTurn(1);
        yield* replay.terminal;
        assert.equal(yield* replay.interrupted, "orphan-turn");
        yield* replay.startTurn(2);
        assert.equal(yield* replay.interrupted, "orphan-turn");
        assert.equal((yield* replay.terminal).status, "completed");
      }),
    ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect("a run that adopted a turn Codex ends right after the steer still settles", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = "guard-adopt-ends";
        const f = yield* open(scenario);
        yield* f.turnStart(3, 1, false);
        f.turnCompleted(1);
        codexStartsTurn(f, "native-turn");
        fence(f);
        steer(f, 4, "native-turn", "turn-2");
        answer(f, 4, { turnId: "native-turn" });
        turnEnded(f, "native-turn", "completed");
        const replay = yield* f.open;
        yield* replay.startTurn(1);
        yield* replay.terminal;
        yield* replay.goalTokens;
        yield* replay.startTurn(2);
        assert.deepStrictEqual(yield* replay.terminal, {
          providerTurnId: (yield* runTurn(replay, scenario, 2)).id,
          status: "completed",
        });
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
              message: message("late"),
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
