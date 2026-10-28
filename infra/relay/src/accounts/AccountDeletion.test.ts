import { DeliveryAttempts } from "../agentActivity/DeliveryAttempts.ts";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { createPostgresFixture } from "./test/PostgresFixture.ts";
import { postgresPolicyLayer } from "./test/PolicyPostgresLayers.ts";
import { AccountLifecycle } from "./AccountLifecycle.ts";
import { AccountAccess } from "./AccountAccess.ts";
import { ManagedEndpointAllocations } from "../environments/ManagedEndpointAllocations.ts";

it.live(
  "erases A's active ownership graph, preserves B with the same public environment id, and retains only terminal cleanup authority across restart",
  () =>
    Effect.gen(function* () {
      using pg = createPostgresFixture();
      pg.migrate();
      const op = yield* Effect.gen(function* () {
        const lifecycle = yield* AccountLifecycle;
        const allocations = yield* ManagedEndpointAllocations;
        for (const userId of ["delete-a", "keep-b"]) {
          yield* lifecycle.request({ userId, kind: "allow", idempotencyKey: "invite" });
          yield* allocations.reserve({
            userId,
            environmentId: "shared-id",
            hostname: "unused",
            tunnelName: "unused",
          });
          pg.query(`
        INSERT INTO relay_environment_links(user_id,environment_id,environment_public_key,endpoint_http_base_url,endpoint_ws_base_url,endpoint_provider_kind,account_epoch,created_at,updated_at)
          VALUES ('${userId}','shared-id','key-${userId}','https://fixture.invalid','wss://fixture.invalid','cloudflare_tunnel',1,'now','now');
        INSERT INTO relay_environment_credentials(credential_id,credential_hash,user_id,account_epoch,environment_id,environment_public_key,created_at,updated_at)
          VALUES ('credential-${userId}','hash-${userId}','${userId}',1,'shared-id','key-${userId}','now','now');
        INSERT INTO relay_mobile_devices(user_id,device_id,platform,push_token,preferences_json,created_at,updated_at,account_epoch)
          VALUES ('${userId}','device-${userId}','ios','push-${userId}','{}','now','now',1);
        INSERT INTO relay_live_activities(user_id,device_id,activity_push_token,created_at,updated_at,account_epoch)
          VALUES ('${userId}','device-${userId}','activity-${userId}','now','now',1);
        INSERT INTO relay_delivery_attempts(id,user_id,device_id,kind,created_at) VALUES ('attempt-${userId}','${userId}','device-${userId}','push','now');
      `);
        }
        const b = pg.query(
          "SELECT row_to_json(d)::text FROM relay_mobile_devices d WHERE user_id='keep-b'",
        );
        const result = yield* lifecycle.requestDelete({
          userId: "delete-a",
          idempotencyKey: "delete",
        });
        expect(result.status).toBe("progress");
        if (result.status !== "progress") throw new Error("expected accepted operation");
        expect((yield* Effect.flip((yield* AccountAccess).capture("delete-a")))._tag).toBe(
          "RelayAccountAccessDeniedError",
        );
        expect(
          yield* lifecycle.requestDelete({ userId: "delete-a", idempotencyKey: "retry" }),
        ).toEqual(result);
        expect((yield* lifecycle.resume(result.operationId)).state).toBe("completed");
        const attempts = yield* DeliveryAttempts;
        const late = {
          accountEpoch: 1,
          userId: "delete-a",
          environmentId: "shared-id",
          threadId: null,
          deviceId: "old-device",
          kind: "push",
          token: "old-token",
        };
        yield* attempts.record(late);
        expect(yield* attempts.claimSourceJob({ ...late, sourceJobId: "old-queued-job" })).toBe(
          "completed",
        );
        expect(
          pg.query(
            "SELECT row_to_json(d)::text FROM relay_mobile_devices d WHERE user_id='keep-b'",
          ),
        ).toBe(b);
        return result.operationId;
      }).pipe(Effect.provide(postgresPolicyLayer(pg)));
      for (const table of [
        "relay_environment_links",
        "relay_environment_credentials",
        "relay_mobile_devices",
        "relay_live_activities",
        "relay_delivery_attempts",
        "relay_endpoint_identities",
        "relay_managed_endpoint_allocations",
        "relay_managed_provisioning_intents",
        "relay_managed_tunnel_limits",
      ])
        expect(pg.query(`SELECT count(*) FROM ${table} WHERE user_id='delete-a'`).trim()).toBe("0");
      expect(
        pg
          .query(
            "SELECT user_id IS NULL AND subject_digest IS NOT NULL AND status='deleted' FROM relay_account_access WHERE status='deleted'",
          )
          .trim(),
      ).toBe("t");
      expect(pg.query("SELECT count(*) FROM relay_host_revocations").trim()).toBe("1");
      expect(
        pg.query("SELECT count(*) FROM relay_retired_endpoints WHERE user_id IS NOT NULL").trim(),
      ).toBe("0");
      yield* Effect.gen(function* () {
        const lifecycle = yield* AccountLifecycle;
        const read = yield* lifecycle.getDeletion("delete-a");
        expect(read.status).toBe("progress");
        expect(
          (yield* lifecycle.requestDelete({
            userId: "delete-a",
            idempotencyKey: "new",
            identityDeleted: true,
          })).status,
        ).toBe("progress");
        expect(
          (yield* Effect.flip(
            lifecycle.request({
              userId: "delete-a",
              kind: "allow",
              idempotencyKey: "never-reinvite",
            }),
          )).code,
        ).toBe("account_deleted");
        pg.query(
          `UPDATE relay_account_operations SET completed_at=now()-interval '91 days' WHERE id='${op}'`,
        );
        const terminal = yield* lifecycle.getDeletion("delete-a");
        expect(terminal.status).toBe("deleted");
        expect(terminal).not.toHaveProperty("hostCleanup");
        expect(
          yield* lifecycle.requestDelete({ userId: "delete-a", idempotencyKey: "after-expiry" }),
        ).toEqual(terminal);
        yield* lifecycle.scanPending;
        expect(
          pg.query("SELECT count(*) FROM relay_account_operations WHERE kind='delete'").trim(),
        ).toBe("0");
        expect(pg.query("SELECT count(*) FROM relay_host_revocations").trim()).toBe("1");
        expect(
          yield* lifecycle.requestDelete({
            userId: "delete-a",
            idempotencyKey: "duplicate-webhook",
            identityDeleted: true,
          }),
        ).toEqual(terminal);
        expect((yield* (yield* AccountAccess).capture("keep-b")).accountEpoch).toBe(1);
      }).pipe(Effect.provide(postgresPolicyLayer(pg)));
    }),
);

it.live(
  "delete supersedes an unfinished suspend without reallowing and retries preserve one epoch",
  () =>
    Effect.gen(function* () {
      using pg = createPostgresFixture();
      pg.migrate();
      yield* Effect.gen(function* () {
        const lifecycle = yield* AccountLifecycle;
        yield* lifecycle.request({ userId: "owner", kind: "allow", idempotencyKey: "allow" });
        const suspended = yield* lifecycle.request({
          userId: "owner",
          kind: "suspend",
          idempotencyKey: "suspend",
        });
        const deletion = yield* lifecycle.requestDelete({
          userId: "owner",
          idempotencyKey: "delete",
        });
        expect(deletion.status).toBe("progress");
        expect((yield* lifecycle.getOperation(suspended.id)).state).toBe("superseded");
        expect(pg.query("SELECT account_epoch FROM relay_account_access").trim()).toBe("3");
        yield* lifecycle.requestDelete({ userId: "owner", idempotencyKey: "new" });
        expect(pg.query("SELECT account_epoch FROM relay_account_access").trim()).toBe("3");
      }).pipe(Effect.provide(postgresPolicyLayer(pg)));
    }),
);
