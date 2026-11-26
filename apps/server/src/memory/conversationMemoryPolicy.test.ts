import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { conversationMemoryPolicySchema as migration } from "../persistence/Migrations/186_ConversationMemoryPolicy.ts";
import * as Settings from "../serverSettings.ts";
import * as Policy from "./conversationMemoryPolicy.ts";
import { memoryStableUuid } from "./MemoryService.ts";
import { MemoryStore } from "./MemoryStore.ts";
import { readEligibleSourceRows } from "./memorySourceScan.ts";
import * as Worker from "./MemoryWorker.ts";
import {
  decodeMessage,
  decodeRun,
  encodeMessage,
  encodeRun,
  environmentId,
  id,
  live,
  now,
  seed,
  space,
  threadId,
} from "./MemoryWorker.testkit.ts";

it.effect(
  "excludes a paused correction and its later revisions from generation after resume",
  () => {
    const seen: string[] = [];
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(now));
      yield* seed;
      const worker = yield* Worker.MemoryWorker;
      const sql = yield* SqlClient.SqlClient;
      const settings = yield* Settings.ServerSettingsService;
      const [first, second] = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_events ORDER BY sequence`;
      const message = yield* decodeMessage(first!.payload_json);
      const run = yield* decodeRun(second!.payload_json);
      yield* sql`UPDATE orchestration_events SET payload_json=${encodeMessage({ ...message, text: "Use pnpm" })} WHERE sequence=1`;
      const add = (n: number, type: string, payload: string) =>
        sql`INSERT INTO orchestration_events VALUES (${n},${id(3000 + n)},${threadId},${type},${payload},${now},2,'thread')`;
      const paused = {
        ...message,
        id: M.MessageId.make("paused"),
        runId: M.RunId.make("paused-run"),
        text: "Switch to yarn",
      };
      const completed = (n: number) =>
        add(n, "run.updated", encodeRun({ ...run, id: M.RunId.make("next-run") }));
      assert.isTrue(yield* Policy.readConversationMemoryEnabled(sql));
      yield* Policy.setConversationMemoryEnabled(sql, false);
      yield* settings.updateSettings({ conversationMemoryEnabled: false });
      yield* add(3, "message.updated", encodeMessage(paused));
      yield* add(
        4,
        "run.created",
        encodeRun({ ...run, id: paused.runId, userMessageId: paused.id, status: "running" }),
      );
      const queued = { ...paused, id: M.MessageId.make("queued"), runId: null };
      yield* add(5, "message.updated", encodeMessage(queued));
      assert.isFalse(yield* Policy.readConversationMemoryEnabled(sql));
      yield* worker.sweepDue();
      assert.deepStrictEqual(seen, []);
      yield* Policy.setConversationMemoryEnabled(sql, true);
      yield* settings.updateSettings({ conversationMemoryEnabled: true });
      yield* add(
        6,
        "message.updated",
        encodeMessage({ ...paused, text: "Yarn is still the new preference" }),
      );
      yield* add(
        7,
        "message.updated",
        encodeMessage({
          ...paused,
          id: M.MessageId.make("reply"),
          role: "assistant",
          text: "Remembered yarn",
        }),
      );
      yield* add(
        8,
        "run.updated",
        encodeRun({ ...run, id: paused.runId, userMessageId: paused.id }),
      );
      yield* add(
        9,
        "message.updated",
        encodeMessage({
          ...message,
          id: M.MessageId.make("later"),
          runId: null,
          text: "Prefer concise release notes",
        }),
      );
      const queuedRun = { ...run, id: M.RunId.make("queued-run"), userMessageId: queued.id };
      yield* add(10, "run.created", encodeRun({ ...queuedRun, status: "running" }));
      yield* add(
        11,
        "message.updated",
        encodeMessage({
          ...message,
          id: M.MessageId.make("queued-reply"),
          runId: queuedRun.id,
          role: "assistant",
          text: "Queued yarn result",
        }),
      );
      yield* add(12, "run.updated", encodeRun(queuedRun));
      const steered = {
        ...run,
        id: M.RunId.make("steered"),
        userMessageId: M.MessageId.make("later"),
      };
      yield* add(13, "run.created", encodeRun({ ...steered, status: "running" }));
      yield* add(14, "message.updated", encodeMessage({ ...queued, runId: steered.id }));
      yield* add(
        15,
        "message.updated",
        encodeMessage({
          ...message,
          id: M.MessageId.make("steer-reply"),
          runId: steered.id,
          role: "assistant",
          text: "Steered yarn result",
        }),
      );
      yield* add(16, "run.updated", encodeRun(steered));
      yield* completed(17);
      for (let i = 0; i < 3; i++) yield* worker.sweepDue();
      yield* TestClock.adjust("2 days");
      yield* worker.sweepDue();
      assert.include(seen, "Use pnpm");
      assert.include(seen, "Prefer concise release notes");
      assert.notInclude(seen, "Switch to yarn");
      assert.notInclude(seen, "Yarn is still the new preference");
      assert.notInclude(seen, "Remembered yarn");
      assert.notInclude(seen, "Queued yarn result");
      assert.notInclude(seen, "Steered yarn result");
      assert.isEmpty(
        yield* readEligibleSourceRows(sql, {
          threadId,
          afterSequence: 14,
          throughSequence: 17,
          observedSequence: 17,
          excluded: [],
          limit: 100,
        }),
      );
      const store = yield* MemoryStore;
      const summary = yield* store.loadAggregate(
        space,
        M.MemoryId.make(memoryStableUuid(`${environmentId}:${threadId}:summary`)),
      );
      const latest = summary.revisions.find(
        (pair) => pair.revision.revisionId === summary.heads[0],
      );
      assert.sameMembers(
        [...new Set(latest?.payload?.evidence.flatMap((item) => item.messageIds))],
        [message.id, "later"],
      );
    }).pipe(
      Effect.provide(live(false, (input) => seen.push(...input.messages.map((m) => m.text)))),
    );
  },
);

it.effect.each(["local", "hub"] as const)(
  "discards an in-flight %s summary across a pause and immediate resume",
  (mode) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(now));
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const worker = yield* Worker.MemoryWorker;
        const sweep = yield* worker.sweepDue().pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* Policy.setConversationMemoryEnabled(sql, false);
        yield* Policy.setConversationMemoryEnabled(sql, true);
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(sweep);
        assert.isEmpty(yield* sql`SELECT 1 FROM memory_payloads`);
        assert.deepStrictEqual(
          yield* sql`SELECT status FROM memory_outbox WHERE kind IN ('summary','consolidate')`,
          [{ status: "cancelled" }],
        );
      }).pipe(
        Effect.provide(
          live(
            false,
            undefined,
            mode === "local",
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(resume))),
          ),
        ),
      );
    }),
);

it.effect("retains idempotent sequence boundaries across database connections", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-memory-policy-" });
      const db = () => NodeSqliteClient.layer({ filename: `${dir}/state.sqlite` });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE orchestration_events(sequence INTEGER PRIMARY KEY)`;
        yield* sql`INSERT INTO orchestration_events VALUES (5)`;
        yield* migration;
        assert.isTrue(yield* Policy.readConversationMemoryEnabled(sql));
        yield* Policy.setConversationMemoryEnabled(sql, true);
        yield* Policy.setConversationMemoryEnabled(sql, false);
        yield* Policy.setConversationMemoryEnabled(sql, false);
        yield* sql`INSERT INTO orchestration_events VALUES (6)`;
      }).pipe(Effect.provide(db()));
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.isFalse(yield* Policy.readConversationMemoryEnabled(sql));
        yield* Policy.setConversationMemoryEnabled(sql, false);
        yield* Policy.setConversationMemoryEnabled(sql, true);
        yield* Policy.setConversationMemoryEnabled(sql, true);
        assert.deepStrictEqual(
          yield* sql`SELECT after_sequence,enabled FROM conversation_memory_policy ORDER BY generation`,
          [
            { after_sequence: 5, enabled: 0 },
            { after_sequence: 6, enabled: 1 },
          ],
        );
      }).pipe(Effect.provide(db()));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
