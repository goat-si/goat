import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  CHANNEL_GATEWAY_WS_METHODS,
  BotId,
  ChannelTaskId,
  EnvironmentId,
  ThreadId,
} from "@goat/contracts";
import { authorizeRpcCall } from "../auth/RpcAuthorization.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import { makeThreadFollowService } from "./channelThreadFollowService.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import { makeThreadFollows } from "./channelThreadFollows.ts";
import {
  makeHarness,
  botThreadId,
  ownerId,
  owner,
  environmentId,
  scratchProjectId,
  goatInput,
  rpcContext,
  setupBot,
} from "./testkit/ChannelHarness.ts";

const follow = {
  ownerId,
  botId: BotId.make("scout"),
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  taskId: ChannelTaskId.make("task"),
  sessionId: AuthSessionId.make("session"),
  principalId: "person",
};

const seedSessionFor = (principalId: string) =>
  Effect.gen(function* () {
    const sessions = yield* AuthSessions.make;
    const now = yield* DateTime.now;
    yield* sessions.create({
      sessionId: follow.sessionId,
      subject: principalId,
      scopes: ["orchestration:read", "orchestration:operate"],
      method: "bearer-access-token",
      principalKind: "person",
      client: {
        label: null,
        ipAddress: null,
        userAgent: null,
        deviceType: "unknown",
        os: null,
        browser: null,
      },
      issuedAt: now,
      expiresAt: DateTime.add(now, { hours: 1 }),
    });
    return sessions;
  });

const seedSession = seedSessionFor(follow.principalId);

it.effect("keeps the original follow and reports concurrent observations once", () =>
  Effect.gen(function* () {
    const follows = yield* makeThreadFollows();
    yield* seedSession;
    assert.isTrue(yield* follows.start(follow));
    assert.isFalse(yield* follows.start({ ...follow, taskId: ChannelTaskId.make("other") }));
    const notices: string[] = [];
    const settle = follows.settle(
      follow,
      (record) => Effect.succeed("Ended: " + record.taskId),
      (_, text) => Effect.sync(() => void notices.push(text)),
    );
    yield* Effect.all([settle, settle], { concurrency: "unbounded" });
    assert.deepEqual(notices, ["Ended: task"]);
  }).pipe(Effect.provide(makeHarness().layer)),
);

it.effect("records access loss once and cancels further observations", () =>
  Effect.gen(function* () {
    const follows = yield* makeThreadFollows();
    const sessions = yield* seedSession;
    yield* follows.start(follow);
    const notices: string[] = [];
    const settle = follows.settle(
      follow,
      () => Effect.succeed("Private thread status"),
      (_, text) => Effect.sync(() => void notices.push(text)),
    );
    yield* sessions.revoke({ sessionId: follow.sessionId, revokedAt: yield* DateTime.now });
    yield* settle;
    yield* settle;
    assert.deepEqual(notices, ["Stopped following because the approving session lost access."]);
    assert.include(yield* Effect.flip(follows.start(follow)), { reason: "forbidden" });
    yield* follows.stop(follow);
    yield* settle;
    assert.lengthOf(notices, 1);
  }).pipe(Effect.provide(makeHarness().layer)),
);

it.effect("stopping removes the relationship and prevents further observation", () =>
  Effect.gen(function* () {
    yield* seedSession;
    const follows = yield* makeThreadFollows();
    assert.isTrue(yield* follows.start(follow));
    yield* follows.stop(follow);
    yield* follows.settle(
      follow,
      () => Effect.die("A stopped follow must not read the source thread"),
      () => Effect.die("A stopped follow must not write to chat"),
    );
    assert.isTrue(yield* follows.start(follow));
  }).pipe(Effect.provide(makeHarness().layer)),
);

it.effect("lists only readable follows for the selected bot without exposing credentials", () =>
  Effect.gen(function* () {
    const follows = yield* makeThreadFollows();
    const sessions = yield* seedSession;
    yield* follows.start(follow);
    assert.deepEqual(yield* follows.list(ownerId, follow.botId), [
      {
        environmentId: follow.environmentId,
        threadId: follow.threadId,
        taskId: follow.taskId,
      },
    ]);
    assert.deepEqual(yield* follows.list(ownerId, BotId.make("other")), []);
    yield* sessions.revoke({ sessionId: follow.sessionId, revokedAt: yield* DateTime.now });
    assert.deepEqual(yield* follows.list(ownerId, follow.botId), []);
  }).pipe(Effect.provide(makeHarness().layer)),
);

const setupFollow = Effect.fn("ChannelThreadFollows.test.setup")(function* () {
  yield* setupBot;
  yield* seedSessionFor(owner.principalId);
  const gateway = yield* ChannelGateway.ChannelGateway;
  const runtime = yield* ChannelRuntime.ChannelRuntime;
  const ledger = yield* ChannelLedger.ChannelLedger;
  const sql = yield* SqlClient.SqlClient;
  yield* gateway.ingest(goatInput("do: prepare a release", "follow-task"), rpcContext);
  yield* runtime.drain;
  const [task] = (yield* ledger.listTasks({ ownerId, limit: 1 })).tasks;
  if (task === undefined) return yield* Effect.die("Missing bot task");
  const now = DateTime.formatIso(yield* DateTime.now);
  const threadId = ThreadId.make("release-source");
  const pr = "https://github.com/example/project/pull/42";
  const payload = JSON.stringify({ pullRequests: [{ url: pr }] });
  yield* sql`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES (${threadId}, ${scratchProjectId}, 'Release source', 'codex', 'full-access', 'default', ${now}, ${now}, ${payload})`;
  const service = yield* makeThreadFollowService(ledger);
  const rpc = service.rpcHandlers(owner, environmentId, follow.sessionId);
  const input = { botId: BotId.make("main"), environmentId, threadId, taskId: task.taskId };
  const start = rpc[CHANNEL_GATEWAY_WS_METHODS.followThread](input);
  const stop = rpc[CHANNEL_GATEWAY_WS_METHODS.stopFollowingThread](input);
  const run = (id: string, ordinal: number) => sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES (${id}, ${threadId}, ${ordinal}, 'codex', 'running', ${now}, '{}')
    `;
  const complete = sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed', completed_at = ${now}
        WHERE run_id = 'release-run'`;
      const event = JSON.stringify({ id: "release-run", status: "completed", completedAt: now });
      yield* sql`INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
         actor_kind, payload_json, metadata_json, application_event_version)
        VALUES ('release-run-ended', 'thread', ${threadId}, 1, 'run.updated', ${now},
                'server', ${event}, '{}', 2)`;
    }),
  );
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const notices = Effect.map(orchestrator.getThreadRecords(botThreadId, ["messages"]), (bot) =>
    bot.messages.filter((message) => message.role === "assistant" && message.text.includes(pr)),
  );
  return { start, stop, run, complete, notices, runtime, service, rpc, input, sql, threadId, pr };
});

it.effect.each(["stop", "re-follow"] as const)("drops queued notices after %s", (action) =>
  Effect.gen(function* () {
    const { start, stop, run, runtime, notices } = yield* setupFollow();
    const restart = action === "re-follow";
    yield* start;
    yield* stop;
    if (restart) {
      yield* run("new-run", 1);
      yield* start;
    }
    yield* runtime.drain;
    const delivered = yield* notices;
    assert.lengthOf(delivered, restart ? 1 : 0);
    if (restart) assert.include(delivered[0]?.text, "Run new-run.");
  }).pipe(Effect.provide(makeHarness().layer)),
);

it.effect("reports the ending of a run superseded between passes once", () =>
  Effect.gen(function* () {
    const { start, run, complete, service, runtime, notices } = yield* setupFollow();
    yield* start;
    yield* run("release-run", 1);
    yield* service.reconcile();
    yield* complete;
    yield* run("next-run", 2);
    yield* service.reconcile();
    yield* runtime.drain;
    const endings = notices.pipe(
      Effect.map((messages) =>
        messages.filter(
          ({ text }) => text.includes("is completed.") && text.includes("Run release-run."),
        ),
      ),
    );
    assert.lengthOf(yield* endings, 1);
    yield* service.reconcile();
    yield* runtime.drain;
    assert.lengthOf(yield* endings, 1);
  }).pipe(Effect.provide(makeHarness().layer)),
);

it.effect("reports a persisted ending racing follow creation once", () =>
  Effect.gen(function* () {
    const { start, run, complete, service, runtime, notices } = yield* setupFollow();
    yield* run("release-run", 1);
    yield* Effect.all([start, complete], { concurrency: "unbounded" });
    yield* service.reconcile();
    yield* runtime.drain;
    assert.lengthOf(
      (yield* notices).filter(({ text }) => text.includes("is completed.")),
      1,
    );
  }).pipe(Effect.provide(makeHarness().layer)),
);

it.effect("queues one observation of an already ended thread and lists its PR until stopped", () =>
  Effect.gen(function* () {
    const { run, complete, runtime, service, rpc, input, sql, threadId, pr } = yield* setupFollow();
    yield* run("release-run", 1);
    yield* complete;
    const wrongEnvironment = yield* Effect.flip(
      rpc[CHANNEL_GATEWAY_WS_METHODS.followThread]({
        ...input,
        environmentId: follow.environmentId,
      }),
    );
    assert.strictEqual(wrongEnvironment.reason, "cross_environment_follow");
    assert.isTrue(yield* rpc[CHANNEL_GATEWAY_WS_METHODS.followThread](input));
    assert.isFalse(yield* rpc[CHANNEL_GATEWAY_WS_METHODS.followThread](input));
    yield* service.reconcile();
    const listed = yield* rpc[CHANNEL_GATEWAY_WS_METHODS.listFollowedThreads](input);
    assert.deepEqual(listed.followedThreads, [
      {
        environmentId,
        threadId,
        taskId: input.taskId,
        status: "completed",
        pullRequest: pr,
      },
    ]);
    const notices = yield* sql<{
      cause_key: string;
    }>`SELECT cause_key FROM channel_outbox WHERE cause_key LIKE 'follow:%'`;
    assert.lengthOf(notices, 1);
    yield* runtime.drain;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const bot = yield* orchestrator.getThreadRecords(botThreadId, ["messages"]);
    assert.lengthOf(
      bot.messages.filter((message) => message.role === "assistant" && message.text.includes(pr)),
      1,
    );
    yield* rpc[CHANNEL_GATEWAY_WS_METHODS.stopFollowingThread](input);
    assert.deepEqual(
      (yield* rpc[CHANNEL_GATEWAY_WS_METHODS.listFollowedThreads](input)).followedThreads,
      [],
    );
    assert.lengthOf(
      yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId} AND deleted_at IS NULL`,
      1,
    );
  }).pipe(Effect.provide(makeHarness().layer)),
);

it.effect("requires read for listing and operate for follow mutations", () =>
  Effect.gen(function* () {
    for (const [method, scope] of [
      [CHANNEL_GATEWAY_WS_METHODS.listFollowedThreads, "orchestration:read"],
      [CHANNEL_GATEWAY_WS_METHODS.followThread, "orchestration:operate"],
      [CHANNEL_GATEWAY_WS_METHODS.stopFollowingThread, "orchestration:operate"],
    ] as const) {
      const denied = yield* Effect.flip(authorizeRpcCall([], method, {}));
      assert.strictEqual(denied.requiredPermission, scope);
      yield* authorizeRpcCall([scope], method, {});
    }
  }),
);
