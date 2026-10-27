import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { createPostgresFixture } from "./test/PostgresFixture.ts";
import { postgresPolicyLayer } from "./test/PolicyPostgresLayers.ts";
import { AccountLifecycle } from "./AccountLifecycle.ts";
import { ManagedEndpointAllocations } from "../environments/ManagedEndpointAllocations.ts";
import { HookInboxError } from "../hooks/HookInbox.ts";

it.live(
  "suspension retires identity atomically, resumes hook cleanup after restart, and allow never reuses the old endpoint",
  () =>
    Effect.gen(function* () {
      using pg = createPostgresFixture();
      pg.migrate();
      let failClear = true;
      const clear = () =>
        failClear
          ? Effect.fail(
              new HookInboxError({
                operation: "clear",
                endpointKey: "fixture",
                cause: new Error("fixture outage"),
              }),
            )
          : Effect.void;
      const first = postgresPolicyLayer(pg, { clear });
      const captured = yield* Effect.gen(function* () {
        const lifecycle = yield* AccountLifecycle;
        const allocations = yield* ManagedEndpointAllocations;
        const invited = yield* lifecycle.request({
          userId: "fixture-owner",
          kind: "allow",
          idempotencyKey: "invite",
        });
        expect(invited.account_epoch).toBe(1);
        const allocation = yield* allocations.reserve({
          userId: "fixture-owner",
          environmentId: "fixture-env",
          hostname: "ignored",
          tunnelName: "ignored",
        });
        const op = yield* lifecycle.request({
          userId: "fixture-owner",
          kind: "suspend",
          idempotencyKey: "suspend",
        });
        expect(op.account_epoch).toBe(2);
        expect(
          (yield* lifecycle.request({
            userId: "fixture-owner",
            kind: "suspend",
            idempotencyKey: "suspend-repeated",
          })).id,
        ).toBe(op.id);
        expect(
          (yield* Effect.flip(
            lifecycle.request({
              userId: "fixture-owner",
              kind: "allow",
              idempotencyKey: "too-early",
            }),
          )).code,
        ).toBe("operation_in_progress");
        expect((yield* lifecycle.resume(op.id)).state).toBe("pending");
        expect(pg.query("SELECT high_water_generation FROM relay_endpoint_identities").trim()).toBe(
          "1",
        );
        expect(pg.query("SELECT count(*) FROM relay_retired_endpoints").trim()).toBe("1");
        return { id: op.id, allocation };
      }).pipe(Effect.provide(first));
      failClear = false;
      yield* Effect.gen(function* () {
        const lifecycle = yield* AccountLifecycle;
        const allocations = yield* ManagedEndpointAllocations;
        expect((yield* lifecycle.resume(captured.id)).state).toBe("completed");
        expect(
          (yield* lifecycle.request({
            userId: "fixture-owner",
            kind: "allow",
            idempotencyKey: "allow",
          })).account_epoch,
        ).toBe(3);
        expect(
          (yield* Effect.flip(
            lifecycle.request({
              userId: "fixture-owner",
              kind: "suspend",
              idempotencyKey: "allow",
            }),
          )).code,
        ).toBe("idempotency_conflict");
        const replacement = yield* allocations.reserve({
          userId: "fixture-owner",
          environmentId: "fixture-env",
          hostname: "ignored",
          tunnelName: "ignored",
        });
        expect(replacement.incarnationId).not.toBe(captured.allocation.incarnationId);
        expect(replacement.endpointGeneration).toBe(1);
        expect(replacement.tunnelName).not.toBe(captured.allocation.tunnelName);
        expect(replacement.tunnelId).toBeNull();
        expect(replacement.dnsRecordId).toBeNull();
        expect(replacement.origin).toBeNull();
      }).pipe(Effect.provide(postgresPolicyLayer(pg, { clear })));
    }),
);

it.live(
  "historical-only identities and colon-suffixed new environments cannot roll back a second suspension",
  () =>
    Effect.gen(function* () {
      using pg = createPostgresFixture();
      pg.migrate();
      yield* Effect.gen(function* () {
        const lifecycle = yield* AccountLifecycle;
        const allocations = yield* ManagedEndpointAllocations;
        const reserve = (environmentId: string) =>
          allocations.reserve({
            userId: "owner",
            environmentId,
            hostname: "ignored",
            tunnelName: "ignored",
          });
        yield* lifecycle.request({ userId: "owner", kind: "allow", idempotencyKey: "invite" });
        const original = yield* reserve("foo");
        yield* allocations.markCapacityReleased(original);
        yield* allocations.remove(original);
        const first = yield* lifecycle.request({
          userId: "owner",
          kind: "suspend",
          idempotencyKey: "first",
        });
        yield* lifecycle.resume(first.id);
        yield* lifecycle.request({ userId: "owner", kind: "allow", idempotencyKey: "reallow" });
        yield* reserve("foo:1");
        const second = yield* lifecycle.request({
          userId: "owner",
          kind: "suspend",
          idempotencyKey: "second",
        });
        expect(second.account_epoch).toBe(4);
        expect((yield* lifecycle.resume(second.id)).state).toBe("completed");
        expect(
          pg
            .query(
              "SELECT status || ':' || account_epoch FROM relay_account_access WHERE user_id='owner'",
            )
            .trim(),
        ).toBe("suspended:4");
        expect(
          pg.query("SELECT count(DISTINCT endpoint_key) FROM relay_retired_endpoints").trim(),
        ).toBe("3");
        expect(
          pg
            .query(
              "SELECT environment_id || ':' || high_water_generation FROM relay_endpoint_identities ORDER BY environment_id",
            )
            .trim(),
        ).toBe("foo:2\nfoo:1:1");
      }).pipe(Effect.provide(postgresPolicyLayer(pg)));
    }),
);

it.live(
  "competing resumptions respect the lease and an expired holder cannot undo takeover completion",
  () =>
    Effect.gen(function* () {
      using pg = createPostgresFixture();
      pg.migrate();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let calls = 0;
      const clear = () =>
        Effect.gen(function* () {
          if (++calls === 1) {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return yield* new HookInboxError({
              operation: "clear",
              endpointKey: "fixture",
              cause: "stale provider failure",
            });
          }
        });
      yield* Effect.gen(function* () {
        const lifecycle = yield* AccountLifecycle;
        const allocations = yield* ManagedEndpointAllocations;
        yield* lifecycle.request({ userId: "owner", kind: "allow", idempotencyKey: "invite" });
        yield* allocations.reserve({
          userId: "owner",
          environmentId: "env",
          hostname: "ignored",
          tunnelName: "ignored",
        });
        const op = yield* lifecycle.request({
          userId: "owner",
          kind: "suspend",
          idempotencyKey: "suspend",
        });
        const old = yield* lifecycle.resume(op.id).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        expect((yield* lifecycle.resume(op.id)).state).toBe("running");
        expect(calls).toBe(1);
        pg.query("UPDATE relay_account_operations SET lease_expires_at=now()-interval '1 second'");
        yield* lifecycle.scanPending;
        expect((yield* lifecycle.getOperation(op.id)).state).toBe("completed");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(old);
        const done = yield* lifecycle.getOperation(op.id);
        expect(done.state).toBe("completed");
        expect(done.claim_version).toBe(2);
        expect(done.last_error_code).toBeNull();
        expect(
          pg
            .query("SELECT count(*) FROM relay_account_operation_resources WHERE outcome<>'done'")
            .trim(),
        ).toBe("0");
      }).pipe(Effect.provide(postgresPolicyLayer(pg, { clear })));
    }),
);

it.live.each(["account", "identity"] as const)(
  "%s overflow rolls back the entire suspension transaction",
  (kind) =>
    Effect.gen(function* () {
      using pg = createPostgresFixture();
      pg.migrate();
      yield* Effect.gen(function* () {
        const lifecycle = yield* AccountLifecycle;
        const allocations = yield* ManagedEndpointAllocations;
        yield* lifecycle.request({ userId: "owner", kind: "allow", idempotencyKey: "invite" });
        yield* allocations.reserve({
          userId: "owner",
          environmentId: "env",
          hostname: "ignored",
          tunnelName: "ignored",
        });
        if (kind === "account")
          pg.query("UPDATE relay_account_access SET account_epoch=2147483647");
        else pg.query("UPDATE relay_endpoint_identities SET high_water_generation=2147483646");
        expect(
          (yield* Effect.flip(
            lifecycle.request({ userId: "owner", kind: "suspend", idempotencyKey: "overflow" }),
          )).code,
        ).toBe("epoch_exhausted");
        expect(pg.query("SELECT status FROM relay_account_access").trim()).toBe("allowed");
        expect(pg.query("SELECT count(*) FROM relay_retired_endpoints").trim()).toBe("0");
        expect(
          pg.query("SELECT count(*) FROM relay_account_operations WHERE kind='suspend'").trim(),
        ).toBe("0");
        expect(
          pg
            .query(
              "SELECT count(*) FROM relay_managed_endpoint_allocations WHERE deleted_at IS NULL",
            )
            .trim(),
        ).toBe("1");
      }).pipe(Effect.provide(postgresPolicyLayer(pg)));
    }),
);
