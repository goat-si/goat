import { answer, database, fixture, report } from "./RemoteDispatchCoordinator.testkit.ts";
import { assert, it } from "@effect/vitest";
import { ThreadId, type RemoteRelaySend, type RemoteReport } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";

import * as Coordinator from "./RemoteDispatchCoordinator.ts";

const sibling = {
  host: "juns-macbook-pro",
  threadId: ThreadId.make("merge-manager"),
  message: "PR #48 is open.",
  capabilities: ["browser"],
} as const;
const relayReport = (sequence: number, relay: RemoteRelaySend): RemoteReport => ({
  ...report(sequence),
  summary: "relay",
  relay,
});

it.effect(
  "reuses a relayed client request after the review finishes and refuses a new request",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const owner = ThreadId.make("review-retry-owner");
      yield* Effect.gen(function* () {
        const c = yield* Coordinator.RemoteDispatchCoordinator;
        yield* f.launch(c, "next_turn");
        yield* Queue.take(f.calls);
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* f.sql`INSERT INTO remote_dispatches
      (correlation_id, kind, origin_thread_id, host, remote_thread_id, read_key, delivery, state, task_id, parent_run_id, created_at, updated_at)
      VALUES ('review-retry-target', 'task', ${owner}, ${sibling.host}, ${sibling.threadId}, 'key', 'wake', 'running', 'review-task', 'review-run', ${now}, ${now})`;
        const request = { ...sibling, clientRequestId: "lost-relay-response" };
        yield* f.replyLatest(Effect.succeed(answer([relayReport(1, request)])));
        const send = yield* Queue.take(f.calls);
        assert.equal(send.call.tool, "goat_thread_send");
        yield* f.replyLatest(
          Effect.succeed({
            threadId: sibling.threadId,
            messageId: "message-1",
            runId: "sibling-run",
            status: "running",
            delivery: "steered",
          }),
        );
        yield* Queue.take(f.commits);
        assert.equal((yield* Queue.take(f.calls)).call.tool, "goat_origin_reports_wait");
        f.refusedReviews.set(sibling.threadId, owner);
        yield* f.replyLatest(Effect.succeed(answer([relayReport(2, request)])));
        yield* Queue.take(f.commits);
        assert.equal((yield* Queue.take(f.calls)).call.tool, "goat_origin_reports_wait");
        const inbox = yield* f.sql<{
          text: string;
        }>`SELECT text FROM remote_report_inbox ORDER BY id`;
        assert.lengthOf(inbox, 2);
        assert.include(inbox[1]!.text, 'Delivered: steered, run "sibling-run".');
        yield* f.replyLatest(
          Effect.succeed(
            answer([relayReport(3, { ...request, clientRequestId: "new-review-send" })]),
          ),
        );
        yield* Queue.take(f.commits);
        assert.equal((yield* Queue.take(f.calls)).call.tool, "goat_origin_reports_wait");
        const refused = yield* f.sql<{
          text: string;
        }>`SELECT text FROM remote_report_inbox ORDER BY id DESC LIMIT 1`;
        assert.include(refused[0]!.text, "goat_task_create");
        assert.lengthOf(f.rearms, 1);
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(database)),
);
