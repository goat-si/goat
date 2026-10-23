import { expect, it } from "@effect/vitest";
import { RunId, ThreadId, type OrchestrationV2ThreadShell } from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import migration from "../persistence/Migrations/069_RemoteReports.ts";
import dispatchMigration from "../persistence/Migrations/070_RemoteDispatches.ts";
import relayMigration from "../persistence/Migrations/074_RemoteReportRelay.ts";
import inboxRunIdMigration from "../persistence/Migrations/101_RemoteReportInboxRunId.ts";
import * as RemoteReportService from "./RemoteReportService.ts";

const lane = ThreadId.make("local-lane");
const launcher = ThreadId.make("launcher-thread");

/** Each read of the lane's shell sees the next run, as a restart between reads would. */
const reportFrom = (activeRuns: ReadonlyArray<RunId | null>) =>
  Effect.gen(function* () {
    for (const step of [migration, dispatchMigration, relayMigration, inboxRunIdMigration])
      yield* step;
    let reads = 0;
    const fake = Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadShell: () =>
        Effect.sync(() => {
          const activeRunId = activeRuns[Math.min(reads, activeRuns.length - 1)] ?? null;
          reads += 1;
          return {
            id: lane,
            title: "Lane",
            activeRunId,
            latestRunId: activeRunId ?? RunId.make("run-earlier"),
            deletedAt: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: lane },
            launchedBy: {
              kind: "launch",
              threadId: launcher,
              environmentId: null,
              environmentLabel: null,
              threadTitle: "Supervisor",
              via: "thread_launch",
            },
          } as unknown as OrchestrationV2ThreadShell;
        }),
    });
    const context = yield* Layer.build(RemoteReportService.layer.pipe(Layer.provide(fake)));
    const service = Context.get(context, RemoteReportService.RemoteReportService);
    yield* service.report(lane, { status: "completed", summary: "Done." });
    const sql = yield* SqlClient.SqlClient;
    return (yield* sql<{ run_id: string | null }>`SELECT run_id FROM remote_report_inbox`).map(
      (row) => row.run_id,
    );
  }).pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

it.effect("a local lane's report keeps the run that made it when a restart follows", () =>
  Effect.gen(function* () {
    expect(yield* reportFrom([RunId.make("run-old"), RunId.make("run-new")])).toEqual(["run-old"]);
  }),
);

it.effect("a local lane's report made outside a run claims no run", () =>
  Effect.gen(function* () {
    expect(yield* reportFrom([null])).toEqual([null]);
  }),
);
