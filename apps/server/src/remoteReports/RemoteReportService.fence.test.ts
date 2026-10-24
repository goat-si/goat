// @effect-diagnostics nodeBuiltinImport:off - the origin side hashes its read key with node:crypto.
import * as NodeCrypto from "node:crypto";
import { assert, it } from "@effect/vitest";
import { RunId, ThreadId, type OrchestrationV2ThreadShell } from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import bindingsMigration from "../persistence/Migrations/070_RemoteReports.ts";
import dispatchMigration from "../persistence/Migrations/071_RemoteDispatches.ts";
import relayMigration from "../persistence/Migrations/075_RemoteReportRelay.ts";
import fencesMigration from "../persistence/Migrations/106_RemoteReportFences.ts";
import * as RemoteReportService from "./RemoteReportService.ts";

const readKey = "2".repeat(64);
const otherKey = "3".repeat(64);
const remoteThread = ThreadId.make("remote-thread");
const binding = {
  correlationId: "lost-launch",
  originLabel: "origin laptop",
  originThreadId: ThreadId.make("origin-thread"),
  readKeyHash: NodeCrypto.createHash("sha256").update(readKey, "utf8").digest("hex"),
};
const resolveInput = { correlationId: binding.correlationId, readKey };

/** The destination side alone: bindings, fences, and the thread shells resolve reads. */
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const step of [bindingsMigration, dispatchMigration, relayMigration, fencesMigration])
    yield* step;
  const shells = new Map<ThreadId, OrchestrationV2ThreadShell>();
  const orchestrator = Layer.mock(Orchestrator.OrchestratorV2)({
    getThreadShell: (id) => Effect.succeed(shells.get(id) ?? null),
  });
  // Each call builds a fresh service on the same database, as a restarted destination would.
  const service = Layer.build(
    RemoteReportService.layer.pipe(
      Layer.provide(orchestrator),
      Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
    ),
  ).pipe(Effect.map((context) => Context.get(context, RemoteReportService.RemoteReportService)));
  return { shells, service };
});
const test = <E>(name: string, body: Effect.Effect<void, E, SqlClient.SqlClient | Scope.Scope>) =>
  it.effect(name, () =>
    body.pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

test(
  "a resolve that finds no binding fences the id durably, so a late bind is refused",
  Effect.gen(function* () {
    const f = yield* fixture;
    const before = yield* f.service;
    assert.deepStrictEqual(yield* before.resolveBinding(resolveInput), { _tag: "fenced" });
    const restarted = yield* f.service;
    const late = yield* restarted.bind(remoteThread, binding).pipe(Effect.flip);
    assert.strictEqual(late.reason, "fenced");
    assert.deepStrictEqual(yield* restarted.resolveBinding(resolveInput), { _tag: "fenced" });
  }),
);

test(
  "a bound correlation resolves to its thread and live run instead of fencing",
  Effect.gen(function* () {
    const f = yield* fixture;
    const service = yield* f.service;
    yield* service.bind(remoteThread, binding);
    // The destination binds before it creates the thread, so a binding alone proves no run.
    assert.deepStrictEqual(yield* service.resolveBinding(resolveInput), {
      _tag: "bound",
      threadId: remoteThread,
      originThreadId: binding.originThreadId,
      threadExists: false,
      threadDeleted: false,
      activeRunId: null,
    });
    const runId = RunId.make("remote-run");
    f.shells.set(remoteThread, liveThreadShell(remoteThread, { activeRunId: runId }));
    const started = yield* service.resolveBinding(resolveInput);
    assert.strictEqual(started._tag, "bound");
    if (started._tag !== "bound") return;
    assert.isTrue(started.threadExists);
    assert.strictEqual(started.activeRunId, runId);
  }),
);

test(
  "only the correlation's read key resolves it, bound or fenced",
  Effect.gen(function* () {
    const f = yield* fixture;
    const service = yield* f.service;
    yield* service.bind(remoteThread, binding);
    const boundDenied = yield* service
      .resolveBinding({ ...resolveInput, readKey: otherKey })
      .pipe(Effect.flip);
    assert.strictEqual(boundDenied.reason, "access_denied");
    const fenceInput = { correlationId: "fenced-launch", readKey };
    assert.deepStrictEqual(yield* service.resolveBinding(fenceInput), { _tag: "fenced" });
    const fenceDenied = yield* service
      .resolveBinding({ ...fenceInput, readKey: otherKey })
      .pipe(Effect.flip);
    assert.strictEqual(fenceDenied.reason, "access_denied");
  }),
);

test(
  "a bind racing a resolve leaves exactly one of a binding or a fence",
  Effect.gen(function* () {
    const f = yield* fixture;
    const service = yield* f.service;
    const [bound, resolution] = yield* Effect.all(
      [
        service.bind(remoteThread, binding).pipe(Effect.result),
        service.resolveBinding(resolveInput),
      ],
      { concurrency: "unbounded" },
    );
    if (bound._tag === "Success") assert.strictEqual(resolution._tag, "bound");
    else {
      assert.strictEqual(bound.failure.reason, "fenced");
      assert.strictEqual(resolution._tag, "fenced");
    }
  }),
);
