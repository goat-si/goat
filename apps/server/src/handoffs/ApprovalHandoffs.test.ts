import { ChannelTask, CommandId, EnvironmentId, MessageId, RunId, ThreadId } from "@goat/contracts";
import * as SqlClient from "effect/sql/SqlClient";
import { openApprovalHandoffs } from "../goatclaw/openApprovalHandoffs.ts";
import { readBotAttention } from "../channels/channelBotAttention.ts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { sessionStore } from "../channels/channelBotSessionRuns.ts";
import { writeChannelTaskEvent } from "../channels/channelTaskEventCommit.ts";
import { applyChannelTaskEvent } from "../channels/channelTaskTransitions.ts";
import { makeTaskEvent } from "../channels/channelTaskWrites.ts";
import { insertTask } from "../channels/testkit/botThreadHistory.fixture.ts";
import { ownerId } from "../channels/testkit/ChannelHarness.ts";
import type * as ApprovalHandoffs from "./ApprovalHandoffs.ts";
import { instanceId, person, threadId, withApprovals } from "./ApprovalHandoffs.testkit.ts";

const targetPath = "hub.device_join";
const binding = { binding: "goat-hub-binding: join lidge-ts SHA256:key" };

const ask = (approvals: ApprovalHandoffs.ApprovalHandoffs["Service"], worker = threadId) =>
  Effect.gen(function* () {
    return yield* approvals.request({
      threadId: worker,
      providerInstanceId: instanceId,
      targetPath,
      title: "Join lidge-ts to the hub",
      reason: "GOAT has no pinned host key for this alias.",
      location: "Approving links lidge-ts as a Remote Link Child.",
      binding,
      expiresAt: DateTime.add(yield* DateTime.now, { hours: 1 }),
    });
  });

const environmentId = EnvironmentId.make("origin");
const decodeTask = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelTask));
const workerTask = (id: string, status: "dispatching" | "running") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`INSERT OR IGNORE INTO channel_conversations
      (conversation_id, owner_id, kind, connection_id, conversation_key, last_activity_at)
      VALUES ('conv:bot', ${ownerId}, 'goat', 'connection', 'key', ${now})`;
    yield* insertTask(id, { status, createdAt: now });
    const [row] = yield* sql<{
      task_json: string;
    }>`SELECT task_json FROM channel_tasks WHERE task_id = ${id}`;
    return decodeTask(row!.task_json);
  });

const bind = (task: ChannelTask, worker: ThreadId, runId: RunId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const event = makeTaskEvent(
      task,
      {
        type: "task.worker.bound",
        payload: {
          worker: { environmentId, threadId: worker, runId, generation: task.generation },
        },
      },
      DateTime.formatIso(yield* DateTime.now),
    );
    const transition = applyChannelTaskEvent(task, event);
    if (!transition.ok) throw new Error(transition.reason);
    yield* sql.withTransaction(
      writeChannelTaskEvent(sql, { expectedVersion: task.version, event, next: transition.task }),
    );
    return transition.task;
  });

const readApprovals = () =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    readBotAttention(sql, {
      ownerId,
      environmentId,
      mode: "needs_you",
      request: { cursor: 0 },
      resolveName: () => Effect.succeed("Scout"),
    }),
  );

it.effect("reconciles an approval raised before worker binding only when its run binds", () => {
  const worker = ThreadId.make("channel-worker:before-bind");
  return withApprovals(
    ({ approvals, orchestrator }) =>
      Effect.gen(function* () {
        const task = yield* workerTask("task:before-bind", "dispatching");
        const [run] = (yield* orchestrator.getThreadRecords(worker, ["runs"])).runs;
        const handoff = yield* ask(approvals, worker);
        expect((yield* readApprovals()).events).toEqual([]);

        const bound = yield* bind(task, worker, RunId.make("unrelated-run"));
        expect((yield* readApprovals()).events).toEqual([]);
        const exact = yield* bind(bound, worker, run!.id);
        yield* bind(exact, worker, run!.id);
        expect((yield* readApprovals()).events).toMatchObject([
          {
            kind: "approval",
            taskId: task.taskId,
            generation: task.generation,
            request: { kind: "handoff", threadId: worker, requestId: handoff.handoffId },
          },
        ]);
      }),
    { threadId: worker },
  );
});

it.effect("keeps a cleared shared-session approval alert on the task that owns its run", () => {
  const worker = ThreadId.make("goat-bot-session:shared");
  return withApprovals(
    ({ approvals, handoffs, orchestrator }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [run] = (yield* orchestrator.getThreadRecords(worker, ["runs"])).runs;
        const a = yield* workerTask("task:a", "running");
        yield* sessionStore(sql).writeIntent(worker, run!.userMessageId, a, "task");
        yield* bind(a, worker, run!.id);

        yield* TestClock.adjust("1 second");
        const b = yield* workerTask("task:b", "running");
        const messageId = MessageId.make("message:task-b");
        yield* sessionStore(sql).writeIntent(worker, messageId, b, "task");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("start-task-b"),
          threadId: worker,
          messageId,
          text: "Work on task B",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "server",
        });
        const other = (yield* orchestrator.getThreadRecords(worker, ["runs"])).runs.find(
          (candidate) => candidate.userMessageId === messageId,
        );
        yield* bind(b, worker, other!.id);
        const handoff = yield* ask(approvals, worker);
        yield* handoffs.respond(
          { threadId: worker, handoffId: handoff.handoffId, action: "declined" },
          person,
        );
        expect((yield* openApprovalHandoffs()).handoffs).toEqual([]);
        expect((yield* readApprovals()).events).toMatchObject([
          {
            kind: "approval",
            taskId: a.taskId,
            generation: a.generation,
            request: { kind: "handoff", threadId: worker, requestId: handoff.handoffId },
          },
        ]);
      }),
    { threadId: worker },
  );
});

it.effect("a person's approval covers exactly the change it was asked for, until it expires", () =>
  withApprovals(({ approvals, handoffs }) =>
    Effect.gen(function* () {
      const summary = yield* ask(approvals);
      const check = (input: { readonly targetPath?: string; readonly binding?: object }) =>
        approvals
          .verify({
            threadId,
            handoffId: summary.handoffId,
            targetPath: input.targetPath ?? targetPath,
            binding: { ...(input.binding ?? binding) },
          })
          .pipe(Effect.match({ onFailure: (error) => error.message, onSuccess: () => "approved" }));
      expect(yield* check({})).toContain("still open");
      expect((yield* openApprovalHandoffs()).handoffs[0]?.botAttentionOwned).toBeUndefined();
      yield* handoffs.respond(
        { threadId, handoffId: summary.handoffId, action: "completed" },
        person,
      );
      expect(yield* check({})).toBe("approved");
      expect(
        yield* check({ binding: { binding: "goat-hub-binding: join lidge-ts SHA256:other" } }),
      ).toContain("does not cover");
      expect(yield* check({ targetPath: "hub.device_leave" })).toContain("does not cover");
      yield* TestClock.adjust("2 hours");
      expect(yield* check({})).toContain("expired");
    }),
  ),
);

it.effect("a declined approval approves nothing", () =>
  withApprovals(({ approvals, handoffs }) =>
    Effect.gen(function* () {
      const summary = yield* ask(approvals);
      yield* handoffs.respond(
        { threadId, handoffId: summary.handoffId, action: "declined" },
        person,
      );
      const result = yield* approvals
        .verify({ threadId, handoffId: summary.handoffId, targetPath, binding })
        .pipe(Effect.flip);
      expect(result.message).toContain("was not given");
    }),
  ),
);

it.effect.each(["needs_you", "off"] as const)(
  "a worker handoff is the only attention event in %s mode",
  (mode) =>
    withApprovals(({ approvals }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const now = DateTime.formatIso(yield* DateTime.now);
        const environmentId = EnvironmentId.make("origin");
        yield* sql`INSERT INTO channel_conversations
          (conversation_id, owner_id, kind, connection_id, conversation_key, last_activity_at)
          VALUES ('conversation', 'owner', 'goat', 'connection', 'key', ${now})`;
        yield* sql`INSERT INTO channel_tasks
          (task_id, owner_id, conversation_id, status, version, generation, worker_thread_id,
           task_json, created_at, updated_at)
          VALUES ('task', 'owner', 'conversation', 'running', 2, 1, ${threadId},
           ${JSON.stringify({ worker: { threadId, environmentId } })}, ${now}, ${now})`;
        const handoff = yield* ask(approvals);
        const read = (ownerId: string) =>
          readBotAttention(sql, {
            ownerId,
            environmentId,
            mode,
            request: { cursor: 0 },
            resolveName: () => Effect.succeed("Scout"),
          });
        const page = yield* read("owner");
        expect(page.mode).toBe(mode);
        expect((yield* openApprovalHandoffs()).handoffs).toMatchObject([
          { handoff: { handoffId: handoff.handoffId }, botAttentionOwned: true },
        ]);
        expect(page.events).toMatchObject([
          {
            kind: "approval",
            taskId: "task",
            requestId: handoff.handoffId,
            request: { kind: "handoff", threadId, requestId: handoff.handoffId },
          },
        ]);
        expect((yield* read("another-owner")).events).toEqual([]);
      }),
    ),
);
