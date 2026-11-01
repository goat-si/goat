import { expect, it } from "@effect/vitest";
import { ThreadId, type RuntimeMode } from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import Migration0062 from "../persistence/Migrations/071_RemoteReports.ts";
import Migration0063 from "../persistence/Migrations/072_RemoteDispatches.ts";
import Migration0065 from "../persistence/Migrations/074_RemoteDispatchQuestions.ts";
import Migration0068 from "../persistence/Migrations/076_RemoteReportRelay.ts";
import Migration0073 from "../persistence/Migrations/081_MemoryTaskGrantCeiling.ts";
import Migration0089 from "../persistence/Migrations/094_RemoteDispatchObservation.ts";
import Migration0101 from "../persistence/Migrations/103_RemoteReportInboxRunId.ts";
import { withLinkedHost } from "../sshRemote/testkit/LinkedHostFixture.ts";
import { resolveLostThreadLaunches } from "./remoteDispatchRecovery.ts";

const origin = ThreadId.make("recovery-origin");
const id = "channel-child-remote:lost-over-link";

/**
 * One lost launch to the linked host "box", recovered by the real pass: the fence call goes
 * through SshRemoteDispatch's link admission exactly as in production.
 */
const recoverOverLink = (originMode: RuntimeMode) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const migration of [Migration0062, Migration0063, Migration0065, Migration0068])
      yield* migration;
    yield* sql`CREATE TABLE scheduled_tasks (task_id TEXT PRIMARY KEY)`;
    for (const migration of [Migration0073, Migration0089, Migration0101]) yield* migration;
    yield* sql`INSERT INTO remote_dispatches (correlation_id, kind, origin_thread_id, host, read_key,
      delivery, state, created_at, updated_at)
      VALUES (${id}, 'thread', ${origin}, 'box', ${"5".repeat(64)}, 'wake', 'lost',
        '1969-12-31T23:00:00.000Z', '1969-12-31T23:00:00.000Z')`;
    const threads = Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(liveThreadShell(origin, { runtimeMode: originMode })),
    });
    const { record } = yield* withLinkedHost(
      () => ({ result: { structuredContent: { _tag: "fenced" } } }),
      resolveLostThreadLaunches({ retryAt: new Map(), start: () => Effect.void }).pipe(
        Effect.provide(threads),
      ),
      undefined,
      // A link made with more than approval-required, as a launch from a full-access thread needs.
      "full-access",
    );
    const rows = yield* sql<{ readonly state: string }>`
      SELECT state FROM remote_dispatches WHERE correlation_id = ${id}`;
    return {
      state: rows[0]?.state,
      resolveCalls: record.filter((entry) => entry.tool === "goat_origin_resolve_binding").length,
    };
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

it.effect("a lost launch over a full-access link is fenced under its origin thread's ceiling", () =>
  Effect.gen(function* () {
    expect(yield* recoverOverLink("full-access")).toEqual({ state: "cancelled", resolveCalls: 1 });
  }),
);

it.effect("an origin thread lowered below the link sends nothing and keeps the launch lost", () =>
  Effect.gen(function* () {
    expect(yield* recoverOverLink("approval-required")).toEqual({ state: "lost", resolveCalls: 0 });
  }),
);
