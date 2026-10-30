import { assert, it } from "@effect/vitest";
import { COMPUTER_USE_LEASE_ROUTE } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpRouter } from "effect/http";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeComputerUseHistory } from "./ComputerUseHistory.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import { reportLayer } from "./ComputerUseLeaseRoute.ts";
import { database, fixture, serviceLayer } from "./ComputerUseCallReservations.testkit.ts";

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
          resolve: () => Effect.succeed({ thread: { threadId: f.a } }),
        }),
      );
      const services = Context.merge(current, registry);
      const { handler, dispose } = HttpRouter.toWebHandler(reportLayer, { disableLogger: true });
      const send = (controlId: string) =>
        Effect.promise(() =>
          handler(
            new Request("http://goat.test" + COMPUTER_USE_LEASE_ROUTE, {
              method: "POST",
              headers: { authorization: "Bearer token" },
              body: JSON.stringify({
                type: "callOutcome",
                controlId,
                tool: "click",
                app: { id: "fixture.app", name: "Fixture" },
                verdict: "sent",
              }),
            }),
            services,
          ),
        );
      const wrong = yield* send(f.second.controlId);
      assert.equal(wrong.status, 409);
      const right = yield* send(f.first.controlId);
      assert.equal(right.status, 204);
      assert.equal((yield* history.listForThread(f.a)).length, 1);
      assert.deepEqual(yield* history.listForThread(f.b), []);
      yield* Effect.promise(() => dispose());
    }),
  ).pipe(Effect.provide(Layer.mergeAll(database, serviceLayer, ServerSettings.layerTest({})))),
);
