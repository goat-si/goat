import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as SqlClient from "effect/sql/SqlClient";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { CheckpointScopeId, CommandId, RunId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";

it.effect("a recovery resend keeps the original command and counts earlier resends", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const threadId = ThreadId.make("recovery-identity-thread");
    const runId = RunId.make("recovery-identity-run");
    const commandId = CommandId.make("original-command");
    yield* outbox.enqueue([
      {
        id: "effect:original",
        commandId,
        threadId,
        request: { type: "provider-turn.start", runId },
      },
      {
        id: `effect:recovery-resend:${runId}:1`,
        commandId,
        threadId,
        request: { type: "provider-turn.start", runId },
      },
    ]);
    expect(Option.getOrThrow(yield* outbox.findOriginalStart(threadId, runId))).toMatchObject({
      commandId,
      resendCount: 1,
    });
  }).pipe(Effect.provide(EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)))),
);

it.effect("pruning keeps the original start and resend budget while the run is active", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const old = DateTime.formatIso(DateTime.subtractDuration(now, Duration.days(8)));
    const current = DateTime.formatIso(now);
    yield* sql`INSERT INTO orchestration_v2_effect_outbox (effect_id, command_id, thread_id, effect_type, payload_json, status, available_at, created_at, updated_at, completed_at) VALUES ('effect:original-retain', 'original-command', 'thread:retain', 'provider-turn.start', '{"type":"provider-turn.start","runId":"run:retain"}', 'succeeded', ${old}, ${old}, ${old}, ${old})`;
    yield* sql`INSERT INTO orchestration_v2_effect_outbox (effect_id, command_id, thread_id, effect_type, payload_json, status, available_at, created_at, updated_at, completed_at) VALUES ('effect:recovery-resend:run:retain:1', 'original-command', 'thread:retain', 'provider-turn.start', '{"type":"provider-turn.start","runId":"run:retain"}', 'cancelled', ${old}, ${old}, ${old}, ${old})`;
    yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json) VALUES ('run:retain', 'thread:retain', 1, 'codex', 'running', ${current}, '{}')`;
    expect(yield* outbox.pruneSettled).toBe(0);
    expect(
      Option.getOrThrow(
        yield* outbox.findOriginalStart(ThreadId.make("thread:retain"), RunId.make("run:retain")),
      ),
    ).toMatchObject({ commandId: "original-command", resendCount: 1 });
    yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = 'run:retain'`;
    expect(yield* outbox.pruneSettled).toBe(2);
  }).pipe(
    Effect.provide(EffectOutbox.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
  ),
);

it.effect("a recovered start waits behind earlier durable work on its thread", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const threadId = ThreadId.make("recovery-order-thread");
    const runId = RunId.make("recovery-order-run");
    yield* outbox.enqueue([
      {
        id: "effect:earlier-checkpoint",
        commandId: CommandId.make("earlier-command"),
        threadId,
        request: {
          type: "checkpoint.capture",
          runId,
          scopeId: CheckpointScopeId.make("recovery-scope"),
        },
      },
      {
        id: `effect:recovery-resend:${runId}:1`,
        commandId: CommandId.make("original-command"),
        threadId,
        request: { type: "provider-turn.start", runId },
      },
    ]);
    expect(
      Option.isNone(
        yield* outbox.claimNext({
          workerId: "start-worker",
          leaseDurationMs: 30_000,
          effectTypes: ["provider-turn.start"],
        }),
      ),
    ).toBe(true);
    const earlier = Option.getOrThrow(
      yield* outbox.claimNext({
        workerId: "checkpoint-worker",
        leaseDurationMs: 30_000,
        effectTypes: ["checkpoint.capture"],
      }),
    );
    expect(earlier.id).toBe("effect:earlier-checkpoint");
    expect(yield* outbox.succeed({ effectId: earlier.id, workerId: "checkpoint-worker" })).toBe(
      true,
    );
    expect(
      Option.getOrThrow(
        yield* outbox.claimNext({
          workerId: "start-worker",
          leaseDurationMs: 30_000,
          effectTypes: ["provider-turn.start"],
        }),
      ).id,
    ).toBe(`effect:recovery-resend:${runId}:1`);
  }).pipe(Effect.provide(EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)))),
);
