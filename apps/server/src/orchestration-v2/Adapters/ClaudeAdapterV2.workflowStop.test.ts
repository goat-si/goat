import { assert, it } from "@effect/vitest";
import { RunAttemptId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import { vi } from "vite-plus/test";
import { CaptureEventQueue } from "./ClaudeAdapterV2.observations.testkit.ts";
import * as TestClock from "effect/testing/TestClock";
import { WorkflowAgentTranscriptReadObserver } from "../workflowAgentTranscript.ts";
import {
  claudeWorkflowFrames,
  workflowCoordinatorEvents,
  workflowMemberEvents,
  WORKFLOW_TASK_ID,
} from "./ClaudeAdapterV2.workflow.testkit.ts";
import { ClaudeAgentSdkQueryRunnerError } from "./ClaudeAgentSdkQueryRunner.ts";
import { layerClaudeAdapterTest } from "./ClaudeAdapterTestLayer.testkit.ts";
import { makeClaudeTestTurnInput } from "./ClaudeTestInput.testkit.ts";
import { claudeSdkFrame, WAKE_NATIVE_SESSION } from "./ClaudeWakeFrames.testkit.ts";
import { makeWakeHarnessWithOptions } from "./ClaudeWakeHarness.testkit.ts";

vi.mock("effect/Queue", async (importOriginal) => {
  const actual = await importOriginal<typeof Queue>();
  return {
    ...actual,
    take: <A, E>(queue: Queue.Dequeue<A, E>) =>
      Effect.gen(function* () {
        const capture = yield* CaptureEventQueue;
        if (capture !== undefined && actual.isEnqueue<unknown, never>(queue)) {
          yield* capture((marker) => actual.offer(queue, marker));
        }
        return yield* actual.take(queue);
      }),
  };
});
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  resolveSettings: vi.fn().mockResolvedValue({ effective: {}, provenance: {}, sources: [] }),
}));

const frames = claudeWorkflowFrames(WAKE_NATIVE_SESSION, claudeSdkFrame);
const makeWorkflow = Effect.fn("test.makeWorkflow")(function* (
  stopTask: NonNullable<NonNullable<Parameters<typeof makeWakeHarnessWithOptions>[0]>["stopTask"]>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDir = yield* fs.makeTempDirectoryScoped();
  const transcriptDir = path.join(configDir, "projects", "workflow");
  yield* fs.makeDirectory(transcriptDir, { recursive: true });
  const transcript = path.join(transcriptDir, "agent-a1.jsonl");
  yield* fs.writeFileString(
    transcript,
    '{"type":"assistant","uuid":"tool-line","message":{"id":"msg_fixture","model":"claude-sonnet-4-6","type":"message","role":"assistant","content":[{"type":"tool_use","id":"tool_fixture","name":"Bash","input":{"command":"echo fixture"}}]}}\n',
  );
  const harness = yield* makeWakeHarnessWithOptions({
    stopTask,
    environment: { CLAUDE_CONFIG_DIR: configDir },
  });
  yield* harness.runtime.startTurn(
    makeClaudeTestTurnInput({
      threadId: harness.threadId,
      providerThread: harness.providerThread,
      now: yield* DateTime.now,
      attemptId: RunAttemptId.make("attempt-workflow-stop-race"),
      text: "Run the workflow.",
      attachments: [],
    }),
  );
  yield* harness.offerAndWait(frames.workflowToolUse);
  yield* harness.offerAndWait(frames.workflowTaskStarted);
  yield* harness.offerAndWait(frames.workflowLaunchAck(transcriptDir));
  yield* harness.offerAndWait(
    frames.workflowSnapshot({ uuid: "initial-workflow", state: "start" }),
  );
  const stopWorkflow = harness.runtime.stopTask;
  if (stopWorkflow === undefined) return yield* Effect.die("Workflow Stop missing");
  return {
    ...harness,
    transcript,
    stop: stopWorkflow({ providerThread: harness.providerThread, taskId: WORKFLOW_TASK_ID }),
  };
});

it.effect(
  "returns the workflow Stop timeout while transcript projection still holds the SDK lock",
  () =>
    Effect.gen(function* () {
      const stopRequested = yield* Deferred.make<void>();
      const readerEntered = yield* Deferred.make<void>();
      const releaseReader = yield* Deferred.make<void>();
      let blockRead = false;
      yield* Effect.gen(function* () {
        const harness = yield* makeWorkflow(() =>
          Deferred.succeed(stopRequested, undefined).pipe(Effect.andThen(Effect.never)),
        );
        const stopping = yield* harness.stop.pipe(Effect.timeout("15 seconds"), Effect.forkChild);
        yield* Deferred.await(stopRequested);
        blockRead = true;
        const frame = yield* harness
          .offerAndWait(
            frames.workflowSnapshot({ uuid: "blocked-workflow-progress", state: "start" }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(readerEntered);
        yield* TestClock.adjust("14 seconds");
        assert.isUndefined(stopping.pollUnsafe());
        yield* TestClock.adjust("1 second");
        const atDeadline = stopping.pollUnsafe();
        yield* Deferred.succeed(releaseReader, undefined);
        yield* Fiber.join(frame);
        assert.isDefined(atDeadline);
        assert.isTrue(atDeadline !== undefined && Exit.isFailure(atDeadline));
      }).pipe(
        Effect.provideService(WorkflowAgentTranscriptReadObserver, () =>
          blockRead
            ? Deferred.succeed(readerEntered, undefined).pipe(
                Effect.andThen(Deferred.await(releaseReader)),
              )
            : Effect.void,
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(layerClaudeAdapterTest)),
);

const writeHeldDenial = (fs: FileSystem.FileSystem, path: string) =>
  fs.writeFileString(
    path,
    '{"type":"user","uuid":"tool-denied","timestamp":"2026-10-17T06:00:01.000Z","toolDenialKind":"user-rejected","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool_fixture","is_error":true,"content":"Rejected"}]}}\n',
    { flag: "a" },
  );

it.effect("sends and acknowledges the first workflow Stop during a blocked transcript read", () =>
  Effect.gen(function* () {
    const stopRequested = yield* Deferred.make<void>();
    const readerEntered = yield* Deferred.make<void>();
    const releaseReader = yield* Deferred.make<void>();
    let blockRead = false;
    yield* Effect.gen(function* () {
      const harness = yield* makeWorkflow(() =>
        Deferred.succeed(stopRequested, undefined).pipe(Effect.asVoid),
      );
      blockRead = true;
      const projection = yield* harness
        .offerAndWait(
          frames.workflowSnapshot({ uuid: "transcript-already-blocked", state: "start" }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(readerEntered);
      const stop = yield* harness.stop.pipe(
        Effect.timeout("15 seconds"),
        Effect.result,
        Effect.forkChild,
      );
      yield* TestClock.adjust("15 seconds");
      const result = yield* Fiber.join(stop);
      const sentWhileReading = yield* Deferred.isDone(stopRequested);
      yield* Deferred.succeed(releaseReader, undefined);
      yield* Fiber.join(projection);
      assert.isTrue(
        sentWhileReading,
        "Claude received Stop while transcript projection was blocked",
      );
      assert.equal(result._tag, "Success");
    }).pipe(
      Effect.provideService(WorkflowAgentTranscriptReadObserver, () =>
        blockRead
          ? Deferred.succeed(readerEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseReader)),
            )
          : Effect.void,
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(layerClaudeAdapterTest)),
);

const heldToolOutcomes = (harness: Effect.Success<ReturnType<typeof makeWorkflow>>) =>
  harness.events.flatMap((event) =>
    event.type === "turn_item.updated" && event.turnItem.nativeItemRef?.nativeId === "tool_fixture"
      ? [event.turnItem.status]
      : [],
  );

it.effect.each([false, true])(
  "settles held evidence for a confirmed workflow Stop (timeout before EOF: %s)",
  (timeoutBeforeEof) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const requested = yield* Deferred.make<void>();
      const ack = yield* Deferred.make<void>();
      const harness = yield* makeWorkflow(() =>
        Deferred.succeed(requested, undefined).pipe(Effect.andThen(Deferred.await(ack))),
      );
      yield* TestClock.setTime(Date.parse("2026-10-17T06:00:00.000Z"));
      const request = timeoutBeforeEof
        ? harness.stop.pipe(Effect.timeout("15 seconds"))
        : harness.stop;
      const stopping = yield* request.pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(requested);
      yield* writeHeldDenial(fs, harness.transcript);
      yield* harness.offerAndWait(frames.workflowSnapshot({ uuid: "held-member", state: "error" }));
      yield* harness.offerAndWait(
        frames.workflowNotification({ uuid: "workflow-stopped", status: "stopped" }),
      );
      assert.isUndefined(stopping.pollUnsafe());
      assert.equal(workflowCoordinatorEvents(harness.events).at(-1)?.subagent.status, "cancelled");
      const toolOutcomes = () => heldToolOutcomes(harness);
      if (timeoutBeforeEof) {
        yield* TestClock.adjust("15 seconds");
        assert.isTrue(Exit.isFailure(yield* Fiber.join(stopping)));
        yield* harness.awaitUntil(() => toolOutcomes().length > 1, "held tool settled before EOF");
        assert.deepEqual(toolOutcomes(), ["running", "interrupted"]);
        yield* harness.awaitUntil(
          () =>
            workflowCoordinatorEvents(harness.events).at(-1)?.subagent.workflow?.agents[0]
              ?.outcome === "cancelled",
          "confirmed cancellation projected before EOF",
        );
      }
      yield* Queue.shutdown(harness.sdkMessages);
      yield* harness.awaitQueryExit(harness.sdkMessages);
      assert.deepEqual(toolOutcomes(), ["running", "interrupted"]);
      assert.equal(workflowMemberEvents(harness.events, 1).at(-1)?.subagent.status, "cancelled");
      assert.equal(
        workflowCoordinatorEvents(harness.events).at(-1)?.subagent.workflow?.agents[0]?.outcome,
        "cancelled",
      );

      if (!timeoutBeforeEof) {
        yield* Deferred.succeed(ack, undefined);
        assert.isTrue(Exit.isSuccess(yield* Fiber.join(stopping)));
      }
      yield* harness.awaitEventsRecorded;
      assert.deepEqual(toolOutcomes(), ["running", "interrupted"]);
    }).pipe(Effect.scoped, Effect.provide(layerClaudeAdapterTest)),
);

it.effect.each(["stopped", "rejected", "EOF"] as const)(
  "reconciles a locally timed-out workflow Stop when the native result is %s",
  (nativeResult) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const requested = yield* Deferred.make<void>();
      const reply = yield* Deferred.make<void, ClaudeAgentSdkQueryRunnerError>();
      const harness = yield* makeWorkflow(() =>
        Deferred.succeed(requested, undefined).pipe(Effect.andThen(Deferred.await(reply))),
      );
      yield* TestClock.setTime(Date.parse("2026-10-17T06:00:00.000Z"));
      const request = yield* harness.stop.pipe(
        Effect.timeout("15 seconds"),
        Effect.result,
        Effect.forkChild,
      );
      yield* Deferred.await(requested);
      yield* writeHeldDenial(fs, harness.transcript);
      yield* harness.offerAndWait(frames.workflowSnapshot({ uuid: "held-denial", state: "error" }));
      yield* TestClock.adjust("15 seconds");
      const timeout = yield* Fiber.join(request);
      assert.equal(timeout._tag === "Failure" ? timeout.failure._tag : undefined, "TimeoutError");
      yield* harness.awaitEventsRecorded;
      if (nativeResult === "stopped") {
        yield* harness.offerAndWait(
          frames.workflowNotification({ uuid: "late-stopped", status: "stopped" }),
        );
        assert.deepEqual(heldToolOutcomes(harness), ["running", "interrupted"]);
        assert.equal(
          workflowCoordinatorEvents(harness.events).at(-1)?.subagent.status,
          "cancelled",
        );
        assert.equal(workflowMemberEvents(harness.events, 1).at(-1)?.subagent.status, "cancelled");
      } else {
        assert.deepEqual(heldToolOutcomes(harness), ["running"]);
      }
      if (nativeResult === "rejected") {
        yield* Deferred.fail(
          reply,
          new ClaudeAgentSdkQueryRunnerError({
            method: "stopTask",
            cause: "Provider rejected the request",
          }),
        );
        yield* harness.awaitUntil(
          () => heldToolOutcomes(harness).length > 1,
          "late explicit rejection settled",
        );
        assert.deepEqual(heldToolOutcomes(harness), ["running", "failed"]);
      }
      yield* Queue.shutdown(harness.sdkMessages);
      yield* harness.awaitQueryExit(harness.sdkMessages);
      assert.deepEqual(heldToolOutcomes(harness), [
        "running",
        nativeResult === "stopped" ? "interrupted" : "failed",
      ]);
    }).pipe(Effect.scoped, Effect.provide(layerClaudeAdapterTest)),
);

type NativeReply = Deferred.Deferred<void, ClaudeAgentSdkQueryRunnerError>;

const makeUnansweredWorkflow = Effect.fn("test.makeUnansweredWorkflow")(function* () {
  const sent = yield* Queue.unbounded<NativeReply>();
  const harness = yield* makeWorkflow(() =>
    Effect.gen(function* () {
      const reply = yield* Deferred.make<void, ClaudeAgentSdkQueryRunnerError>();
      yield* Queue.offer(sent, reply);
      yield* Deferred.await(reply);
    }),
  );
  yield* TestClock.setTime(Date.parse("2026-10-17T06:00:00.000Z"));
  const start = () =>
    harness.stop.pipe(Effect.timeout("15 seconds"), Effect.result, Effect.forkChild);
  const first = yield* start();
  const firstReply = yield* Queue.take(sent);
  yield* TestClock.adjust("15 seconds");
  const result = yield* Fiber.join(first);
  assert.equal(result._tag === "Failure" ? result.failure._tag : undefined, "TimeoutError");
  return { ...harness, sent, start, firstReply };
});

it.effect("gives an in-grace Stop retry a clear refusal without sending it", () =>
  Effect.gen(function* () {
    const harness = yield* makeUnansweredWorkflow();
    yield* TestClock.adjust("5 seconds");
    const retry = yield* harness.stop.pipe(Effect.result);
    assert.equal(
      retry._tag === "Failure" ? retry.failure._tag : undefined,
      "ProviderAdapterProtocolError",
    );
    if (retry._tag === "Failure")
      assert.include(retry.failure.message, "previous workflow Stop is still awaiting a reply");
    assert.equal(yield* Queue.size(harness.sent), 0);
  }).pipe(Effect.scoped, Effect.provide(layerClaudeAdapterTest)),
);

it.effect.each(["unanswered", "late previous reply"] as const)(
  "retries Stop after grace with the first request %s",
  (scenario) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const harness = yield* makeUnansweredWorkflow();
      yield* TestClock.adjust("5 minutes");
      yield* harness.offerAndWait(
        frames.workflowSnapshot({ uuid: "workflow-keeps-running", state: "start" }),
      );
      const retry = yield* harness.start();
      // A refusal ends the RPC without enqueuing another native request.
      const second = yield* Effect.raceFirst(
        Queue.take(harness.sent).pipe(Effect.asSome),
        Fiber.join(retry).pipe(Effect.andThen(Effect.succeedNone)),
      );
      assert.equal(second._tag, "Some");
      if (second._tag === "None") return;

      if (scenario === "late previous reply") {
        const time = DateTime.formatIso(DateTime.add(yield* DateTime.now, { seconds: 1 }));
        yield* fs.writeFileString(
          harness.transcript,
          `{"type":"user","uuid":"retry-denied","timestamp":"${time}","toolDenialKind":"user-rejected","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool_fixture","is_error":true,"content":"Rejected"}]}}\n`,
          { flag: "a" },
        );
        yield* harness.offerAndWait(
          frames.workflowSnapshot({ uuid: "retry-held-denial", state: "error" }),
        );
        yield* Deferred.succeed(harness.firstReply, undefined);
        yield* TestClock.adjust(0);
        yield* harness.awaitEventsRecorded;
        assert.isUndefined(retry.pollUnsafe());
        assert.deepEqual(heldToolOutcomes(harness), ["running"]);
      }
      yield* Deferred.succeed(second.value, undefined);
      const accepted = yield* Fiber.join(retry);
      assert.equal(accepted._tag, "Success");
      if (scenario === "late previous reply") {
        yield* harness.awaitUntil(
          () => heldToolOutcomes(harness).length > 1,
          "retry settled its own tool",
        );
        assert.deepEqual(heldToolOutcomes(harness), ["running", "interrupted"]);
      }
    }).pipe(Effect.scoped, Effect.provide(layerClaudeAdapterTest)),
);

it.effect.each(["acknowledged", "rejected", "EOF"] as const)(
  "keeps the first Stop denial after retry until %s",
  (firstResult) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const harness = yield* makeUnansweredWorkflow();
      yield* writeHeldDenial(fs, harness.transcript);
      yield* harness.offerAndWait(
        frames.workflowSnapshot({ uuid: "first-attempt-denial", state: "error" }),
      );
      yield* TestClock.adjust("30 seconds");
      const retry = yield* harness.start();
      const second = yield* Effect.raceFirst(
        Queue.take(harness.sent).pipe(Effect.asSome),
        Fiber.join(retry).pipe(Effect.andThen(Effect.succeedNone)),
      );
      assert.equal(second._tag, "Some");
      yield* harness.awaitEventsRecorded;
      assert.deepEqual(heldToolOutcomes(harness), ["running"]);
      const outcome = firstResult === "acknowledged" ? "interrupted" : "failed";
      if (firstResult !== "EOF") {
        yield* harness.offerAndWait(
          frames.workflowNotification({ uuid: "workflow-stopped-during-retry", status: "stopped" }),
        );
        assert.equal(
          workflowCoordinatorEvents(harness.events).at(-1)?.subagent.status,
          "cancelled",
        );
        assert.deepEqual(heldToolOutcomes(harness), ["running"]);
        if (firstResult === "acknowledged") {
          yield* Deferred.succeed(harness.firstReply, undefined);
        } else {
          yield* Deferred.fail(
            harness.firstReply,
            new ClaudeAgentSdkQueryRunnerError({
              method: "stopTask",
              cause: "Rejected first Stop",
            }),
          );
        }
        yield* harness.awaitUntil(
          () => heldToolOutcomes(harness).length > 1,
          "first attempt's tool settled",
        );
        assert.deepEqual(heldToolOutcomes(harness), ["running", outcome]);
        yield* harness.awaitUntil(
          () =>
            workflowCoordinatorEvents(harness.events).at(-1)?.subagent.workflow?.agents[0]
              ?.state === "failed",
          "first attempt's member outcome projected",
        );
        assert.equal(
          workflowCoordinatorEvents(harness.events).at(-1)?.subagent.workflow?.agents[0]?.outcome,
          firstResult === "acknowledged" ? "cancelled" : undefined,
        );
      }
      assert.isUndefined(retry.pollUnsafe());
      yield* Queue.shutdown(harness.sdkMessages);
      yield* harness.awaitQueryExit(harness.sdkMessages);
      assert.deepEqual(heldToolOutcomes(harness), ["running", outcome]);
    }).pipe(Effect.scoped, Effect.provide(layerClaudeAdapterTest)),
);

it.effect(
  "bounds unresolved native Stop requests for a query and reuses a slot after a reply",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeUnansweredWorkflow();
      for (let sent = 1; sent < 8; sent++) {
        yield* TestClock.adjust("5 minutes");
        const request = yield* harness.start();
        const reply = yield* Effect.raceFirst(
          Queue.take(harness.sent).pipe(Effect.asSome),
          Fiber.join(request).pipe(Effect.andThen(Effect.succeedNone)),
        );
        assert.equal(reply._tag, "Some");
        yield* TestClock.adjust("15 seconds");
        const timeout = yield* Fiber.join(request);
        assert.equal(timeout._tag === "Failure" ? timeout.failure._tag : undefined, "TimeoutError");
      }
      yield* TestClock.adjust("5 minutes");
      const capped = yield* harness.stop.pipe(Effect.result);
      assert.equal(
        capped._tag === "Failure" ? capped.failure._tag : undefined,
        "ProviderAdapterProtocolError",
      );
      if (capped._tag === "Failure")
        assert.include(capped.failure.message, "too many unanswered workflow Stop requests");
      assert.equal(yield* Queue.size(harness.sent), 0);

      yield* Deferred.succeed(harness.firstReply, undefined);
      yield* TestClock.adjust(0);
      const request = yield* harness.start();
      const reply = yield* Effect.raceFirst(
        Queue.take(harness.sent).pipe(Effect.asSome),
        Fiber.join(request).pipe(Effect.andThen(Effect.succeedNone)),
      );
      assert.equal(reply._tag, "Some");
      if (reply._tag === "None") return;
      yield* Deferred.succeed(reply.value, undefined);
      assert.equal((yield* Fiber.join(request))._tag, "Success");
    }).pipe(Effect.scoped, Effect.provide(layerClaudeAdapterTest)),
);
