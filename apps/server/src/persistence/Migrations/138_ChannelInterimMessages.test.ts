import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as ChannelLedger from "../../channels/ChannelLedger.ts";
import { runMigrations } from "../Migrations.ts";

const NOW = "2026-10-12T00:00:00.000Z";
const OWNER = "channel-owner:a";

const row = (id: string, destination: string) => ({
  delivery_id: id,
  cause_key: "test:" + id,
  input_id: null,
  task_id: null,
  kind: "question",
  destination_kind: destination,
  message_json: "{}",
  state: "delivering",
  attempts: 1,
  next_attempt_at: NOW,
  created_at: NOW,
  updated_at: NOW,
});

it.effect(
  "a Slack row an older server left in flight recovers as maybe sent after the upgrade, never resent",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 137 });
      yield* sql`INSERT INTO channel_outbox ${sql.insert(row("slack-in-flight", "slack"))}`;
      yield* sql`INSERT INTO channel_outbox ${sql.insert(row("goat-in-flight", "goat"))}`;
      yield* runMigrations({ toMigrationInclusive: 138 });
      // The ledger below is today's, so the schema it reads is too.
      yield* runMigrations();
      yield* Effect.gen(function* () {
        const ledger = yield* ChannelLedger.ChannelLedger;
        yield* ledger.claimOwnership({ token: OWNER, now: NOW, staleBefore: NOW });
        yield* ledger.settleInterruptedDeliveries({ owner: OWNER, now: NOW });
        assert.strictEqual(yield* ledger.getDeliveryState("slack-in-flight" as never), "ambiguous");
        // The bot's own record is idempotent, so it goes again as before.
        assert.strictEqual(yield* ledger.getDeliveryState("goat-in-flight" as never), "pending");
      }).pipe(Effect.provide(ChannelLedger.layer));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
