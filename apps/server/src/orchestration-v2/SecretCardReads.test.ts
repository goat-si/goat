import * as NodeSqlite from "node:sqlite";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import type * as Tracer from "effect/Tracer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";

declare module "node:sqlite" {
  interface StatementSync {
    stat(counter: "vmStep"): number;
  }
}
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "card-reads" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

it.effect("records a secret card without reading the thread's history", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:long-cards");
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-long-cards"),
      threadId,
      projectId: ProjectId.make("project:long-cards"),
      title: "Cards",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("start-long-cards"),
      threadId,
      messageId: MessageId.make("message:long-cards"),
      text: "Ask for a token and a link",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const run = (yield* projections.getThreadRecords(threadId, ["runs"])).runs[0]!;
    const providerTurnId = ProviderTurnId.make("provider-turn:long-cards");
    yield* projections.apply({
      id: EventId.make("event:long-cards:provider-turn"),
      type: "provider-turn.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: {
        id: providerTurnId,
        providerThreadId: run.providerThreadId!,
        nodeId: run.rootNodeId!,
        runAttemptId: run.activeAttemptId,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    });

    const cardSpans = ["orchestrationV2.dispatch.secretRequestRecord"];
    const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
    const recordStatements = Effect.provideService(
      Statement.CurrentTransformer,
      (statement, _make, _fiber, span) => {
        for (
          let parent = Option.some<Tracer.AnySpan>(span);
          Option.isSome(parent) && parent.value._tag === "Span";
          parent = parent.value.parent
        ) {
          if (cardSpans.includes(parent.value.name)) {
            statements.push(statement.compile());
            break;
          }
        }
        return Effect.succeed(statement);
      },
    );
    const card = {
      threadId,
      runId: run.id,
      nodeId: run.rootNodeId!,
      reason: "Needed for the work",
    };
    yield* orchestrator
      .dispatch({
        ...card,
        type: "secret_request.record",
        commandId: CommandId.make("record-long-cards:secret"),
        turnItemId: TurnItemId.make("item:long-cards:secret"),
        label: "Token",
        secretStatus: "pending",
      })
      .pipe(recordStatements);
    const { turnItems } = yield* projections.getThreadRecords(threadId, ["turnItems"], {
      turnItemTypes: ["secret_request"],
    });
    assert.deepEqual(
      turnItems.map((item) => [item.type, item.providerTurnId]),
      [["secret_request", providerTurnId]],
    );

    // A card reads its own run, so the rows and VM steps of its reads, which are deterministic,
    // must stay flat on a copy where the thread has thousands of older runs.
    const copyPath = "file:/card-reads?vfs=memdb";
    using copy = new NodeSqlite.DatabaseSync(copyPath);
    yield* sql`VACUUM INTO ${copyPath}`;
    const replay = () =>
      statements
        .filter(([query]) => /^\s*(SELECT|WITH)\b/.test(query))
        .reduce(
          (total, [query, params]) => {
            const statement = copy.prepare(query);
            const rows = statement.all(...(params as ReadonlyArray<NodeSqlite.SQLInputValue>));
            return {
              rows: total.rows + rows.length,
              steps: total.steps + statement.stat("vmStep"),
            };
          },
          { rows: 0, steps: 0 },
        );
    const short = replay();
    const history: ReadonlyArray<readonly [string, string, ReadonlyArray<string>]> = [
      ["runs", "run_id", []],
      ["run_attempts", "attempt_id", ["run_id"]],
      ["nodes", "node_id", ["run_id"]],
      ["provider_turns", "provider_turn_id", ["run_attempt_id"]],
    ];
    for (const [table, key, renamed] of history) {
      const name = `orchestration_v2_projection_${table}`;
      const columns = copy
        .prepare(`SELECT name FROM pragma_table_info('${name}')`)
        .all()
        .map((column) => String(column.name));
      const values = columns.map((column) =>
        column === key || renamed.includes(column)
          ? `${column} || ':history:' || history.n`
          : column === "ordinal"
            ? "ordinal + history.n"
            : column,
      );
      copy.exec(`WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 2000)
        INSERT INTO ${name} (${columns.join(", ")})
        SELECT ${values.join(", ")} FROM ${name}, history WHERE thread_id = '${threadId}'`);
    }
    const long = replay();
    assert.equal(long.rows, short.rows);
    assert.isAtMost(long.steps, short.steps * 1.1);
    const existing = yield* projections.getThreadRecords(threadId, ["attempts", "providerTurns"]);
    const attempt = existing.attempts.find((item) => item.id === run.activeAttemptId)!;
    const turn = existing.providerTurns.find((item) => item.id === providerTurnId)!;
    yield* projections.apply({
      id: EventId.make("event:long-cards:shared-attempt"),
      type: "run-attempt.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...attempt, providerTurnId },
    });
    yield* projections.apply({
      id: EventId.make("event:long-cards:shared-turn"),
      type: "provider-turn.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...turn, runAttemptId: null },
    });
    const shared = yield* projections.getRunCardRecords(threadId, run.id, run.rootNodeId!);
    assert.equal(shared.providerTurns[0]?.id, providerTurnId);
  }).pipe(Effect.provide(layerTest)),
);
