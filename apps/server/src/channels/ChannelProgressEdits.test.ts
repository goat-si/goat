import { assert, describe, it } from "@effect/vitest";
import { ChannelGatewayError, ChannelOutboundMessage } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { CHANNEL_COPY } from "./channelCopy.ts";
import { skillProposalTaskIdFor, taskIdFor } from "./channelIds.ts";
import { interimAlreadyHeard, isInterimMessage } from "./channelInterimMessages.ts";
import * as ChannelBotThreads from "./ChannelBotThreads.ts";
import * as ChannelDeliveryWorker from "./ChannelDeliveryWorker.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import { botMessages, owner } from "./testkit/ChannelHarness.ts";
import {
  makeProgressHarness,
  startSlackTask,
  type OutboxRow,
} from "./testkit/slackProgressHarness.ts";

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelOutboundMessage));
const textOf = (row: OutboxRow) => decode(row.message_json).text;
const notSent = (
  deliveryErrorCode: "channel_not_found" | "rate_limited",
  retryAfterSeconds?: number,
) =>
  new ChannelGatewayError({
    reason: "delivery_failed",
    deliveryOutcome: "not_sent",
    deliveryErrorCode,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  });

describe("Slack keeps one progress message and edits it", () => {
  it.effect(
    "later milestones edit the acknowledgement, the answer posts fresh, and the bot's chat keeps every step",
    () => {
      const h = makeProgressHarness();
      return Effect.gen(function* () {
        const t = yield* startSlackTask(h, "edit-1");
        yield* t.milestone("Listing the largest folders now.");
        yield* t.milestone("Docker looks like the culprit; checking images.");
        // The acknowledgement went out at 0 s; the next write to it waits 15 s.
        assert.deepStrictEqual(h.calls, []);
        yield* TestClock.adjust("15 seconds");
        yield* t.runtime.drain;
        assert.deepStrictEqual(h.calls, [
          {
            operation: "edit",
            ts: t.ack.ts!,
            text: t.ack.text + "\n\nDocker looks like the culprit; checking images.",
          },
        ]);
        yield* t.finish("Docker images take 41 GB.");
        const kinds = h.posts
          .filter((message) => message.taskId === t.task.taskId)
          .map((message) => message.kind);
        assert.deepStrictEqual(kinds, ["receipt", "result"]);
        // A reception reply is put back as it was once the answer is out, never deleted.
        assert.deepStrictEqual(h.calls.slice(1), [
          { operation: "edit", ts: t.ack.ts!, text: t.ack.text },
        ]);
        const texts = (yield* botMessages).messages.map((message) => message.text);
        assert.include(texts, "Listing the largest folders now.");
        assert.include(texts, "Docker looks like the culprit; checking images.");
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect("two milestones inside 15 s of the last edit give one edit with the newer line", () => {
    const h = makeProgressHarness();
    return Effect.gen(function* () {
      const t = yield* startSlackTask(h, "edit-2");
      yield* t.milestone("First step.");
      yield* TestClock.adjust("15 seconds");
      yield* t.runtime.drain;
      assert.lengthOf(h.calls, 1);
      yield* TestClock.adjust("1 second");
      yield* t.milestone("Second step.");
      yield* TestClock.adjust("4 seconds");
      yield* t.milestone("Third step.");
      yield* TestClock.adjust("9 seconds");
      yield* t.runtime.drain;
      assert.lengthOf(h.calls, 1);
      yield* TestClock.adjust("1 second");
      yield* t.runtime.drain;
      assert.deepStrictEqual(h.calls.slice(1), [
        { operation: "edit", ts: t.ack.ts!, text: t.ack.text + "\n\nThird step." },
      ]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a milestone that would leave the message as it reads sends nothing", () => {
    const h = makeProgressHarness();
    return Effect.gen(function* () {
      const t = yield* startSlackTask(h, "edit-3");
      yield* t.milestone("Checking images.");
      yield* TestClock.adjust("15 seconds");
      yield* t.runtime.drain;
      yield* t.milestone("Checking images.");
      yield* TestClock.adjust("15 seconds");
      yield* t.runtime.drain;
      assert.lengthOf(h.calls, 1);
      const edits = yield* t.ofOperation("edit");
      assert.deepStrictEqual(
        edits.map((row) => row.state),
        ["delivered", "superseded"],
      );
    }).pipe(Effect.provide(h.layer));
  });

  it.effect(
    "a rate-limited edit never holds the answer and is dropped once the answer is queued",
    () => {
      const h = makeProgressHarness();
      return Effect.gen(function* () {
        const t = yield* startSlackTask(h, "edit-4");
        yield* t.milestone("Checking images.");
        yield* TestClock.adjust("15 seconds");
        h.results.push({ _tag: "rate_limited", retryAfterSeconds: 30 });
        yield* t.runtime.drain;
        const [edit] = yield* t.ofOperation("edit");
        assert.strictEqual(edit?.state, "pending");
        yield* t.finish("Docker images take 41 GB.");
        assert.include(
          h.posts.map((message) => message.text),
          "Docker images take 41 GB.",
        );
        assert.strictEqual((yield* t.ofOperation("edit"))[0]?.state, "superseded");
        yield* TestClock.adjust("60 seconds");
        yield* t.runtime.drain;
        assert.lengthOf(h.calls, 1);
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect(
    "a 429 waits out Retry-After, and is still dropped when a newer milestone is queued",
    () => {
      const h = makeProgressHarness();
      return Effect.gen(function* () {
        const t = yield* startSlackTask(h, "edit-429");
        yield* t.milestone("Step one.");
        yield* TestClock.adjust("15 seconds");
        h.results.push({ _tag: "rate_limited", retryAfterSeconds: 30 });
        yield* t.runtime.drain;
        yield* TestClock.adjust("29 seconds");
        yield* t.runtime.drain;
        assert.lengthOf(h.calls, 1);
        yield* TestClock.adjust("1 second");
        h.results.push({ _tag: "rate_limited", retryAfterSeconds: 30 });
        yield* t.runtime.drain;
        // Retried at Retry-After with the same line, and limited again.
        assert.deepStrictEqual(h.calls.slice(1), [h.calls[0]!]);
        yield* TestClock.adjust("5 seconds");
        yield* t.milestone("Step two.");
        const edits = yield* t.ofOperation("edit");
        assert.deepStrictEqual(
          edits.map((row) => [textOf(row), row.state]),
          [
            ["Step one.", "superseded"],
            ["Step two.", "pending"],
          ],
        );
        yield* TestClock.adjust("15 seconds");
        yield* t.runtime.drain;
        assert.deepStrictEqual(h.calls.slice(2), [
          { operation: "edit", ts: t.ack.ts!, text: t.ack.text + "\n\nStep two." },
        ]);
      }).pipe(Effect.provide(h.layer));
    },
  );
});

describe("a refused or failed write ends the progress message quietly", () => {
  it.effect.each(["refused", "unknown"] as const)(
    "after an edit comes back %s, the message takes no more edits and nothing restores or deletes it",
    (outcome) => {
      const h = makeProgressHarness();
      return Effect.gen(function* () {
        const t = yield* startSlackTask(h, "refused-" + outcome);
        yield* t.acknowledgedBy("fixed");
        yield* t.milestone("Step one.");
        yield* TestClock.adjust("15 seconds");
        h.results.push({ _tag: outcome });
        yield* t.runtime.drain;
        assert.strictEqual((yield* t.ofOperation("edit"))[0]?.last_error_code, "progress_refused");
        yield* t.milestone("Step two.");
        yield* TestClock.adjust("60 seconds");
        yield* t.runtime.drain;
        yield* t.finish("Docker images take 41 GB.");
        yield* TestClock.adjust("60 seconds");
        yield* t.runtime.drain;
        assert.lengthOf(h.calls, 1);
        assert.deepStrictEqual(yield* t.ofOperation("end"), []);
        assert.include(
          h.posts.map((message) => message.text),
          "Docker images take 41 GB.",
        );
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect("a refused delete leaves the message and holds nothing after it", () => {
    const h = makeProgressHarness();
    return Effect.gen(function* () {
      const t = yield* startSlackTask(h, "refused-delete");
      yield* t.acknowledgedBy("fixed");
      h.results.push({ _tag: "refused" });
      yield* t.finish("Docker images take 41 GB.");
      assert.deepStrictEqual(h.calls, [{ operation: "remove", ts: t.ack.ts! }]);
      const [end] = yield* t.ofOperation("end");
      assert.deepStrictEqual([end?.state, end?.last_error_code], ["failed", "progress_refused"]);
      yield* t.sql`INSERT INTO channel_outbox ${t.sql.insert({
        delivery_id: "after-refused",
        cause_key: "test:after-refused",
        input_id: null,
        task_id: t.task.taskId,
        kind: "question",
        destination_kind: "slack",
        message_json: JSON.stringify({
          ...JSON.parse(t.ack.message_json),
          deliveryId: "after-refused",
          kind: "question",
          text: "Delete the old images?",
          taskId: t.task.taskId,
        }),
        state: "pending",
        attempts: 0,
        next_attempt_at: "1970-01-01T00:00:00.000Z",
        created_at: "1970-01-01T00:00:00.000Z",
        updated_at: "1970-01-01T00:00:00.000Z",
      })}`;
      yield* t.runtime.drain;
      assert.strictEqual(h.posts.at(-1)?.text, "Delete the old images?");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect(
    "a skipped edit (no session, or another workspace) fails only itself; the next milestone still edits",
    () => {
      const h = makeProgressHarness();
      return Effect.gen(function* () {
        const t = yield* startSlackTask(h, "skipped");
        yield* t.milestone("Step one.");
        yield* TestClock.adjust("15 seconds");
        h.results.push({ _tag: "skipped" });
        yield* t.runtime.drain;
        yield* t.milestone("Step two.");
        yield* TestClock.adjust("15 seconds");
        h.results.push({ _tag: "skipped" });
        yield* t.runtime.drain;
        yield* t.milestone("Step three.");
        yield* TestClock.adjust("15 seconds");
        yield* t.runtime.drain;
        const edits = yield* t.ofOperation("edit");
        assert.deepStrictEqual(
          edits.map((row) => [row.state, row.last_error_code]),
          [
            ["failed", "progress_skipped"],
            ["failed", "progress_skipped"],
            ["delivered", null],
          ],
        );
        assert.strictEqual(h.calls.at(-1)?.text, t.ack.text + "\n\nStep three.");
      }).pipe(Effect.provide(h.layer));
    },
  );
});

describe("the progress message after the answer", () => {
  it.effect("a fixed acknowledgement is deleted once the answer is delivered", () => {
    const h = makeProgressHarness();
    return Effect.gen(function* () {
      const t = yield* startSlackTask(h, "end-fixed");
      yield* t.acknowledgedBy("fixed");
      yield* t.finish("Docker images take 41 GB.");
      assert.deepStrictEqual(h.calls, [{ operation: "remove", ts: t.ack.ts! }]);
      assert.strictEqual((yield* t.ofOperation("end"))[0]?.state, "delivered");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a fixed acknowledgement stays when the answer fails", () => {
    const h = makeProgressHarness();
    return Effect.gen(function* () {
      const t = yield* startSlackTask(h, "end-fixed-failed");
      yield* t.acknowledgedBy("fixed");
      h.postFailures.push(notSent("channel_not_found"));
      yield* t.finish("Docker images take 41 GB.");
      assert.deepStrictEqual(h.calls, []);
      assert.strictEqual((yield* t.ofOperation("end"))[0]?.state, "superseded");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a session line that is the whole answer is put back as it was, never deleted", () => {
    const h = makeProgressHarness();
    return Effect.gen(function* () {
      const t = yield* startSlackTask(h, "end-session");
      yield* t.acknowledgedBy("session");
      yield* t.milestone("Checking images.");
      yield* TestClock.adjust("15 seconds");
      yield* t.runtime.drain;
      yield* t.finish("");
      assert.deepStrictEqual(h.calls, [
        { operation: "edit", ts: t.ack.ts!, text: t.ack.text + "\n\nChecking images." },
        { operation: "edit", ts: t.ack.ts!, text: t.ack.text },
      ]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect.each(["unedited", "edited"] as const)(
    "a fallback acknowledgement of a turn that narrates nothing is never deleted: %s",
    (variant) => {
      const h = makeProgressHarness();
      return Effect.gen(function* () {
        const t = yield* startSlackTask(h, "end-fallback-" + variant);
        yield* t.acknowledgedBy("fallback");
        if (variant === "edited") {
          yield* t.milestone("Checking images.");
          yield* TestClock.adjust("15 seconds");
          yield* t.runtime.drain;
        }
        yield* t.finish("");
        assert.isFalse(h.calls.some((call) => call.operation === "remove"));
        assert.deepStrictEqual(
          h.calls.slice(variant === "edited" ? 1 : 0),
          variant === "edited" ? [{ operation: "edit", ts: t.ack.ts!, text: t.ack.text }] : [],
        );
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect("a check that lands after the answer does not stop the delete", () => {
    const h = makeProgressHarness();
    return Effect.gen(function* () {
      const t = yield* startSlackTask(h, "end-evidence");
      yield* t.acknowledgedBy("fixed");
      h.postFailures.push(notSent("rate_limited", 10));
      yield* t.finish("Docker images take 41 GB.");
      assert.deepStrictEqual(h.calls, []);
      const [terminal] = yield* t.sql<{ readonly event_id: string }>`SELECT event_id
        FROM channel_task_events WHERE task_id = ${t.task.taskId} AND type = 'task.completed'`;
      const key = "narration:" + terminal!.event_id + ":evidence";
      yield* t.sql`INSERT INTO channel_outbox ${t.sql.insert({
        delivery_id: key,
        cause_key: key,
        input_id: null,
        task_id: t.task.taskId,
        kind: "receipt",
        destination_kind: "slack",
        message_json: JSON.stringify({
          ...JSON.parse(t.ack.message_json),
          deliveryId: key,
          text: "Tests pass.",
          taskId: t.task.taskId,
        }),
        state: "pending",
        attempts: 0,
        next_attempt_at: "2999-01-01T00:00:00.000Z",
        created_at: "1970-01-01T00:00:00.000Z",
        updated_at: "1970-01-01T00:00:00.000Z",
      })}`;
      yield* TestClock.adjust("10 seconds");
      yield* t.runtime.drain;
      assert.deepStrictEqual(h.calls, [{ operation: "remove", ts: t.ack.ts! }]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect.each(["fixed", "reception reply"] as const)(
    "a completion that offers a skill proposal still ends the progress message: %s",
    (variant) => {
      const h = makeProgressHarness();
      return Effect.gen(function* () {
        const t = yield* startSlackTask(h, "end-proposal-" + (variant === "fixed" ? "f" : "r"));
        // The proposal task shares the request; it is not a second task of that request.
        const proposal = skillProposalTaskIdFor(t.task.taskId, t.task.generation);
        yield* t.copyTask(proposal);
        if (variant === "fixed") {
          yield* t.acknowledgedBy("fixed");
        } else {
          yield* t.milestone("Checking images.");
          yield* TestClock.adjust("15 seconds");
          yield* t.runtime.drain;
        }
        yield* t.finish("Docker images take 41 GB.");
        assert.deepStrictEqual(
          h.calls.at(-1),
          variant === "fixed"
            ? { operation: "remove", ts: t.ack.ts! }
            : { operation: "edit", ts: t.ack.ts!, text: t.ack.text },
        );
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect(
    "a failure held by a 429, then a retry that completes: the end waits for the newest answer, then deletes",
    () => {
      const h = makeProgressHarness();
      return Effect.gen(function* () {
        const t = yield* startSlackTask(h, "end-retry", "do: tidy the docs");
        yield* t.acknowledgedBy("fixed");
        h.postFailures.push(notSent("rate_limited", 30));
        yield* t.finish("The docs build broke.", "failed");
        const [end] = yield* t.ofOperation("end");
        assert.strictEqual(end?.state, "pending");
        const ledger = yield* ChannelLedger.ChannelLedger;
        const threads = yield* ChannelBotThreads.ChannelBotThreads;
        yield* threads.retry({ taskId: t.task.taskId, clientRequestId: "tap-1" }, owner);
        yield* t.runtime.drain;
        const retried = h.harness.world.launches[1]!.threadId;
        h.harness.world.setStatus(retried, 1, "completed", "Tidied.");
        yield* t.reports.reconcile(t.runtime.ownerToken);
        // The completion is recorded but not narrated yet; the end row must not read the failure.
        yield* TestClock.adjust("30 seconds");
        const worker = yield* ChannelDeliveryWorker.ChannelDeliveryWorker;
        yield* worker.deliverDue(t.runtime.ownerToken);
        yield* worker.settleReceipts;
        assert.strictEqual((yield* t.ofOperation("end"))[0]?.state, "pending");
        assert.deepStrictEqual(h.calls, []);
        yield* t.runtime.drain;
        assert.deepStrictEqual(h.calls, [{ operation: "remove", ts: t.ack.ts! }]);
        assert.strictEqual((yield* ledger.getTask(t.task.taskId))?.task.status, "completed");
      }).pipe(Effect.provide(h.layer));
    },
  );
});

describe("when there is no progress message to edit", () => {
  it.effect("an acknowledgement that may not have arrived gets no edits and no end", () => {
    const h = makeProgressHarness();
    return Effect.gen(function* () {
      const t = yield* startSlackTask(h, "none-ambiguous");
      yield* t.sql`UPDATE channel_outbox SET state = 'ambiguous' WHERE delivery_id = ${t.ack.delivery_id}`;
      yield* t.milestone("Checking images.");
      yield* TestClock.adjust("15 seconds");
      yield* t.finish("Docker images take 41 GB.");
      assert.deepStrictEqual(h.calls, []);
      assert.deepStrictEqual(yield* t.ofOperation("end"), []);
      assert.deepStrictEqual(yield* t.ofOperation("edit"), []);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a delivered acknowledgement without a Slack ts gets no edits and no end", () => {
    const h = makeProgressHarness();
    return Effect.gen(function* () {
      const t = yield* startSlackTask(h, "none-ts");
      yield* t.sql`UPDATE channel_outbox SET external_message_id = NULL
        WHERE delivery_id = ${t.ack.delivery_id}`;
      yield* t.milestone("Checking images.");
      yield* TestClock.adjust("15 seconds");
      yield* t.finish("Docker images take 41 GB.");
      assert.deepStrictEqual(h.calls, []);
      assert.deepStrictEqual(yield* t.ofOperation("end"), []);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("sibling tasks of one request never edit the reply they share", () => {
    const h = makeProgressHarness();
    return Effect.gen(function* () {
      const t = yield* startSlackTask(h, "none-siblings");
      const sibling = taskIdFor(t.task.originInputId, 1);
      yield* t.copyTask(sibling);
      yield* t.milestone("Checking images.");
      yield* TestClock.adjust("15 seconds");
      yield* t.finish("Docker images take 41 GB.");
      assert.deepStrictEqual(h.calls, []);
      assert.deepStrictEqual(yield* t.ofOperation("end"), []);
      const [milestone] = (yield* t.rows).filter((row) => textOf(row) === "Checking images.");
      assert.deepStrictEqual([milestone?.operation, milestone?.state], ["post", "superseded"]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect(
    "after its end, a task's later milestones are set aside and a second ending adds no end",
    () => {
      const h = makeProgressHarness();
      return Effect.gen(function* () {
        const t = yield* startSlackTask(h, "none-after-end");
        yield* t.acknowledgedBy("fixed");
        yield* t.finish("Docker images take 41 GB.");
        assert.lengthOf(h.calls, 1);
        const later = "narration:after-end:origin";
        yield* t.sql`INSERT INTO channel_outbox ${t.sql.insert({
          delivery_id: later,
          cause_key: later,
          input_id: null,
          task_id: t.task.taskId,
          kind: "receipt",
          destination_kind: "slack",
          message_json: JSON.stringify({
            ...JSON.parse(t.ack.message_json),
            deliveryId: later,
            text: "Retrying.",
            taskId: t.task.taskId,
            interim: true,
          }),
          state: "pending",
          attempts: 0,
          next_attempt_at: "1970-01-01T00:00:00.000Z",
          created_at: "1970-01-01T00:00:00.000Z",
          updated_at: "1970-01-01T00:00:00.000Z",
        })}`;
        yield* TestClock.adjust("60 seconds");
        yield* t.runtime.drain;
        assert.lengthOf(h.calls, 1);
        const [row] = (yield* t.rows).filter((candidate) => candidate.delivery_id === later);
        assert.deepStrictEqual([row?.operation, row?.state], ["post", "superseded"]);
        const ledger = yield* ChannelLedger.ChannelLedger;
        const [version] = yield* t.sql<{ readonly n: number }>`SELECT MAX(task_version) AS n
        FROM channel_task_events WHERE task_id = ${t.task.taskId}`;
        yield* t.sql`INSERT INTO channel_task_events (event_id, task_id, task_version, type, event_json,
        occurred_at, narration_state) VALUES ('second-end', ${t.task.taskId}, ${version!.n + 1},
        'task.completed', '{}', '1970-01-01T00:00:00.000Z', 'pending')`;
        const [pending] = yield* t.sql<{ readonly sequence: number }>`SELECT sequence
        FROM channel_task_events WHERE event_id = 'second-end'`;
        yield* ledger.completeNarration({
          owner: t.runtime.ownerToken,
          sequence: pending!.sequence,
          deliveries: [],
          now: DateTime.formatIso(yield* DateTime.now),
        });
        assert.lengthOf(yield* t.ofOperation("end"), 1);
      }).pipe(Effect.provide(h.layer));
    },
  );
});

describe("what an edit or end row looks like", () => {
  it.effect(
    "edit and end rows are interim receipts of the task with no input, and a 138-140 server sets them aside",
    () => {
      const h = makeProgressHarness();
      return Effect.gen(function* () {
        const t = yield* startSlackTask(h, "shape");
        yield* t.acknowledgedBy("fixed");
        yield* t.milestone("Checking images.");
        h.postFailures.push(notSent("rate_limited", 30));
        yield* t.finish("Docker images take 41 GB.");
        const [edit] = yield* t.ofOperation("edit");
        const [end] = yield* t.ofOperation("end");
        for (const row of [edit!, end!]) {
          assert.deepStrictEqual(
            [row.kind, row.task_id, row.destination_kind, row.input_id, row.target_delivery_id],
            ["receipt", t.task.taskId, "slack", null, t.ack.delivery_id],
          );
          const message = decode(row.message_json);
          assert.strictEqual(message.interim, true);
          assert.isTrue(yield* isInterimMessage(t.sql, row, message));
          assert.isTrue(yield* interimAlreadyHeard(t.sql, row));
        }
        assert.strictEqual(textOf(edit!), "Checking images.");
        assert.strictEqual(textOf(end!), "");
        assert.isUndefined(decode(end!.message_json).mentionActorId);
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect(
    "the answer, questions, approvals, sign-in, failures and refusals are always new posts",
    () => {
      const h = makeProgressHarness();
      return Effect.gen(function* () {
        const t = yield* startSlackTask(h, "posts-only");
        yield* t.milestone("Checking images.");
        const base = JSON.parse(t.ack.message_json);
        const rows = [
          ["answer", "result", "Docker images take 41 GB.", undefined],
          ["question", "question", "Delete the old images?", undefined],
          ["approval:r1", "question", "Approve rm -rf images?", ["Approve", "Deny"]],
          ["sign-in", "failure", CHANNEL_COPY.auth, undefined],
          ["failure", "failure", "Couldn't finish: Look into it: disk", undefined],
          [
            "refusal",
            "receipt",
            "That task isn't available here. Send it in the main chat.",
            undefined,
          ],
        ] as const;
        for (const [key, kind, text, options] of rows) {
          yield* t.sql`INSERT INTO channel_outbox ${t.sql.insert({
            delivery_id: key,
            cause_key: "test:" + key,
            input_id: null,
            task_id: t.task.taskId,
            kind,
            destination_kind: "slack",
            message_json: JSON.stringify({
              ...base,
              deliveryId: key,
              kind,
              text,
              taskId: t.task.taskId,
              ...(options === undefined ? {} : { options }),
            }),
            state: "pending",
            attempts: 0,
            next_attempt_at: "1970-01-01T00:00:00.000Z",
            created_at: "1970-01-01T00:00:00.000Z",
            updated_at: "1970-01-01T00:00:00.000Z",
          })}`;
        }
        yield* TestClock.adjust("60 seconds");
        yield* t.runtime.drain;
        const sent = new Set(h.posts.map((message) => message.text));
        const all = yield* t.rows;
        for (const [key, , text] of rows) {
          assert.isTrue(sent.has(text), key);
          const row = all.find((candidate) => candidate.delivery_id === key);
          assert.deepStrictEqual([row?.operation, row?.state], ["post", "delivered"], key);
          assert.isFalse(
            h.calls.some((call) => (call.text ?? "").includes(text)),
            key,
          );
        }
        assert.isTrue(
          all.filter((row) => row.operation !== "post").every((row) => row.kind === "receipt"),
        );
      }).pipe(Effect.provide(h.layer));
    },
  );
});
