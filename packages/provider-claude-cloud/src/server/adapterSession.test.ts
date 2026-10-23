import { expect, it } from "@effect/vitest";
import { RunAttemptId, RunId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { cloudTaskResultText } from "@goat/provider-core/server/cloudTask";
import { makeHarness, sessionAnswer, sessionWorkingRead } from "./adapter.testkit.ts";
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
      expect(cloudTaskResultText(task!, { status: "completed", resultText: reply })).toBe(
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
      // The result keeps why the PR stands in for the session's reply.
      const reason = "GOAT can't read the session (Claude did not report the session it read.).";
      expect(h.ledger.at(-1)).toMatchObject({
        status: "succeeded",
        progress: "Result PR found. " + reason,
      });
      expect(h.ledger.at(-1)?.summary).toContain(reason);
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
        h.sessionWorking();
        for (let step = 0; step < 56; step++) yield* TestClock.adjust("30 seconds");
        expect(h.sessionReadTimes).toEqual([
          30_000, 90_000, 210_000, 450_000, 1_050_000, 1_650_000,
        ]);
        expect(terminalOf(h)).toBeUndefined();
      }),
    ),
);

it.effect(
  "a PR found while the session still works is recorded and the run waits for the reply",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        h.sessionReads(sessionWorkingRead, sessionAnswer("task", "Done; see the PR."));
        yield* Deferred.succeed(h.deliver, undefined);
        yield* h.runtime.startTurn(h.input);
        yield* Deferred.await(h.accepted);
        yield* Deferred.succeed(h.exit, undefined);
        yield* Deferred.await(h.prRecorded);
        expect(terminalOf(h)).toBeUndefined();
        expect(h.ledger.at(-1)).toMatchObject({
          status: "running",
          prUrl: "https://github.com/fixture/repository/pull/1",
          progress:
            "Running in the cloud. Found a session-linked PR; waiting for the session to finish.",
        });
        yield* TestClock.adjust("1 minute");
        yield* Deferred.await(h.terminal);
        expect(terminalOf(h)).toMatchObject({
          status: "completed",
          resultText: "Done; see the PR.",
        });
        expect(h.ledger.at(-1)).toMatchObject({
          status: "succeeded",
          prUrl: "https://github.com/fixture/repository/pull/1",
          branch: "claude/result",
        });
        expect(h.counts().reads).toBe(1);
      }),
    ),
);

it.effect("a restart after a cut reply reads the session once to import the whole reply", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const reply = "Full reply. " + "y".repeat(5000);
      const h = yield* makeHarness();
      h.sessionReads(sessionAnswer("task", reply));
      yield* h.runtime.resumeTurn!({
        ...h.attach,
        cloudTask: {
          ...h.saved.cloudTask,
          status: "succeeded",
          progress: "Session replied (1 read, $0.0064)",
          summary: reply.slice(0, 3999) + "…",
        },
      });
      yield* Deferred.await(h.terminal);
      expect(terminalOf(h)).toMatchObject({ status: "completed", resultText: reply });
      expect(h.sessionReadTimes).toHaveLength(1);
    }),
  ),
);

it.effect("a registered session's follow-up recovers its own reply, not a later prompt's", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const reply = "Own reply. " + "z".repeat(5000);
      const h = yield* makeHarness();
      h.history({ first: false });
      h.sessionReads(
        Effect.succeed({
          transcript: teleportTranscript([
            cloudPrompt("task", "1970-01-01T00:00:01.000Z"),
            cloudAssistant({ type: "text", text: reply }, "end_turn"),
            cloudPrompt("asked on claude.ai later", "1970-01-01T00:00:09.000Z"),
            cloudAssistant({ type: "text", text: "Someone else's answer." }, "end_turn"),
          ]),
          costUsd: 0.0064,
        }),
      );
      yield* h.runtime.resumeTurn!({
        ...h.attach,
        cloudTask: {
          ...h.saved.cloudTask,
          attach: "registered",
          status: "succeeded",
          progress: "Session replied (2 reads, $0.0128)",
          summary: reply.slice(0, 3999) + "…",
        },
      });
      yield* Deferred.await(h.terminal);
      expect(terminalOf(h)).toMatchObject({ status: "completed", resultText: reply });
    }),
  ),
);

it.effect("one failed read beside a found PR does not let the PR end the run early", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.sessionReads(
        Effect.fail(new ClaudeCloudError({ detail: "Teleport timed out.", outcome: "uncertain" })),
        sessionAnswer("task", "Finished after the PR."),
      );
      yield* Deferred.succeed(h.deliver, undefined);
      yield* h.runtime.startTurn(h.input);
      yield* Deferred.await(h.accepted);
      yield* Deferred.succeed(h.exit, undefined);
      yield* Deferred.await(h.prRecorded);
      expect(terminalOf(h)).toBeUndefined();
      yield* TestClock.adjust("1 minute");
      yield* Deferred.await(h.terminal);
      expect(terminalOf(h)).toMatchObject({
        status: "completed",
        resultText: "Finished after the PR.",
      });
      expect(h.ledger.at(-1)).toMatchObject({
        status: "succeeded",
        prUrl: "https://github.com/fixture/repository/pull/1",
      });
    }),
  ),
);

it.effect(
  "a registered session's follow-up never takes an identical claude.ai prompt's reply as its own",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        // Asked on claude.ai two seconds before GOAT's run started, and answered.
        const transcript = teleportTranscript([
          cloudPrompt("task", "1969-12-31T23:59:58.000Z"),
          cloudAssistant({ type: "text", text: "Answer from claude.ai." }, "end_turn"),
          cloudPrompt("task", "1970-01-01T00:00:03.000Z"),
          cloudAssistant({ type: "text", text: "Answer to GOAT." }, "end_turn"),
        ]);
        const read = Effect.succeed({ transcript, costUsd: 0.0064 });
        h.history({ first: false });
        h.sessionReads(read, read, read);
        yield* h.runtime.startTurn({
          ...h.input,
          providerThread: { ...h.saved, cloudTask: { ...h.saved.cloudTask, attach: "registered" } },
        });
        yield* Deferred.await(h.admitted);
        yield* TestClock.adjust("210 seconds");
        yield* Deferred.await(h.terminal);
        expect(terminalOf(h)).toMatchObject({ status: "completed" });
        expect(terminalOf(h)).not.toHaveProperty("resultText");
        expect(h.ledger.at(-1)?.summary).toContain("another prompt like this run's");
        expect(h.sessionReadTimes).toEqual([30_000, 90_000, 210_000]);
      }),
    ),
);

it.effect(
  "a restart that cannot read the run's history keeps the saved reply instead of guessing",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reply = "Own reply. " + "z".repeat(5000);
        const h = yield* makeHarness();
        h.historyUnreadable();
        h.sessionReads(sessionAnswer("task", "The session's first reply."));
        yield* h.runtime.resumeTurn!({
          ...h.attach,
          cloudTask: {
            ...h.saved.cloudTask,
            status: "succeeded",
            progress: "Session replied (2 reads, $0.0128)",
            summary: reply.slice(0, 3999) + "…",
          },
        });
        yield* Deferred.await(h.terminal);
        expect(terminalOf(h)).toMatchObject({ status: "completed" });
        expect(terminalOf(h)).not.toHaveProperty("resultText");
        expect(h.sessionReadTimes).toEqual([]);
      }),
    ),
);

it.effect(
  "a repeated message completes with its own reply once an earlier read set the boundary",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const earlier = [
          cloudPrompt("task", "1970-01-01T00:00:00.000Z"),
          cloudAssistant({ type: "text", text: "First answer." }, "end_turn"),
          cloudPrompt("continue", "1970-01-01T00:00:01.000Z"),
          cloudAssistant({ type: "text", text: "Continued once." }, "end_turn"),
        ];
        h.sessionReads(
          Effect.succeed({ transcript: teleportTranscript(earlier), costUsd: 0.0064 }),
          Effect.succeed({
            transcript: teleportTranscript([
              ...earlier,
              cloudPrompt("continue", "1970-01-01T00:01:00.000Z"),
              cloudAssistant({ type: "text", text: "Continued twice." }, "end_turn"),
            ]),
            costUsd: 0.0064,
          }),
        );
        const continueTurn = (ordinal: number) => ({
          ...h.input,
          runId: RunId.make("cloud-run-continue-" + ordinal),
          attemptId: RunAttemptId.make("cloud-attempt-continue-" + ordinal),
          runOrdinal: ordinal,
          providerTurnOrdinal: ordinal,
          message: { ...h.input.message, text: "continue" },
        });
        yield* h.runtime.startTurn({ ...continueTurn(2), providerThread: h.saved });
        yield* Deferred.await(h.admitted);
        yield* TestClock.adjust("30 seconds");
        yield* Deferred.await(h.terminal);
        expect(terminalOf(h)).toMatchObject({ resultText: "Continued once." });
        yield* h.runtime.startTurn({ ...continueTurn(3), providerThread: h.saved });
        yield* TestClock.adjust("30 seconds");
        yield* Deferred.await(h.secondTerminal);
        expect(h.events.findLast((event) => event.type === "turn.terminal")).toMatchObject({
          status: "completed",
          resultText: "Continued twice.",
        });
      }),
    ),
);

it.effect(
  "a restart past the deadline lets the PR recorded before it stand, without looking it up again",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        h.noMatch();
        yield* TestClock.adjust("121 minutes");
        yield* h.runtime.resumeTurn!({
          ...h.attach,
          cloudTask: {
            ...h.saved.cloudTask,
            prUrl: "https://github.com/fixture/repository/pull/1",
            branch: "claude/result",
            summary: "Changed behavior.",
            progress:
              "Running in the cloud. Found a session-linked PR; waiting for the session to finish.",
          },
        });
        yield* Deferred.await(h.terminal);
        expect(terminalOf(h)).toMatchObject({ status: "completed" });
        expect(h.ledger.at(-1)).toMatchObject({
          status: "succeeded",
          prUrl: "https://github.com/fixture/repository/pull/1",
          progress: "Result PR found. The session had not finished its turn within two hours.",
        });
        expect(h.ledger.at(-1)?.summary).toContain("Changed behavior.");
        expect(h.counts().reads).toBe(0);
      }),
    ),
);
