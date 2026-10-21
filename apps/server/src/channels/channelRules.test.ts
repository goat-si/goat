import { assert, describe, it } from "@effect/vitest";
import {
  ChannelGatewayError,
  ChannelTask,
  ChannelTaskEvent,
  ChannelWorkerResult,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { deliveryOutcomeFor } from "./ChannelDeliveryWorker.ts";
import { effectiveRequester, lowerRuntimeMode, mayAnswerFor } from "./ChannelGateway.ts";
import { applyChannelTaskEvent } from "./channelTaskTransitions.ts";

const decodeTask = Schema.decodeUnknownSync(ChannelTask);
const decodeWorkerResult = Schema.decodeUnknownSync(ChannelWorkerResult);
const decodeEvent = Schema.decodeUnknownSync(ChannelTaskEvent);
const NOW = "2026-10-12T00:00:00.000Z";

const task = (overrides: Record<string, unknown> = {}) =>
  decodeTask({
    taskId: "task-1",
    conversationId: "conv-1",
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
    title: "Job",
    instruction: "Do the job.",
    status: "running",
    version: 4,
    generation: 2,
    worker: { environmentId: "env-1", threadId: "worker", runId: "run-1", generation: 2 },
    openQuestions: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });

const event = (type: string, payload: unknown, taskVersion = 5) =>
  decodeEvent({
    eventId: "event-" + taskVersion,
    sequence: 0,
    taskId: "task-1",
    taskVersion,
    occurredAt: NOW,
    actor: "system",
    type,
    payload,
  });

describe("task transitions", () => {
  it("rejects a report from an older generation and a skipped version", () => {
    const stale = applyChannelTaskEvent(
      task(),
      event("task.progress", { generation: 1, summary: "x" }),
    );
    assert.isFalse(stale.ok);
    const skipped = applyChannelTaskEvent(
      task(),
      event("task.progress", { generation: 2, summary: "x" }, 6),
    );
    assert.isFalse(skipped.ok);
  });

  it("never finishes a task twice and restarts it only as a new generation", () => {
    const completed = applyChannelTaskEvent(
      task(),
      event("task.completed", { generation: 2, summary: "ok" }),
    );
    assert.isTrue(completed.ok);
    if (!completed.ok) return;
    assert.strictEqual(completed.task.status, "completed");
    const again = applyChannelTaskEvent(
      completed.task,
      event("task.completed", { generation: 2, summary: "ok" }, 6),
    );
    assert.isFalse(again.ok);
    const sameGeneration = applyChannelTaskEvent(
      completed.task,
      event("task.retry.requested", { generation: 2 }, 6),
    );
    assert.isFalse(sameGeneration.ok);
    const retried = applyChannelTaskEvent(
      completed.task,
      event("task.retry.requested", { generation: 3 }, 6),
    );
    assert.isTrue(retried.ok);
    if (retried.ok) {
      assert.strictEqual(retried.task.status, "received");
      assert.isUndefined(retried.task.worker);
    }
  });

  it("moves only active tasks into the next generation and drops the old worker and target", () => {
    const payload = { generation: 3, host: "mini", fromHost: "mac-studio", replicaCapturedAt: NOW };
    for (const generation of [1, 2, 4]) {
      assert.isFalse(
        applyChannelTaskEvent(task(), event("task.moved", { ...payload, generation })).ok,
      );
    }
    for (const status of ["received", "completed", "failed", "cancelled"]) {
      assert.isFalse(applyChannelTaskEvent(task({ status }), event("task.moved", payload)).ok);
    }
    for (const status of ["dispatching", "running", "waiting_input"]) {
      const moved = applyChannelTaskEvent(
        task({
          status,
          host: "mac-studio",
          projectId: "project-old",
          target: {
            environmentId: "env-1",
            projectId: "project-old",
            modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
            runtimeMode: "full-access",
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
          },
          briefVersion: 1,
          openQuestions: [{ questionId: "q-old", text: "Continue?", askedAt: NOW }],
        }),
        event("task.moved", payload),
      );
      assert.isTrue(moved.ok);
      if (!moved.ok) continue;
      assert.strictEqual(moved.task.status, "received");
      assert.strictEqual(moved.task.generation, 3);
      assert.strictEqual(moved.task.host, "mini");
      assert.strictEqual(moved.task.version, 5);
      assert.isUndefined(moved.task.worker);
      assert.isUndefined(moved.task.target);
      assert.isUndefined(moved.task.projectId);
      // The next generation freezes a brief of its own when it launches.
      assert.isUndefined(moved.task.briefVersion);
      assert.deepStrictEqual(moved.task.openQuestions, []);
      assert.deepStrictEqual(moved.task.movedFrom, {
        host: "mac-studio",
        generation: 2,
        at: NOW,
        replicaCapturedAt: NOW,
      });
    }
  });

  it("sends an answered dispatcher question back to dispatch and a worker question back to the worker", () => {
    const question = { questionId: "q-1", text: "Which project?", askedAt: NOW };
    const answer = event("task.question.answered", { questionId: "q-1", answer: "this one" });
    const noWorker = task({
      status: "waiting_input",
      worker: undefined,
      openQuestions: [question],
    });
    const withWorker = task({ status: "waiting_input", openQuestions: [question] });
    const fromDispatcher = applyChannelTaskEvent(noWorker, answer);
    const fromWorker = applyChannelTaskEvent(withWorker, answer);
    assert.strictEqual(fromDispatcher.ok ? fromDispatcher.task.status : undefined, "received");
    assert.strictEqual(fromWorker.ok ? fromWorker.task.status : undefined, "running");
    const unknown = applyChannelTaskEvent(
      withWorker,
      event("task.question.answered", { questionId: "q-other", answer: "?" }),
    );
    assert.isFalse(unknown.ok);
  });

  it("records a worker observation without moving the task, and keeps only pull requests once it ends", () => {
    const observed = {
      pullRequests: [
        {
          repository: "goat-si/goat",
          number: 42,
          url: "https://github.com/goat-si/goat/pull/42",
          watching: true,
        },
      ],
      needsYou: [{ kind: "approval", since: NOW }],
      usageLimitResetAt: "2026-10-12T05:00:00.000Z",
    };
    const waiting = applyChannelTaskEvent(
      task({ status: "waiting_input" }),
      event("task.worker.observed", { generation: 2, observed }),
    );
    assert.strictEqual(waiting.ok ? waiting.task.status : undefined, "waiting_input");
    const recorded = applyChannelTaskEvent(
      task(),
      event("task.worker.observed", { generation: 2, observed }),
    );
    assert.isTrue(recorded.ok);
    if (!recorded.ok) return;
    assert.strictEqual(recorded.task.status, "running");
    assert.deepStrictEqual(recorded.task.observed?.needsYou, [{ kind: "approval", since: NOW }]);

    const stale = applyChannelTaskEvent(
      task(),
      event("task.worker.observed", { generation: 1, observed }),
    );
    assert.isFalse(stale.ok);

    const completed = applyChannelTaskEvent(
      recorded.task,
      event("task.completed", { generation: 2, summary: "ok" }, 6),
    );
    assert.isTrue(completed.ok);
    if (!completed.ok) return;
    assert.deepStrictEqual(completed.task.observed, {
      pullRequests: observed.pullRequests,
      needsYou: [],
    });
    const afterEnd = applyChannelTaskEvent(
      completed.task,
      event("task.worker.observed", { generation: 2, observed }, 7),
    );
    assert.isFalse(afterEnd.ok);
    const retried = applyChannelTaskEvent(
      completed.task,
      event("task.retry.requested", { generation: 3 }, 7),
    );
    assert.isUndefined(retried.ok ? retried.task.observed : "rejected");
  });
});

describe("delivery outcomes", () => {
  const now = DateTime.makeUnsafe(NOW);

  it("retries a rate limit after Retry-After and gives up on account errors", () => {
    const rateLimited = deliveryOutcomeFor(
      new ChannelGatewayError({
        reason: "delivery_failed",
        deliveryOutcome: "not_sent",
        deliveryErrorCode: "rate_limited",
        retryAfterSeconds: 30,
      }),
      1,
      now,
    );
    assert.deepStrictEqual(rateLimited, {
      type: "retry",
      at: "2026-10-12T00:00:30.000Z",
      errorCode: "rate_limited",
    });
    for (const code of [
      "not_in_channel",
      "channel_not_found",
      "invalid_auth",
      "token_revoked",
    ] as const) {
      assert.strictEqual(
        deliveryOutcomeFor(
          new ChannelGatewayError({
            reason: "delivery_failed",
            deliveryOutcome: "not_sent",
            deliveryErrorCode: code,
          }),
          1,
          now,
        ).type,
        "failed",
      );
    }
  });

  it("records a send that may have arrived as ambiguous, and a missing transport as failed", () => {
    assert.strictEqual(
      deliveryOutcomeFor(
        new ChannelGatewayError({
          reason: "delivery_failed",
          deliveryOutcome: "unknown",
          deliveryErrorCode: "timeout",
        }),
        1,
        now,
      ).type,
      "ambiguous",
    );
    assert.strictEqual(
      deliveryOutcomeFor(new ChannelGatewayError({ reason: "adapter_unavailable" }), 1, now).type,
      "failed",
    );
  });
});

describe("linked account permissions", () => {
  it("takes the lower runtime ceiling and the shared scopes of connection and link", () => {
    assert.strictEqual(lowerRuntimeMode("full-access", "auto"), "auto");
    assert.strictEqual(lowerRuntimeMode("approval-required", "full-access"), "approval-required");
    const requester = effectiveRequester(
      {
        ownerId: "owner",
        principalId: "owner",
        displayName: "Owner",
        grantedScopes: ["orchestration:read", "orchestration:operate"],
        runtimeModeCeiling: "auto-accept-edits",
      },
      {
        ownerId: "owner",
        principalId: "owner",
        displayName: "Owner",
        grantedScopes: ["orchestration:operate", "settings:write"],
        runtimeModeCeiling: "full-access",
      },
      { originKind: "slack", externalActorId: "U1" },
    );
    assert.strictEqual(requester.runtimeModeCeiling, "auto-accept-edits");
    assert.deepStrictEqual(requester.grantedScopes, ["orchestration:operate"]);
  });

  it("lets only someone with the asker's reach answer a task's question", () => {
    const asker = task().requester;
    const answerer = (overrides: Partial<typeof asker>) => ({ ...asker, ...overrides });
    assert.isTrue(mayAnswerFor(answerer({ principalId: "colleague" }), asker));
    // Read-only accounts and agents cannot steer running work.
    assert.isFalse(mayAnswerFor(answerer({ grantedScopes: ["orchestration:read"] }), asker));
    // A lower ceiling would steer work running above what the answerer may run.
    assert.isFalse(mayAnswerFor(answerer({ runtimeModeCeiling: "auto" }), asker));
    assert.isFalse(mayAnswerFor(answerer({ ownerId: "someone-else" }), asker));
    assert.isTrue(
      mayAnswerFor(answerer({ runtimeModeCeiling: "full-access" }), {
        ...asker,
        runtimeModeCeiling: "approval-required",
      }),
    );
  });
});

describe("terminal check evidence", () => {
  const check = {
    status: "completed",
    command: "vp test run",
    exitCode: 1,
    durationMs: 50,
    at: NOW,
    outputTail: "failed",
  };
  const result = decodeWorkerResult({
    runId: "run-1",
    tests: { ok: true },
    observedCheck: check,
    observedCheckPending: false,
  });
  it.each(["completed", "failed", "cancelled"])(
    "preserves %s and its outcome fields on late evidence",
    (status) => {
      const before = task({
        status,
        completedAt: NOW,
        resultSummary: "original",
        completionReport: "present",
      });
      const next = applyChannelTaskEvent(
        before,
        event("task.worker.observed", {
          generation: 2,
          observed: { pullRequests: [], needsYou: [{ kind: "question", since: NOW }], result },
        }),
      );
      assert.isTrue(next.ok);
      if (!next.ok) return;
      assert.strictEqual(next.task.status, status);
      assert.strictEqual(next.task.resultSummary, "original");
      assert.strictEqual(next.task.completedAt, NOW);
      assert.strictEqual(next.task.completionReport, "present");
      assert.deepStrictEqual(next.task.observed?.needsYou, []);
      assert.deepStrictEqual(next.task.observed?.result, result);
      const sparse = applyChannelTaskEvent(
        next.task,
        event(
          "task.worker.observed",
          {
            generation: 2,
            observed: {
              pullRequests: [],
              needsYou: [],
              result: {
                runId: "run-1",
                observedCheck: { ...check, status: "running" },
                observedCheckPending: true,
              },
            },
          },
          6,
        ),
      );
      assert.isTrue(sparse.ok);
      if (sparse.ok) assert.deepStrictEqual(sparse.task.observed?.result, result);
    },
  );
  it("rejects evidence from another run or generation and clears evidence on rebind", () => {
    const before = task({
      status: "completed",
      observed: { pullRequests: [], needsYou: [], result },
    });
    for (const [generation, runId] of [
      [1, "run-1"],
      [2, "other-run"],
    ] as const) {
      assert.isFalse(
        applyChannelTaskEvent(
          before,
          event("task.worker.observed", {
            generation,
            observed: { pullRequests: [], needsYou: [], result: { ...result, runId } },
          }),
        ).ok,
      );
    }
    const running = task({ observed: { pullRequests: [], needsYou: [], result } });
    const rebound = applyChannelTaskEvent(
      running,
      event("task.worker.bound", { worker: { ...running.worker, runId: "run-2" } }),
    );
    assert.isTrue(rebound.ok);
    if (rebound.ok) assert.isUndefined(rebound.task.observed?.result);
  });
});
