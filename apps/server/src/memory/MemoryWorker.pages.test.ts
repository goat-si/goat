import { assert, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Store from "./MemoryStore.ts";
import * as Service from "./MemoryService.ts";
import * as Worker from "./MemoryWorker.ts";
import {
  id,
  environmentId,
  space,
  threadId,
  now,
  live,
  encodeMessage,
  decodeMessage,
  decodeRun,
  encodeRun,
  seed,
  work,
  incrementalSummary,
} from "./MemoryWorker.testkit.ts";

it.effect.each(
  [false, true].flatMap((local) =>
    (["hook", "execute"] as const).flatMap((entry) =>
      (["leading", "middle", "trailing", "all"] as const).map((shape) => ({ local, entry, shape })),
    ),
  ),
)(
  "r2 $entry consumes frame-only $shape pages and resumes next sweep (local=$local)",
  ({ local, entry, shape }) => {
    const inputs: M.GenerateMemorySummaryInput[] = [];
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(now));
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const store = yield* Store.MemoryStore;
      const worker = yield* Worker.MemoryWorker;
      yield* sql`ALTER TABLE orchestration_v2_projection_threads ADD COLUMN project_id TEXT`;
      const message = yield* decodeMessage(
        (yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_events WHERE sequence=1`)[0]!.payload_json,
      );
      const run = yield* decodeRun(
        (yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_events WHERE sequence=2`)[0]!.payload_json,
      );
      yield* sql`DELETE FROM orchestration_events`;
      const texts = [
        ...(shape === "middle" || shape === "trailing" ? ["valid before"] : []),
        ...Array.from(
          { length: shape === "leading" ? 101 : 202 },
          () => "<external_goat_memory>synthetic reference</external_goat_memory>",
        ),
        ...(shape === "leading" || shape === "middle" ? ["valid after"] : []),
      ];
      for (const [i, text] of texts.entries())
        yield* sql`INSERT INTO orchestration_events VALUES (${i + 1},${id(9000 + i)},${threadId},'message.updated',${encodeMessage({ ...message, id: M.MessageId.make(`page-${i}`), runId: null, text })},${now},2,'thread')`;
      const end = texts.length + 1;
      yield* sql`INSERT INTO orchestration_events VALUES (${end},${id(9500)},${threadId},'run.updated',${encodeRun(run)},${now},2,'thread')`;
      // Execute the whole range to exercise empty pages between generation chunks too.
      const queued: Store.MemoryWork = {
        ...work(),
        space: local ? `_local:${environmentId}` : space,
        status: "pending",
        claimedBy: null,
        claimedUntil: null,
        metadata: {
          ...(work().metadata as Extract<Store.MemoryWork["metadata"], { kind: "summary" }>),
          observedThroughSequence: end,
          sourceWatermark: {
            fromEventId: M.EventId.make(id(9000)),
            toEventId: M.EventId.make(id(9500)),
            throughSequence: end,
          },
        },
      };
      if (entry === "execute") {
        yield* store.enqueueWork(queued);
        yield* store.claimWork(queued.id, "worker", Date.parse(now), Number.MAX_SAFE_INTEGER);
        yield* worker.execute((yield* store.readWork(queued.id))!);
        assert.strictEqual((yield* store.readWork(queued.id))!.status, "completed");
        assert.deepStrictEqual(
          inputs.flatMap((i) => i.messages.map((m) => m.text)),
          texts.filter((t) => !t.startsWith("<external")),
        );
        const completed = yield* sql<{
          watermark: number;
        }>`SELECT json_extract(metadata_json,'$.sourceWatermark.throughSequence') AS watermark FROM memory_outbox WHERE id=${queued.id}`;
        assert.strictEqual(completed[0]!.watermark, end);
      } else {
        for (let i = 0; i < 8; i++) yield* worker.sweepDue();
        assert.deepStrictEqual(
          inputs.flatMap((i) => i.messages.map((m) => m.text)),
          texts.filter((t) => !t.startsWith("<external")),
        );
        const rows = yield* sql<{
          watermark: number;
        }>`SELECT max(json_extract(metadata_json,'$.sourceWatermark.throughSequence')) AS watermark FROM memory_outbox WHERE status='completed' AND kind='summary'`;
        assert.strictEqual(rows[0]!.watermark, end);
      }
      if (entry === "execute" && shape === "trailing") {
        const items = yield* store.list({
          memorySpaceId: space,
          scope: { kind: "user" },
          limit: 20,
        });
        assert.strictEqual(items.length, local ? 0 : 1);
      }
      // Catch-up must consume the same empty history without another generation.
      for (let i = 0; i < 4; i++) yield* worker.sweepDue();
      const count = inputs.length;
      yield* worker.sweepDue();
      assert.strictEqual(inputs.length, count);
      yield* sql`INSERT INTO orchestration_events VALUES (${end + 1},${id(9501)},${threadId},'message.updated',${encodeMessage({ ...message, id: M.MessageId.make("next-page"), runId: null, text: "next valid statement" })},${now},2,'thread')`;
      yield* sql`INSERT INTO orchestration_events VALUES (${end + 2},${id(9502)},${threadId},'run.updated',${encodeRun({ ...run, id: M.RunId.make("next-run") })},${now},2,'thread')`;
      yield* worker.sweepDue();
      assert.strictEqual(inputs.length, count + 1);
      assert.strictEqual(inputs.at(-1)!.messages[0]!.text, "next valid statement");
    }).pipe(
      Effect.provide(
        live(
          false,
          (input) => inputs.push(input),
          local,
          0,
          false,
          undefined,
          (input) => ({
            project: null,
            user: {
              text: "Durable preference",
              assertionKind: "fact",
              evidence: [
                {
                  origin: "thread",
                  sourceThread: input.sourceThread,
                  watermark: input.sourceWatermark,
                  messageIds: input.messages.map((message) => message.messageId),
                },
              ],
            },
          }),
        ),
      ),
    );
  },
);

it.effect.each([false, true])(
  "latest chunk replaces the entire promotion answer (later user=$0)",
  (laterUser) => {
    let calls = 0;
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(now));
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const store = yield* Store.MemoryStore;
      yield* sql`ALTER TABLE orchestration_v2_projection_threads ADD COLUMN project_id TEXT`;
      yield* (yield* Worker.MemoryWorker).sweepDue();
      const target = M.MemoryId.make(
        Service.memoryStableUuid(`${environmentId}:${threadId}:summary`),
      );
      yield* sql`UPDATE orchestration_v2_projection_threads SET project_id='project'`;
      yield* sql`CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY,workspace_root TEXT,deleted_at TEXT)`;
      yield* sql`INSERT INTO projection_projects VALUES ('project','/synthetic',NULL)`;
      const projectKey = { kind: "explicit" as const, sharedProjectId: "shared" };
      yield* store.putProjectBinding(
        {
          memorySpaceId: space,
          project: { environmentId, projectId: M.ProjectId.make("project") },
          projectKey,
          repositoryKey: null,
          version: 0,
        },
        null,
        Date.parse(now),
      );
      yield* incrementalSummary(target);
      const user = yield* store.list({ memorySpaceId: space, scope: { kind: "user" }, limit: 20 });
      const project = yield* store.list({
        memorySpaceId: space,
        scope: { kind: "project", projectKey },
        limit: 20,
      });
      const promotionId = M.MemoryId.make(
        Service.memoryStableUuid(`${environmentId}:${threadId}:promotion:user`),
      );
      assert.strictEqual(project.length, 0);
      assert.strictEqual(
        user.filter((item) => item.memoryId === promotionId).length,
        laterUser ? 1 : 0,
      );
      if (laterUser) {
        const aggregate = yield* store.loadAggregate(space, promotionId);
        assert.strictEqual(
          aggregate.revisions.find((item) => item.revision.revisionId === aggregate.heads[0])
            ?.payload?.text,
          "later user",
        );
      }
    }).pipe(
      Effect.provide(
        live(
          false,
          () => {
            calls++;
          },
          false,
          0,
          false,
          undefined,
          (input) => {
            const candidate = (text: string) => ({
              text,
              assertionKind: "fact" as const,
              evidence: [
                {
                  origin: "thread" as const,
                  sourceThread: input.sourceThread,
                  watermark: input.sourceWatermark,
                  messageIds: input.messages.map((message) => message.messageId),
                },
              ],
            });
            return calls === 1
              ? { project: null, user: null }
              : calls === 2
                ? { project: candidate("earlier project"), user: candidate("earlier user") }
                : { project: null, user: laterUser ? candidate("later user") : null };
          },
        ),
      ),
    );
  },
);
