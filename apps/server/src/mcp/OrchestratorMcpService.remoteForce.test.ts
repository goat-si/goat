import { assert, it } from "@effect/vitest";
import type { SshRemoteDispatchError } from "../sshRemote/SshRemoteDispatch.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";

import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import {
  catalog,
  database,
  fixture,
  input,
  remoteRunId,
  remoteThreadId,
  scope,
} from "./OrchestratorMcpService.remote.testkit.ts";

const newerHost = { ...catalog, features: { ...catalog.features, taskForceStop: true } };

/** A running remote task whose report wait the host has not answered. */
const runningTask = (f: Effect.Success<typeof fixture>) =>
  Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const handle = yield* service.delegateTask(scope, input);
    assert.equal((yield* Queue.take(f.calls)).input.tool, "goat_origin_reports_wait");
    return { service, taskId: handle.taskId };
  });

it.effect("an older host without taskForceStop refuses force and is sent nothing", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const { service, taskId } = yield* runningTask(f);
      const error = yield* service.cancelTask(scope, { taskId, force: true }).pipe(Effect.flip);
      assert.equal(error.code, "task_not_cancellable");
      assert.match(error.message, /^remote: GOAT on box predates/u);
      assert.equal(yield* Queue.size(f.calls), 0);
      assert.equal((yield* service.taskStatus(scope, taskId)).status, "running");
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(database)),
);

it.effect(
  "a remote task the person promoted is not its parent's to force; its host hears nothing",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.hostCatalog(newerHost);
      yield* Effect.gen(function* () {
        const { service, taskId } = yield* runningTask(f);
        const index = f.projection.subagents.findIndex((task) => task.id === taskId);
        f.projection.subagents[index] = {
          ...f.projection.subagents[index]!,
          promotedAt: yield* DateTime.now,
        };
        // Whichever comes first: the refusal, or a request reaching the host.
        const first = yield* Effect.raceFirst(
          service.cancelTask(scope, { taskId, force: true }).pipe(
            Effect.flip,
            Effect.map((error) => `refused ${error.code} ${error.message.split(":")[0]}`),
          ),
          Queue.take(f.calls).pipe(Effect.map((call) => `host asked for ${call.input.tool}`)),
        );
        assert.equal(first, "refused task_not_cancellable not_owner");
        assert.equal(yield* Queue.size(f.calls), 0);
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(database)),
);

it.effect("a cancel without force, as an older caller sends, never asks the host to force", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.hostCatalog(newerHost);
    yield* Effect.gen(function* () {
      const { service, taskId } = yield* runningTask(f);
      const cancelling = yield* service.cancelTask(scope, { taskId }).pipe(Effect.forkChild);
      const interrupt = yield* Queue.take(f.calls);
      assert.equal(interrupt.input.tool, "goat_thread_interrupt");
      yield* Deferred.succeed(interrupt.reply, {
        host: "box",
        threadId: remoteThreadId,
        runId: remoteRunId,
        status: "interrupt_requested",
      });
      assert.equal((yield* Fiber.join(cancelling)).forceStop, undefined);
      const later = yield* Queue.clear(f.calls);
      assert.notInclude(
        later.map((call) => call.input.tool),
        "goat_origin_force_stop",
      );
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(database)),
);

it.effect("force on a host with taskForceStop asks it to force stop the task's own run", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.hostCatalog(newerHost);
    yield* Effect.gen(function* () {
      const { service, taskId } = yield* runningTask(f);
      const forcing = yield* service
        .cancelTask(scope, { taskId, force: true })
        .pipe(Effect.forkChild);
      const call = yield* Queue.take(f.calls);
      const [row] = yield* f.sql<{ correlation_id: string; read_key: string }>`
        SELECT correlation_id, read_key FROM remote_dispatches`;
      assert.deepEqual(
        {
          tool: call.input.tool,
          host: call.input.host,
          writes: call.input.writes,
          args: call.input.arguments,
        },
        {
          tool: "goat_origin_force_stop",
          host: "box",
          writes: true,
          args: {
            correlationId: row!.correlation_id,
            readKey: row!.read_key,
            threadId: remoteThreadId,
            runId: remoteRunId,
          },
        },
      );
      yield* Deferred.succeed(call.reply, { outcome: "killed", sharedWithThreadIds: [] });
      const result = yield* Fiber.join(forcing);
      assert.equal(result.status, "cancel_requested");
      assert.equal(result.forceStop?.outcome, "killed");
      assert.match(result.forceStop?.note ?? "", /on box/u);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(database)),
);

it.effect("the host's mode-ceiling refusal tells the caller a person must force stop there", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.hostCatalog(newerHost);
    yield* Effect.gen(function* () {
      const { service, taskId } = yield* runningTask(f);
      const forcing = yield* service
        .cancelTask(scope, { taskId, force: true })
        .pipe(Effect.forkChild);
      const call = yield* Queue.take(f.calls);
      yield* Deferred.fail(
        call.reply,
        new SshRemoteDispatch.SshRemoteDispatchError({
          reason: "remote_refused",
          remoteCode: "runtime_mode_escalation_denied",
          message: "Child runtime mode full-access is broader than parent mode approval-required.",
        }),
      );
      const error = yield* Fiber.join(forcing).pipe(Effect.flip);
      assert.equal(error.code, "task_not_cancellable");
      assert.match(
        error.message,
        /^mode: Force stop was refused: .+ A person on box must use Force stop/u,
      );
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(database)),
);

it.effect("the host's refusal reaches the caller as task_not_cancellable", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.hostCatalog(newerHost);
    yield* Effect.gen(function* () {
      const { service, taskId } = yield* runningTask(f);
      const forcing = yield* service
        .cancelTask(scope, { taskId, force: true })
        .pipe(Effect.forkChild);
      const call = yield* Queue.take(f.calls);
      const refusal: SshRemoteDispatchError = new SshRemoteDispatch.SshRemoteDispatchError({
        reason: "remote_refused",
        remoteCode: "task_not_cancellable",
        message: "not_unresponsive: thread child-on-host has no run whose Stop went unanswered.",
      });
      yield* Deferred.fail(call.reply, refusal);
      const error = yield* Fiber.join(forcing).pipe(Effect.flip);
      assert.equal(error.code, "task_not_cancellable");
      assert.match(error.message, /^not_unresponsive: /u);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(database)),
);
