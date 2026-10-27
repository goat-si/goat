import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { createPostgresFixture } from "./test/PostgresFixture.ts";
import { postgresPolicyLayer } from "./test/PolicyPostgresLayers.ts";
import { ManagedEndpointAllocations } from "../environments/ManagedEndpointAllocations.ts";
import { AccountTransactions } from "./AccountTransactions.ts";

it.live(
  "concurrent reservations cannot exceed the last held slot, and rollback releases admission",
  () =>
    Effect.gen(function* () {
      using pg = createPostgresFixture();
      pg.migrate();
      pg.query(
        "INSERT INTO relay_account_access(user_id,status,account_epoch) VALUES ('fixture-a','allowed',1),('fixture-b','allowed',1),('fixture-rollback','allowed',1),('fixture-zero','allowed',1)",
      );
      pg.query("INSERT INTO relay_managed_tunnel_limits VALUES ('fixture-zero',0,'now','now')");
      yield* Effect.gen(function* () {
        const allocations = yield* ManagedEndpointAllocations;
        const tx = yield* AccountTransactions;
        const reserve = (userId: string, environmentId: string) =>
          allocations.reserve({
            userId,
            environmentId,
            hostname: "ignored.example.test",
            tunnelName: "ignored",
          });
        const outcomes = yield* Effect.all(
          Array.from({ length: 8 }, (_, i) => reserve("fixture-a", `env-${i}`).pipe(Effect.result)),
          { concurrency: "unbounded" },
        );
        expect(outcomes.filter((o) => o._tag === "Success")).toHaveLength(1);
        expect(
          outcomes.filter(
            (o) => o._tag === "Failure" && o.failure._tag === "ManagedTunnelLimitExceeded",
          ),
        ).toHaveLength(7);
        expect(
          pg
            .query(
              "SELECT count(*) FROM relay_managed_endpoint_allocations WHERE user_id='fixture-a' AND capacity_released_at IS NULL",
            )
            .trim(),
        ).toBe("1");
        yield* reserve("fixture-b", "env-independent");
        expect((yield* Effect.flip(reserve("fixture-zero", "env-zero")))._tag).toBe(
          "ManagedTunnelLimitExceeded",
        );
        yield* tx
          .run(
            { userIds: ["fixture-rollback"] },
            reserve("fixture-rollback", "env-rollback").pipe(
              Effect.andThen(Effect.fail("rollback-fixture")),
            ),
          )
          .pipe(Effect.result);
        expect(
          pg
            .query(
              "SELECT count(*) FROM relay_managed_endpoint_allocations WHERE user_id='fixture-rollback'",
            )
            .trim(),
        ).toBe("0");
        yield* reserve("fixture-rollback", "env-after-rollback");
        const held = outcomes.find((o) => o._tag === "Success");
        expect(held?._tag).toBe("Success");
        if (held?._tag === "Success")
          expect((yield* reserve("fixture-a", held.success.environmentId)).incarnationId).toBe(
            held.success.incarnationId,
          );
      }).pipe(Effect.provide(postgresPolicyLayer(pg)));
    }),
);

it.live(
  "override two counts tombstoned held slots until explicit release and guards reacquisition",
  () =>
    Effect.gen(function* () {
      using pg = createPostgresFixture();
      pg.migrate();
      pg.query(
        "INSERT INTO relay_account_access(user_id,status,account_epoch) VALUES ('owner','allowed',1)",
      );
      pg.query("INSERT INTO relay_managed_tunnel_limits VALUES ('owner',2,'now','now')");
      yield* Effect.gen(function* () {
        const allocations = yield* ManagedEndpointAllocations;
        const reserve = (environmentId: string) =>
          allocations.reserve({
            userId: "owner",
            environmentId,
            hostname: "ignored",
            tunnelName: "ignored",
          });
        const a = yield* reserve("a");
        const b = yield* reserve("b");
        yield* allocations.remove(a);
        expect((yield* Effect.flip(reserve("c")))._tag).toBe("ManagedTunnelLimitExceeded");
        expect(yield* allocations.markCapacityReleased(b)).toBe(true);
        const c = yield* reserve("c");
        expect((yield* Effect.flip(reserve("b")))._tag).toBe("ManagedTunnelLimitExceeded");
        expect(yield* allocations.markCapacityReleased(c)).toBe(true);
        expect((yield* reserve("b")).capacityReleasedAt).toBeNull();
      }).pipe(Effect.provide(postgresPolicyLayer(pg)));
    }),
);
