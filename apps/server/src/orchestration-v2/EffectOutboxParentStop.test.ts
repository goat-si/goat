import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { CommandId, RunId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";

it.effect("only a stop effect for this child and current run blocks recovery", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const sql = yield* SqlClient.SqlClient;
    const parent = ThreadId.make("parent-stop-evidence");
    const child = ThreadId.make("child-stop-evidence");
    const other = ThreadId.make("other-child");
    const runId = RunId.make("child-current-run");
    yield* outbox.enqueue([
      {
        id: "stop:old",
        commandId: CommandId.make("stop:old"),
        threadId: parent,
        request: { type: "delegated-tasks.stop", childThreadIds: [child] },
      },
    ]);
    yield* outbox.enqueue([
      {
        id: "start:current",
        commandId: CommandId.make("start:current"),
        threadId: child,
        request: { type: "provider-turn.start", runId },
      },
    ]);
    expect(yield* outbox.hasDelegatedStop(parent, child, runId)).toBe(false);
    yield* outbox.enqueue([
      {
        id: "stop:other",
        commandId: CommandId.make("stop:other"),
        threadId: parent,
        request: { type: "delegated-tasks.stop", childThreadIds: [other] },
      },
    ]);
    expect(yield* outbox.hasDelegatedStop(parent, child, runId)).toBe(false);
    yield* outbox.enqueue([
      {
        id: "stop:new",
        commandId: CommandId.make("stop:new"),
        threadId: parent,
        request: { type: "delegated-tasks.stop", childThreadIds: [child] },
      },
    ]);
    expect(yield* outbox.hasDelegatedStop(parent, child, runId)).toBe(true);
    for (const status of ["running", "succeeded", "failed", "cancelled"]) {
      yield* sql`UPDATE orchestration_v2_effect_outbox SET status = ${status} WHERE effect_id = 'stop:new'`;
      expect(yield* outbox.hasDelegatedStop(parent, child, runId)).toBe(true);
    }
  }).pipe(
    Effect.provide(EffectOutbox.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
  ),
);
