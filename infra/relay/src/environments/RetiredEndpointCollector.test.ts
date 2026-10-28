import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { createPostgresFixture } from "../accounts/test/PostgresFixture.ts";
import { postgresPolicyLayer } from "../accounts/test/PolicyPostgresLayers.ts";
import {
  RetiredEndpointCollector,
  RetiredEndpointInventory,
  RetiredInventoryError,
} from "./RetiredEndpointCollector.ts";
import { layer } from "./RetiredEndpointCollector.ts";

it.live(
  "an empty inventory never forgets a retired identity or its later tunnel and DNS effects",
  () =>
    Effect.gen(function* () {
      using pg = createPostgresFixture();
      pg.migrate();
      pg.query(
        "INSERT INTO relay_retired_endpoints(stage,user_id,environment_id,generation,endpoint_key,tunnel_name,hostname) VALUES ('test_stage','owner','env',0,'0123456789abcdef','goatrelay-managedendpoint-test-stage-0123456789abcdef','retired.example.test')",
      );
      const tunnels: { id: string; name: string }[] = [];
      const records: { id: string; name: string }[] = [];
      const calls: string[] = [];
      const inventory = Layer.succeed(RetiredEndpointInventory, {
        tunnels: () => Effect.succeed([...tunnels]),
        dns: () => Effect.succeed([...records]),
        disconnect: (id) =>
          Effect.sync(() => {
            calls.push(`disconnect:${id}`);
          }),
        deleteTunnel: (id) =>
          Effect.sync(() => {
            calls.push(`tunnel:${id}`);
            tunnels.splice(
              tunnels.findIndex((t) => t.id === id),
              1,
            );
          }),
        deleteDns: (id) =>
          Effect.sync(() => {
            calls.push(`dns:${id}`);
            records.splice(
              records.findIndex((t) => t.id === id),
              1,
            );
          }),
      });
      const runtime = layer.pipe(Layer.provide(inventory), Layer.provide(postgresPolicyLayer(pg)));
      yield* Effect.gen(function* () {
        const collector = yield* RetiredEndpointCollector;
        yield* collector.sweep;
      }).pipe(Effect.provide(runtime));
      tunnels.push({
        id: "late-tunnel",
        name: "goatrelay-managedendpoint-test-stage-0123456789abcdef",
      });
      records.push({ id: "late-record", name: "retired.example.test" });
      yield* Effect.gen(function* () {
        const collector = yield* RetiredEndpointCollector;
        yield* collector.sweep;
      }).pipe(Effect.provide(runtime));
      expect(calls).toEqual(["disconnect:late-tunnel", "tunnel:late-tunnel", "dns:late-record"]);
      expect(tunnels).toEqual([]);
      expect(records).toEqual([]);
      expect(pg.query("SELECT count(*) FROM relay_retired_endpoints").trim()).toBe("1");
      expect(pg.query("SELECT observed_backlog FROM relay_retired_collector_state").trim()).toBe(
        "0",
      );
    }),
);

it.live(
  "a failed first page cannot starve later retired resources, and a second collector cannot overlap the lease",
  () =>
    Effect.gen(function* () {
      using pg = createPostgresFixture();
      pg.migrate();
      pg.query(
        "INSERT INTO relay_retired_endpoints(stage,user_id,environment_id,generation,endpoint_key,tunnel_name,hostname) VALUES ('test_stage','owner','a',0,'0123456789abcdef','retired-a','a.example.test'),('test_stage','owner','b',0,'fedcba9876543210','retired-b','b.example.test')",
      );
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const deleted: string[] = [];
      const inventory = Layer.succeed(RetiredEndpointInventory, {
        tunnels: (page) =>
          Effect.succeed(
            page === 1
              ? [
                  { id: "a", name: "retired-a" },
                  ...Array.from({ length: 4 }, (_, i) => ({
                    id: `current-${i}`,
                    name: `current-${i}`,
                  })),
                ]
              : [{ id: "b", name: "retired-b" }],
          ),
        dns: () => Effect.succeed([]),
        disconnect: (id) =>
          id === "a"
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
        deleteTunnel: (id) =>
          id === "a"
            ? Effect.fail(
                new RetiredInventoryError({
                  operation: "delete-tunnel",
                  cause: new Error("fixture outage"),
                }),
              )
            : Effect.sync(() => {
                deleted.push(id);
              }),
        deleteDns: () => Effect.void,
      });
      yield* Effect.gen(function* () {
        const collector = yield* RetiredEndpointCollector;
        const first = yield* collector.sweep.pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* collector.sweep;
        expect(pg.query("SELECT tunnel_page FROM relay_retired_collector_state").trim()).toBe("1");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        expect(pg.query("SELECT tunnel_page FROM relay_retired_collector_state").trim()).toBe("2");
        yield* collector.sweep;
        expect(deleted).toEqual(["b"]);
        expect(pg.query("SELECT observed_backlog FROM relay_retired_collector_state").trim()).toBe(
          "1",
        );
      }).pipe(
        Effect.provide(
          layer.pipe(Layer.provide(inventory), Layer.provide(postgresPolicyLayer(pg))),
        ),
      );
    }),
);
