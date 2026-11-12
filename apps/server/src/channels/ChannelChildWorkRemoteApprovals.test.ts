import { assert, describe, it } from "@effect/vitest";
import {
  ChannelChildWorkId,
  ChannelWorkerObservation,
  RuntimeRequestId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ChildStore from "./channelChildWorkStore.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import {
  botMessages,
  goatInput,
  makeHarness,
  onlyTask,
  ownerId,
  rpcContext,
  setupBot,
} from "./testkit/ChannelHarness.ts";

const since = "2026-10-12T00:01:00.000Z";

const cards = Effect.map(
  botMessages,
  (records) => records.messages.filter((message) => message.channel?.kind === "question").length,
);

const encodeObservation = Schema.encodeSync(Schema.fromJsonString(ChannelWorkerObservation));
const sshHost = "mac-studio";
const sshThread = ThreadId.make("thread:remote");
const sshApprovalId = RuntimeRequestId.make("approval:ssh");

const sshObservation = {
  pullRequests: [],
  needsYou: [
    {
      kind: "approval" as const,
      since,
      approval: { requestId: sshApprovalId, threadId: sshThread },
    },
  ],
};

const admitSsh = Effect.fn(function* (
  task: { readonly taskId: string; readonly generation: number },
  id: string,
  state: "bound" | "completed",
) {
  const admitted = yield* (yield* ChildStore.ChannelChildWorkStore).admitReserved(
    {
      ownerId,
      taskId: task.taskId as never,
      childWorkId: ChannelChildWorkId.make(id),
      generation: task.generation,
      callerThreadId: ThreadId.make("thread:caller"),
      requestKey: id,
      promptDigest: "digest",
      surface: "ssh_thread_launch",
      destination: { correlationId: "corr:" + id, host: sshHost },
      state,
      createdAt: since,
      updatedAt: since,
    },
    100,
  );
  assert.strictEqual(admitted._tag, "admitted");
});

const insertThreadDispatch = (id: string, observation: typeof sshObservation | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO remote_dispatches (
      correlation_id, kind, origin_thread_id, host, remote_thread_id, launched_run_id, read_key,
      delivery, reports_supported, state, observation, created_at, updated_at
    ) VALUES (
      ${"corr:" + id}, 'thread', ${"thread:origin"}, ${sshHost}, ${sshThread},
      ${"run:remote"}, ${"read-key-" + id}, 'wake', 1, 'running',
      ${observation === null ? null : encodeObservation(observation)}, ${since}, ${since}
    )`;
  });

const stampedSshApproval = {
  kind: "approval" as const,
  since,
  approval: { requestId: sshApprovalId, threadId: sshThread, host: sshHost },
};

describe("GOAT Bot reads an approval from a thread launched on another machine", () => {
  it.effect("shows an approval an ssh-launched thread asks for after the task finished", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* gateway.ingest(goatInput("do: write the release notes", "ssh-late"), rpcContext);
      yield* runtime.drain;
      const task = yield* onlyTask;
      yield* admitSsh(task, "late", "completed");
      harness.world.setStatus(task.worker!.threadId, 1, "completed", "Started the notes thread.");
      yield* runtime.drain;
      assert.strictEqual((yield* onlyTask).status, "completed");
      const cardsBefore = yield* cards;
      yield* insertThreadDispatch("late", sshObservation);
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      const finished = yield* onlyTask;
      assert.strictEqual(finished.status, "completed");
      assert.deepStrictEqual(finished.observed?.needsYou, [stampedSshApproval]);
      assert.strictEqual(yield* cards, cardsBefore + 1);
      const version = finished.version;
      yield* reports.reconcile(runtime.ownerToken);
      assert.strictEqual((yield* onlyTask).version, version);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("says once that the approval on that machine is no longer waiting", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* gateway.ingest(goatInput("do: write the release notes", "ssh-gone"), rpcContext);
      yield* runtime.drain;
      const task = yield* onlyTask;
      yield* admitSsh(task, "gone", "completed");
      harness.world.setStatus(task.worker!.threadId, 1, "completed", "Started the notes thread.");
      yield* runtime.drain;
      yield* insertThreadDispatch("gone", sshObservation);
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE remote_dispatches SET observation = ${encodeObservation({
        pullRequests: [],
        needsYou: [],
      })} WHERE correlation_id = ${"corr:gone"}`;
      yield* reports.reconcile(runtime.ownerToken);
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      const told = (yield* botMessages).messages.filter((message) =>
        message.text.includes("no longer waiting"),
      );
      assert.strictEqual(told.length, 1);
      assert.strictEqual(
        told[0]?.text,
        "The approval on mac-studio is no longer waiting in the coding thread. write the release notes continues if it was approved.",
      );
      assert.deepStrictEqual((yield* onlyTask).observed?.needsYou, []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps a shown ssh approval when the dispatch has no observation", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* gateway.ingest(goatInput("do: write the release notes", "ssh-keep"), rpcContext);
      yield* runtime.drain;
      const task = yield* onlyTask;
      yield* admitSsh(task, "keep", "completed");
      harness.world.setStatus(task.worker!.threadId, 1, "completed", "Started the notes thread.");
      yield* runtime.drain;
      yield* insertThreadDispatch("keep", sshObservation);
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      const shown = (yield* onlyTask).observed?.needsYou;
      assert.deepStrictEqual(shown, [stampedSshApproval]);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE remote_dispatches SET observation = NULL WHERE correlation_id = ${"corr:keep"}`;
      yield* reports.reconcile(runtime.ownerToken);
      assert.deepStrictEqual((yield* onlyTask).observed?.needsYou, shown);
      yield* sql`UPDATE remote_dispatches SET reports_supported = 0, observation = ${encodeObservation(
        {
          pullRequests: [],
          needsYou: [],
        },
      )} WHERE correlation_id = ${"corr:keep"}`;
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      assert.deepStrictEqual((yield* onlyTask).observed?.needsYou, shown);
      const told = (yield* botMessages).messages.filter((message) =>
        message.text.includes("no longer waiting"),
      );
      assert.strictEqual(told.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("shows an approval an ssh-launched thread asks for while the task is running", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* gateway.ingest(goatInput("do: write the release notes", "ssh-run"), rpcContext);
      yield* runtime.drain;
      const task = yield* onlyTask;
      yield* admitSsh(task, "run", "bound");
      yield* insertThreadDispatch("run", sshObservation);
      const cardsBefore = yield* cards;
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      const running = yield* onlyTask;
      assert.strictEqual(running.status, "running");
      assert.deepStrictEqual(running.observed?.needsYou, [stampedSshApproval]);
      assert.strictEqual(yield* cards, cardsBefore + 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("drops a shown ssh approval once that thread's delete is recorded", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* gateway.ingest(goatInput("do: write the release notes", "ssh-del"), rpcContext);
      yield* runtime.drain;
      const task = yield* onlyTask;
      yield* admitSsh(task, "del", "completed");
      harness.world.setStatus(task.worker!.threadId, 1, "completed", "Started the notes thread.");
      yield* runtime.drain;
      yield* insertThreadDispatch("del", sshObservation);
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      assert.deepStrictEqual((yield* onlyTask).observed?.needsYou, [stampedSshApproval]);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE remote_dispatches SET delete_requested_at = ${since}
        WHERE correlation_id = ${"corr:del"}`;
      yield* reports.reconcile(runtime.ownerToken);
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      const told = (yield* botMessages).messages.filter((message) =>
        message.text.includes("no longer waiting"),
      );
      assert.strictEqual(told.length, 1);
      assert.deepStrictEqual((yield* onlyTask).observed?.needsYou, []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("drops a running task's ssh approval once that thread's delete is recorded", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* gateway.ingest(goatInput("do: write the release notes", "ssh-del-run"), rpcContext);
      yield* runtime.drain;
      const task = yield* onlyTask;
      yield* admitSsh(task, "del-run", "bound");
      yield* insertThreadDispatch("del-run", sshObservation);
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      assert.strictEqual((yield* onlyTask).status, "running");
      assert.deepStrictEqual((yield* onlyTask).observed?.needsYou, [stampedSshApproval]);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE remote_dispatches SET delete_requested_at = ${since}
        WHERE correlation_id = ${"corr:del-run"}`;
      yield* reports.reconcile(runtime.ownerToken);
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      const told = (yield* botMessages).messages.filter((message) =>
        message.text.includes("no longer waiting"),
      );
      assert.strictEqual(told.length, 1);
      assert.strictEqual((yield* onlyTask).status, "running");
      assert.deepStrictEqual((yield* onlyTask).observed?.needsYou, []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "drops an ssh approval once GOAT stops following its host, and shows it again on recovery",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
        yield* gateway.ingest(goatInput("do: write the release notes", "ssh-gone"), rpcContext);
        yield* runtime.drain;
        const task = yield* onlyTask;
        yield* admitSsh(task, "gone", "bound");
        yield* insertThreadDispatch("gone", sshObservation);
        yield* reports.reconcile(runtime.ownerToken);
        yield* runtime.drain;
        assert.deepStrictEqual((yield* onlyTask).observed?.needsYou, [stampedSshApproval]);
        const sql = yield* SqlClient.SqlClient;
        for (const ended of [
          sql`UPDATE remote_dispatches SET state = 'lost', end_reason = 'host_unreachable',
          ended_at = ${since} WHERE correlation_id = ${"corr:gone"}`,
          sql`UPDATE remote_dispatches SET state = 'cancelled', end_reason = 'dismissed',
          ended_at = ${since} WHERE correlation_id = ${"corr:gone"}`,
        ]) {
          yield* ended;
          yield* reports.reconcile(runtime.ownerToken);
          yield* runtime.drain;
          assert.deepStrictEqual((yield* onlyTask).observed?.needsYou, []);
          // The host answered again: its observation counts once more.
          yield* sql`UPDATE remote_dispatches SET state = 'running', end_reason = NULL, ended_at = NULL
          WHERE correlation_id = ${"corr:gone"}`;
          yield* reports.reconcile(runtime.ownerToken);
          yield* runtime.drain;
          assert.deepStrictEqual((yield* onlyTask).observed?.needsYou, [stampedSshApproval]);
        }
      }).pipe(Effect.provide(harness.layer));
    },
  );
});
