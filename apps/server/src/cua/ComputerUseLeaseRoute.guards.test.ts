import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import {
  type ComputerUseCallReservation,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";

import * as ServerSettings from "../serverSettings.ts";
import * as LeaseRoute from "./ComputerUseLeaseRoute.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import { runMigrations } from "../persistence/Migrations.ts";

const historyDatabase = Layer.effectDiscard(runMigrations()).pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

const threadId = ThreadId.make("thread:bot");
const controlId = "control:one";

describe("computer use lease route guards", () => {
  it.effect.each([
    [undefined, true, true],
    ["allowed", false, true],
    [undefined, false, false],
  ] as const)(
    "a call that would move the person's pointer is refused unless the host allows it (movePointer %s, pointer refused %s, strict %s)",
    ([movePointer, refused, strict]) =>
      Effect.gen(function* () {
        const received: Array<ComputerUseCallReservation> = [];
        let nextTicket = 0;
        const invocation: McpThreadInvocationScope = {
          environmentId: EnvironmentId.make("environment:test"),
          capabilities: new Set<never>(),
          issuedAt: 0,
          requestNamespace: "test",
          client: undefined,
          thread: {
            threadId,
            providerSessionId: "provider:test",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
        };
        const routes = LeaseRoute.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              ServerSettings.ServerSettingsService.layerTest({
                ...(movePointer === undefined ? {} : { cuaMovePointer: movePointer }),
                cuaDeniedApps: ["com.example.Blocked"],
                cuaStrictInputGuards: strict,
              }),
              historyDatabase,
              Layer.mock(McpSessionRegistry.McpSessionRegistry)({
                resolve: (token) => Effect.succeed(token === "fixture" ? invocation : undefined),
              }),
              Layer.mock(ComputerUseLeases.ComputerUseLeases)({
                foregroundApprovalEpoch: Effect.die("unused"),
                proxy: undefined,
                currentControl: () => Effect.succeedNone,
                callReservation: (_owner, call) =>
                  Effect.sync(() => {
                    received.push(call);
                    return {
                      status: "admitted",
                      reservationId:
                        ++nextTicket === 1 ? "reservation:test" : `reservation:test:${nextTicket}`,
                    } as const;
                  }),
              }),
            ),
          ),
        );
        const app = yield* Effect.acquireRelease(
          Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
          (web) => Effect.promise(() => web.dispose()),
        );
        const reserve = (args: object, targetApp?: string) =>
          Effect.promise(() =>
            app
              .handler(
                new Request("http://goat.test/api/computer-use/lease/calls", {
                  method: "POST",
                  body: JSON.stringify({
                    action: "reserve",
                    controlId,
                    connectionId: "driver:1",
                    callId: "one",
                    name: "click",
                    args,
                    ...(targetApp === undefined ? {} : { app: targetApp }),
                    interruptions: 0,
                    idleEpoch: 0,
                  }),
                  headers: { "content-type": "application/json", authorization: "Bearer fixture" },
                }),
              )
              .then((response) => response.json() as Promise<Record<string, unknown>>),
          );
        const foreground = yield* reserve({ pid: 42, window_id: 7, delivery_mode: "foreground" });
        assert.deepEqual(
          foreground,
          refused
            ? { status: "refused", detail: "pointer_locked" }
            : { status: "admitted", reservationId: "reservation:test" },
        );
        // A background click is judged by the leases as before, whatever the setting.
        assert.equal((yield* reserve({ pid: 42, window_id: 7, x: 3, y: 4 })).status, "admitted");
        // Denied apps are a strict guard too; without it the call goes on to the leases.
        assert.deepEqual(
          strict
            ? yield* reserve({ pid: 42, window_id: 7 }, "COM.EXAMPLE.BLOCKED")
            : { status: (yield* reserve({ pid: 42, window_id: 7 }, "COM.EXAMPLE.BLOCKED")).status },
          strict
            ? { status: "refused", detail: "app_not_allowed", app: "COM.EXAMPLE.BLOCKED" }
            : { status: "admitted" },
        );
        assert.equal(received.length, (refused ? 1 : 2) + (strict ? 0 : 1));
      }).pipe(Effect.scoped),
  );
});
