import { assert, it } from "@effect/vitest";
import { COMPUTER_USE_LEASE_ROUTE, EnvironmentId, ProviderInstanceId } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpRouter } from "effect/http";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeComputerUseHistory } from "./ComputerUseHistory.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import { callLayer, reportLayer } from "./ComputerUseLeaseRoute.ts";
import { database, fixture, serviceLayer } from "./ComputerUseCallReservations.testkit.ts";
import { awaitHistory, refusalHistoryKey } from "./ComputerUseHistoryBackground.ts";

it.effect("accepts outcomes only for the authenticated thread and its control", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture();
      const history = yield* makeComputerUseHistory;
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
      const services = Context.merge(current, registry);
      const { handler, dispose } = HttpRouter.toWebHandler(Layer.merge(reportLayer, callLayer), {
        disableLogger: true,
      });
      const send = (controlId: string, reservationId?: string, proxyRefusal = false) =>
        Effect.promise(() =>
          handler(
            new Request("http://goat.test" + COMPUTER_USE_LEASE_ROUTE, {
              method: "POST",
              headers: { authorization: "Bearer token" },
              body: JSON.stringify({
                type: proxyRefusal ? "proxyRefusal" : "callOutcome",
                controlId,
                ...(reservationId === undefined ? {} : { reservationId }),
                tool: "click",
                app: { id: "fixture.app", name: "Fixture" },
                verdict: proxyRefusal ? "refused" : "sent",
                ...(proxyRefusal ? { refusalCode: "not_allowed" } : {}),
                typed: { length: 6, text: "secret", fieldKind: "normal" },
              }),
            }),
            services,
          ),
        );
      const wrong = yield* send(f.second.controlId);
      assert.equal(wrong.status, 409);
      const right = yield* send(f.first.controlId);
      assert.equal(right.status, 409);
      const entries = yield* history.listForThread(f.a);
      assert.equal(entries.length, 0);
      assert.deepEqual(yield* history.listForThread(f.b), []);
      const admitted = yield* Effect.promise(() =>
        handler(
          new Request("http://goat.test" + COMPUTER_USE_LEASE_ROUTE + "/calls", {
            method: "POST",
            headers: { authorization: "Bearer token" },
            body: JSON.stringify({
              action: "reserve",
              controlId: f.first.controlId,
              connectionId: "driver:1",
              callId: "1",
              interruptions: 0,
              idleEpoch: 0,
              name: "click",
              args: { pid: 42, window_id: 7 },
              app: "real.app",
              appLabel: { name: "Real app" },
            }),
          }),
          services,
        ),
      );
      assert.equal(admitted.status, 200);
      const response: unknown = yield* Effect.promise(() => admitted.json());
      assert.isObject(response);
      if (
        typeof response !== "object" ||
        response === null ||
        !("reservationId" in response) ||
        typeof response.reservationId !== "string"
      )
        return assert.fail("missing reservation");
      const ticket = response.reservationId;
      yield* awaitHistory(ticket);
      const pending = yield* history.listForThread(f.a);
      assert.equal(pending.length, 1);
      assert.equal(pending[0]?.verdict, "unknown_outcome");
      assert.equal(pending[0]?.appId, "real.app");
      assert.equal((yield* send(f.second.controlId, ticket)).status, 409);
      assert.equal((yield* send(f.first.controlId, ticket)).status, 204);
      assert.equal((yield* send(f.first.controlId, ticket)).status, 409);
      const settled = yield* history.listForThread(f.a);
      assert.equal(settled[0]?.verdict, "sent");
      assert.equal(settled[0]?.appId, "real.app");
      assert.equal(settled[0]?.typedLength, null);
      yield* f.leases.stop(f.a);
      const replacement = yield* f.leases.control(f.a, Option.none());
      assert.notEqual(replacement.controlId, f.first.controlId);
      assert.equal((yield* send(f.first.controlId)).status, 409);
      assert.equal((yield* history.listForThread(f.a)).length, 1);
      assert.equal((yield* send(f.second.controlId)).status, 409);
      assert.equal((yield* send(replacement.controlId, undefined, true)).status, 400);
      const proxyReported = yield* history.listForThread(f.a);
      assert.equal(proxyReported.length, 1);
      const denied = yield* Effect.promise(() =>
        handler(
          new Request("http://goat.test" + COMPUTER_USE_LEASE_ROUTE + "/calls", {
            method: "POST",
            headers: { authorization: "Bearer token" },
            body: JSON.stringify({
              action: "reserve",
              controlId: replacement.controlId,
              connectionId: "driver:2",
              callId: "denied",
              interruptions: 0,
              idleEpoch: 0,
              name: "click",
              args: { delivery_mode: "foreground" },
              app: "real.app",
              appLabel: { name: "Real app" },
            }),
          }),
          services,
        ),
      );
      assert.equal(denied.status, 200);
      yield* awaitHistory(refusalHistoryKey(f.a, replacement.controlId, "driver:2", "denied"));
      const rejected = yield* history.listForThread(f.a);
      assert.equal(rejected[0]?.verdict, "refused");
      assert.equal(rejected[0]?.refusalCode, "pointer_locked");
      assert.equal(rejected[0]?.appId, "real.app");
      yield* Effect.promise(() => dispose());
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        database,
        serviceLayer,
        ServerSettings.layerTest({ computerUseKeepTypedText: true }),
      ),
    ),
  ),
);

it.effect("bounds ended control ownership while retaining recent controls for their thread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture();
      const controls = yield* Effect.forEach(Array.from({ length: 130 }), () =>
        Effect.gen(function* () {
          yield* f.leases.stop(f.a);
          return yield* f.leases.control(f.a, Option.none());
        }),
      );
      assert.isFalse(yield* f.leases.ownsControl(f.a, f.first.controlId));
      const recent = controls.at(-2);
      const current = controls.at(-1);
      if (recent === undefined || current === undefined) return assert.fail("missing controls");
      assert.isTrue(yield* f.leases.ownsControl(f.a, recent.controlId));
      assert.isTrue(yield* f.leases.ownsControl(f.a, current.controlId));
      assert.isFalse(yield* f.leases.ownsControl(f.b, recent.controlId));
      assert.isTrue(yield* f.leases.ownsControl(f.b, f.second.controlId));
    }),
  ).pipe(Effect.provide(Layer.merge(database, serviceLayer))),
);
