import { assert, describe, it } from "@effect/vitest";
import { ChannelTask, ChannelTaskEvent, ProjectId, RunId } from "@goat/contracts";
import * as Schema from "effect/Schema";

import { settleCompletedRun } from "./channelRunOutcome.ts";
import { applyChannelTaskEvent } from "./channelTaskTransitions.ts";
import { chipDelivery, makeTaskEvent } from "./channelTaskWrites.ts";

const now = "2026-10-12T00:00:00.000Z";
const task = Schema.decodeUnknownSync(ChannelTask)({
  taskId: "task-1",
  conversationId: "conversation-1",
  originBindingId: "binding-1",
  originAddress: { kind: "goat", environmentId: "env-1", threadId: "bot" },
  originInputId: "input-1",
  requester: {
    ownerId: "owner",
    principalId: "owner",
    displayName: "Owner",
    originKind: "goat",
    runtimeModeCeiling: "full-access",
    grantedScopes: ["orchestration:operate"],
  },
  title: "Deploy",
  instruction: "Deploy the change.",
  status: "running",
  version: 4,
  generation: 2,
  worker: { environmentId: "env-1", threadId: "worker", runId: "run-1", generation: 2 },
  openQuestions: [],
  createdAt: now,
  updatedAt: now,
});
const runId = RunId.make("run-1");
const turn = Schema.decodeUnknownSync(ChannelTask)({
  ...Schema.encodeSync(ChannelTask)(task),
  kind: "turn",
});

const completedSummary = (event: ReturnType<typeof settleCompletedRun>) => {
  if (event.type !== "task.completed")
    throw new Error("expected task.completed, got " + event.type);
  return event.payload.summary;
};

const decodeEventJson = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelTaskEvent));
const decodeEvent = Schema.decodeUnknownSync(ChannelTaskEvent);

const replay = (event: ChannelTaskEvent) => {
  // A JSON round trip exercises the persisted event decoder before projection.
  const decoded = decodeEventJson(JSON.stringify(event));
  const transition = applyChannelTaskEvent(task, decoded);
  if (!transition.ok) throw new Error(transition.reason);
  return transition.task;
};

describe("completed run outcomes", () => {
  it.each([
    {
      outcome: "failed",
      status: "failed",
      summary: "The worker reported that it could not finish.",
    },
    {
      outcome: "cancelled",
      status: "failed",
      summary: "The worker reported that it stopped before finishing.",
    },
    {
      outcome: "blocked",
      status: "waiting_input",
      summary:
        "The worker reported that it is blocked without giving a reason. How should it continue?",
    },
  ] as const)(
    "uses a useful fallback for a blank $outcome report",
    ({ outcome, status, summary }) => {
      const event = makeTaskEvent(
        task,
        settleCompletedRun({
          task,
          runId,
          reported: { outcome, summary: " \n " },
          fallbackSummary: "Looks done.",
          now,
        }),
        now,
      );
      const next = replay(event);
      assert.strictEqual(next.status, status);
      if (outcome === "blocked") {
        assert.strictEqual(next.openQuestions[0]?.text, summary);
        assert.isUndefined(next.completedAt);
      } else {
        assert.strictEqual(next.resultSummary, summary);
      }
    },
  );

  it("keeps the assistant summary for success without a summary, with a present marker", () => {
    const event = makeTaskEvent(
      task,
      settleCompletedRun({
        task,
        runId,
        reported: { outcome: "succeeded", summary: "  " },
        fallbackSummary: "Deployed.",
        now,
      }),
      now,
    );
    const next = replay(event);
    assert.strictEqual(next.status, "completed");
    assert.strictEqual(next.resultSummary, "Deployed.");
    assert.strictEqual(next.completionReport, "present");
  });

  it("replays a task.completed event from before reports without manufacturing a marker", () => {
    const oldEvent = decodeEvent({
      eventId: "old-completion",
      sequence: 12,
      taskId: task.taskId,
      taskVersion: task.version + 1,
      occurredAt: now,
      actor: "system",
      type: "task.completed",
      payload: { generation: task.generation, runId, summary: "Deployed." },
    });
    assert.notProperty(oldEvent.payload, "report");
    const next = replay(oldEvent);
    assert.strictEqual(next.status, "completed");
    assert.notProperty(next, "completionReport");
    const delivery = chipDelivery(next, {
      environmentId: task.worker!.environmentId,
      projectId: ProjectId.make("project-1"),
      threadId: task.worker!.threadId,
    });
    assert.strictEqual(delivery.message.kind, "task_chip");
    if (delivery.message.kind !== "task_chip") throw new Error("expected a task chip");
    assert.notProperty(delivery.message.chip, "completionReport");
  });

  it("clears the missing report marker when the person retries the task", () => {
    const done = replay(
      makeTaskEvent(
        task,
        settleCompletedRun({
          task,
          runId,
          reported: undefined,
          fallbackSummary: "Deployed.",
          now,
        }),
        now,
      ),
    );
    assert.strictEqual(done.completionReport, "missing");
    const retried = applyChannelTaskEvent(
      done,
      makeTaskEvent(
        done,
        {
          type: "task.retry.requested",
          payload: { generation: task.generation + 1 },
        },
        now,
      ),
    );
    if (!retried.ok) throw new Error(retried.reason);
    assert.strictEqual(retried.task.status, "received");
    assert.notProperty(retried.task, "completionReport");
  });
});
+describe("a bot turn's answer", () => {
  const longAnswer = [
    "The disk is full because Docker keeps 41 GB of old images.",
    "",
    "Pruning unused images frees about 38 GB; the rest belongs to running containers.",
    "I did not run the prune, so nothing has been deleted yet.",
  ].join("\n");

  it.each([
    {
      case: "a full answer over a shorter report",
      text: longAnswer,
      report: "Docker images fill the disk.",
    },
    {
      case: "a concise answer over a longer report",
      text: "Docker images take 41 GB.",
      report:
        "Investigated disk usage across volumes, listed the largest folders and found Docker images at 41 GB.",
    },
    {
      case: "its own proposed completion when it wrote no final message",
      text: "Docker images take 41 GB; prune them.",
      report: "Done.",
    },
  ])("delivers the turn's own text: $case", ({ text, report }) => {
    const event = settleCompletedRun({
      task: turn,
      runId,
      reported: { outcome: "succeeded", summary: report },
      fallbackSummary: text,
      now,
    });
    assert.strictEqual(completedSummary(event), text);
  });

  it.each([
    { case: "the no-final-text placeholder", fallback: "Finished." },
    { case: "blank text", fallback: " \n " },
  ])("settles with the report summary when the caller has $case", ({ fallback }) => {
    const event = settleCompletedRun({
      task: turn,
      runId,
      reported: { outcome: "succeeded", summary: "Docker images take 41 GB." },
      fallbackSummary: fallback,
      now,
    });
    assert.strictEqual(completedSummary(event), "Docker images take 41 GB.");
  });

  it("keeps a coding task's report summary over its final message", () => {
    const event = settleCompletedRun({
      task,
      runId,
      reported: { outcome: "succeeded", summary: "Deployed." },
      fallbackSummary: longAnswer,
      now,
    });
    assert.strictEqual(completedSummary(event), "Deployed.");
  });
});
