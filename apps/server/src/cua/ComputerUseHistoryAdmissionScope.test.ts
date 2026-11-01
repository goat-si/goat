import { assert, it } from "@effect/vitest";
import { COMPUTER_USE_LEASE_ROUTE, EnvironmentId, ProviderInstanceId } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { HttpRouter } from "effect/http";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { database, fixture, serviceLayer } from "./ComputerUseCallReservations.testkit.ts";
import { makeComputerUseHistory } from "./ComputerUseHistory.ts";
import { awaitHistory } from "./ComputerUseHistoryBackground.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import { layer as routeLayer } from "./ComputerUseLeaseRoute.ts";

it.effect("interrupts a blocked admitted history write when the route is disposed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture();
      const sql = yield* SqlClient.SqlClient;
      const history = yield* makeComputerUseHistory;
      const started = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const blockedSql = new Proxy(sql, {
        apply(target, receiver, args) {
          const statement: Statement.Statement<object> = Reflect.apply(target, receiver, args);
          if (
            !Array.isArray(args[0]) ||
            !args[0].join("").includes("INSERT INTO computer_use_input_history")
          )
            return statement;
          return Object.assign(
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
              Effect.andThen(statement),
            ),
            Statement.fragment(statement.segments),
          );
        },
      });
      const current = yield* Effect.context<
        | SqlClient.SqlClient
        | ComputerUseLeases.ComputerUseLeases
        | ServerSettings.ServerSettingsService
      >();
      const registry = yield* Layer.build(
        Layer.mock(McpSessionRegistry.McpSessionRegistry)({
          resolve: () =>
            Effect.succeed({
              environmentId: EnvironmentId.make("env:test"),
              capabilities: new Set(),
              issuedAt: 0,
              requestNamespace: "test",
              client: undefined,
              thread: {
                threadId: f.a,
                providerInstanceId: ProviderInstanceId.make("codex"),
                providerSessionId: "session",
              },
            }),
        }),
      );
      const services = Context.add(
        Context.merge(current, registry),
        SqlClient.SqlClient,
        blockedSql,
      );
      const { handler, dispose } = HttpRouter.toWebHandler(routeLayer, { disableLogger: true });
      const response = yield* Effect.promise(() =>
        handler(
          new Request("http://goat.test" + COMPUTER_USE_LEASE_ROUTE + "/calls", {
            method: "POST",
            headers: { authorization: "Bearer token" },
            body: JSON.stringify({
              action: "reserve",
              controlId: f.first.controlId,
              connectionId: "driver:scope",
              callId: "1",
              interruptions: 0,
              idleEpoch: 0,
              name: "click",
              args: { pid: 42, window_id: 7 },
            }),
          }),
          services,
        ),
      );
      assert.equal(response.status, 200);
      const admission: unknown = yield* Effect.promise(() => response.json());
      if (
        typeof admission !== "object" ||
        admission === null ||
        !("reservationId" in admission) ||
        typeof admission.reservationId !== "string"
      )
        return assert.fail("missing reservation");
      yield* Deferred.await(started);
      yield* Effect.promise(() => dispose());
      const wasInterrupted = yield* Deferred.isDone(interrupted);
      yield* Deferred.succeed(gate, undefined);
      yield* awaitHistory(admission.reservationId);
      assert.isTrue(wasInterrupted);
      assert.deepEqual(yield* history.listForThread(f.a), []);
    }),
  ).pipe(Effect.provide(Layer.mergeAll(database, serviceLayer, ServerSettings.layerTest()))),
);
