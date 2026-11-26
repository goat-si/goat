import { eligibleSourceMessages, scanWholeSource } from "../../../memory/memorySourceScan.ts";
import { expect, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { issueConversationRunCheck } from "../../../memory/conversationRunEligibility.ts";
import { setConversationMemoryEnabled } from "../../../memory/conversationMemoryPolicy.ts";
import * as Fixture from "./handlers.testkit.ts";

it.effect(
  "raw thread memory tools deny a paused prompt after resume, including a later steer",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = M.ThreadId.make("queued-memory");
      yield* sql`CREATE TABLE orchestration_events (sequence INTEGER PRIMARY KEY,event_id TEXT,application_event_version INTEGER,aggregate_kind TEXT,stream_id TEXT,event_type TEXT,payload_json TEXT)`;
      yield* sql`CREATE TABLE orchestration_v2_projection_runs (run_id TEXT PRIMARY KEY,thread_id TEXT,status TEXT,ordinal INTEGER)`;
      yield* sql`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY,project_id TEXT)`;
      yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES (${threadId},NULL)`;
      const caller = (runId?: string) => ({
        ...Fixture.scope(),
        client: undefined,
        thread: {
          threadId,
          providerSessionId: "synthetic",
          providerInstanceId: M.ProviderInstanceId.make("codex"),
          ...(runId ? { runId: M.RunId.make(runId) } : {}),
        },
      });
      const message = (id: string, runId: string | null) =>
        sql`INSERT INTO orchestration_events VALUES (NULL,${id},2,'thread',${threadId},'message.updated',${JSON.stringify({ id, role: "user", runId })})`;
      const start = (runId: string, prompt: string) =>
        sql`INSERT INTO orchestration_events VALUES (NULL,${runId},2,'thread',${threadId},'run.created',${JSON.stringify({ id: runId, userMessageId: prompt })})`;
      yield* message("allowed", "a");
      yield* start("a", "allowed");
      yield* setConversationMemoryEnabled(sql, false);
      yield* message("queued", null);
      yield* setConversationMemoryEnabled(sql, true);
      yield* start("b", "queued");
      const remember = (runId?: string) =>
        Fixture.call("goat_memory_remember", { text: "Use yarn", scope: "user" }, caller(runId));
      const list = (runId?: string) =>
        Fixture.call(
          "memory_list",
          {
            memorySpaceId: Fixture.space,
            scope: { kind: "user" },
            limit: 10,
            includeQuarantined: false,
          },
          caller(runId),
        );
      expect((yield* remember("b")).body).toMatchObject({ code: "unavailable" });
      const inFlight = yield* issueConversationRunCheck(sql, { threadId, runId: "a" });
      expect(yield* inFlight).toBe(true);
      const original = yield* list("a");
      expect(original.result.isError, JSON.stringify(original.body)).not.toBe(true);
      // A queued input can be steered into a currently running turn instead.
      yield* message("queued", "a");
      expect(yield* inFlight).toBe(false);
      yield* sql`INSERT INTO orchestration_v2_projection_runs VALUES ('a',${threadId},'running',1)`;
      expect((yield* remember("a")).body).toMatchObject({ code: "unavailable" });
      expect((yield* list()).body).toMatchObject({ code: "unavailable" });
      expect(yield* sql`SELECT 1 FROM memory_payloads`).toHaveLength(0);
      yield* message("fresh", "c");
      yield* start("c", "fresh");
      yield* sql`UPDATE orchestration_v2_projection_runs SET status='completed' WHERE run_id='a'`;
      yield* sql`INSERT INTO orchestration_v2_projection_runs VALUES ('c',${threadId},'running',2)`;
      const allowed = yield* Fixture.call(
        "goat_memory_remember",
        { text: "Use pnpm", scope: "user" },
        caller(),
      );
      expect(allowed.body).toMatchObject({ outcome: "accepted" });
    }).pipe(Effect.provide(Fixture.layer)),
);

it.effect.each(["restartContinuationOfRunId", "usageLimitContinuationOfRunId"] as const)(
  "%s inherits the pause of the original request across automatic continuations",
  (link) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = M.ThreadId.make("continued-memory");
      yield* sql`CREATE TABLE orchestration_events (sequence INTEGER PRIMARY KEY, event_id TEXT, application_event_version INTEGER, aggregate_kind TEXT, stream_id TEXT, event_type TEXT, payload_json TEXT)`;
      const append = (type: string, payload: Record<string, unknown>) =>
        sql`INSERT INTO orchestration_events VALUES (NULL, NULL, 2, 'thread', ${threadId}, ${type}, ${JSON.stringify(payload)})`;
      const turn = (id: string, parent?: string) =>
        Effect.gen(function* () {
          yield* append("message.updated", {
            id: id + "-input",
            role: "user",
            text: id,
            runId: id,
          });
          yield* append("run.created", {
            id,
            userMessageId: id + "-input",
            status: "completed",
            [link]: parent,
          });
        });
      yield* setConversationMemoryEnabled(sql, false);
      yield* turn("original");
      yield* setConversationMemoryEnabled(sql, true);
      yield* turn("continuation", "original");
      yield* turn("retry", "continuation");
      yield* append("message.updated", {
        id: "reply",
        role: "assistant",
        text: "Use yarn",
        runId: "retry",
      });
      yield* turn("fresh");
      yield* turn("fresh-retry", "fresh");
      yield* turn("orphan", "absent");
      yield* turn("loop", "loop");
      const allowed = (runId: string) =>
        issueConversationRunCheck(sql, { threadId, runId }).pipe(Effect.flatten);
      expect(yield* allowed("original")).toBe(false);
      expect(yield* allowed("retry")).toBe(false);
      expect(yield* allowed("fresh-retry")).toBe(true);
      expect(yield* allowed("orphan")).toBe(false);
      expect(yield* allowed("loop")).toBe(false);
      const save = yield* Fixture.call(
        "goat_memory_remember",
        { text: "Use yarn", scope: "user" },
        {
          ...Fixture.scope(),
          client: undefined,
          thread: {
            threadId,
            runId: M.RunId.make("retry"),
            providerSessionId: "synthetic",
            providerInstanceId: M.ProviderInstanceId.make("codex"),
          },
        },
      );
      expect(save.body).toMatchObject({ code: "unavailable" });
      expect(yield* sql`SELECT 1 FROM memory_payloads`).toHaveLength(0);
      const scan = yield* scanWholeSource(sql, threadId);
      expect(eligibleSourceMessages(scan, {}).map((row) => row.id)).toEqual([
        "fresh-input",
        "fresh-retry-input",
      ]);
    }).pipe(Effect.provide(Fixture.layer)),
);
