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
      yield* fs.writeFileString(
        harness.transcript,
        '{"type":"user","uuid":"tool-denied","timestamp":"2026-10-17T06:00:01.000Z","toolDenialKind":"user-rejected","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool_fixture","is_error":true,"content":"Rejected"}]}}\n',
        { flag: "a" },
      );
      yield* harness.offerAndWait(frames.workflowSnapshot({ uuid: "held-member", state: "error" }));
      yield* harness.offerAndWait(
        frames.workflowNotification({ uuid: "workflow-stopped", status: "stopped" }),
      );
      assert.isUndefined(stopping.pollUnsafe());
      assert.equal(workflowCoordinatorEvents(harness.events).at(-1)?.subagent.status, "cancelled");
      const toolOutcomes = () =>
        harness.events.flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === "tool_fixture"
            ? [event.turnItem.status]
            : [],
        );
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
