import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
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
