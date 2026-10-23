import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { cloudTaskResultText } from "@goat/provider-core/server/cloudTask";
import { makeHarness, sessionAnswer } from "./adapterTesting.ts";
import { ClaudeCloudError } from "./protocol.ts";
import { cloudAssistant, cloudPrompt, teleportTranscript } from "./testing.ts";

const terminalOf = (h: Effect.Success<ReturnType<typeof makeHarness>>) =>
  h.events.find((event) => event.type === "turn.terminal");
/** Starts a first turn whose session never opens a PR and waits until GOAT follows it. */
const launchWithoutPullRequest = Effect.fnUntraced(function* () {
  const h = yield* makeHarness();
  h.noMatch();
  yield* h.runtime.startTurn(h.input);
  yield* Deferred.await(h.accepted);
  yield* Deferred.succeed(h.exit, undefined);
  yield* Deferred.await(h.read);
  return h;
});

it.effect("a session that answers without a PR completes the turn with its full reply", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const reply = "Top-level folders: apps, packages.\n" + "x".repeat(5000);
      const h = yield* makeHarness();
      h.sessionReads(sessionAnswer("task", reply));
      h.noMatch();
      yield* h.runtime.startTurn(h.input);
      yield* Deferred.await(h.accepted);
      yield* Deferred.succeed(h.exit, undefined);
      yield* Deferred.await(h.read);
      yield* TestClock.adjust("30 seconds");
      yield* Deferred.await(h.terminal);
      expect(terminalOf(h)).toMatchObject({ status: "completed", resultText: reply });
      const task = h.ledger.at(-1);
      expect(task).toMatchObject({
        status: "succeeded",
        progress: "Session replied (1 read, $0.0064)",
      });
      expect(task?.summary?.length).toBeLessThanOrEqual(4000);
      // The run's result message carries the whole reply and the session link.
      expect(cloudTaskResultText(task!, { resultText: reply })).toBe(
        reply + "\n\n- Cloud task: https://claude.ai/code/session_ABC123",
      );
    }),
  ),
);

it.effect("a follow-up completes when the session ends its turn, not when it is admitted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const answered = (stop: "stop_sequence" | "end_turn", text: string) =>
        Effect.succeed({
          transcript: teleportTranscript([
            cloudPrompt("task", "1969-12-31T23:50:00.000Z"),
            cloudAssistant({ type: "text", text: "First answer." }, "end_turn"),
            cloudPrompt("follow-up question", "1970-01-01T00:00:01.000Z"),
            cloudAssistant({ type: "text", text }, stop),
          ]),
          costUsd: 0.0064,
        });
      h.sessionReads(
        answered("stop_sequence", "| partial"),
        answered("end_turn", "Second answer."),
      );
      yield* h.runtime.startTurn({
        ...h.input,
        providerThread: h.saved,
        message: { ...h.input.message, text: "follow-up question" },
      });
      yield* Deferred.await(h.admitted);
      yield* TestClock.adjust("30 seconds");
      expect(terminalOf(h)).toBeUndefined();
      expect(h.ledger.at(-1)?.progress).toBe(
        "Follow-up accepted. Session checked: still working (last read $0.0064; 1 read, $0.0064).",
      );
      yield* TestClock.adjust("1 minute");
      yield* Deferred.await(h.terminal);
      expect(terminalOf(h)).toMatchObject({ status: "completed", resultText: "Second answer." });
      expect(h.counts()).toEqual({ starts: 0, sends: 1, reads: 0 });
    }),
  ),
);

it.effect("an unreadable session says so and falls back to the session-linked PR", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const unreadable = new ClaudeCloudError({
        detail: "Claude did not report the session it read.",
        outcome: "uncertain",
      });
      const h = yield* launchWithoutPullRequest();
      h.sessionReads(Effect.fail(unreadable), Effect.fail(unreadable), Effect.fail(unreadable));
      for (let step = 0; step < 8; step++) yield* TestClock.adjust("30 seconds");
      expect(h.sessionReadTimes).toEqual([30_000, 90_000, 210_000]);
      expect(h.ledger.at(-1)?.progress).toBe(
        "Running in the cloud. GOAT can't read the session (Claude did not report the session it read.), so it waits for a session-linked PR instead.",
      );
      expect(terminalOf(h)).toBeUndefined();
      h.match();
      yield* Deferred.succeed(h.deliver, undefined);
      yield* TestClock.adjust("1 minute");
      yield* Deferred.await(h.terminal);
      expect(h.ledger.at(-1)).toMatchObject({ status: "succeeded", progress: "Result PR found" });
      expect(h.sessionReadTimes).toHaveLength(3);
    }),
  ),
);

it.effect(
  "session reads back off from 30 seconds to every 10 minutes while the session works",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* launchWithoutPullRequest();
        for (let step = 0; step < 56; step++) yield* TestClock.adjust("30 seconds");
        expect(h.sessionReadTimes).toEqual([
          30_000, 90_000, 210_000, 450_000, 1_050_000, 1_650_000,
        ]);
        expect(terminalOf(h)).toBeUndefined();
      }),
    ),
);
