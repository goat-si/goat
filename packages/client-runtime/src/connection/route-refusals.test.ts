import { EnvironmentId } from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { connectOverRoutes } from "./driver.ts";
import { isHostCredentialRefusal } from "./errors.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  type PreparedConnection,
} from "./model.ts";
import type * as RpcSession from "../rpc/session.ts";

it.effect("retains a refused host route when a fallback connects", () =>
  Effect.gen(function* () {
    const environmentId = EnvironmentId.make("route-test");
    const first = new BearerConnectionTarget({
      environmentId,
      label: "host",
      connectionId: "first",
    });
    const second = new BearerConnectionTarget({
      environmentId,
      label: "host",
      connectionId: "second",
    });
    const prepared = {
      environmentId,
      label: "host",
      target: second,
      httpBaseUrl: "https://host.test",
      socketUrl: "wss://host.test",
      httpAuthorization: null,
    } satisfies PreparedConnection;
    const result = yield* connectOverRoutes(
      {
        target: first,
        profile: Option.none(),
        enabled: true,
        alternateRoutes: [{ target: second, profile: Option.none() }],
      },
      () => Effect.succeed("answered"),
      (route) =>
        route.target === first
          ? Effect.fail(
              new ConnectionBlockedError({
                reason: "authentication",
                hop: "server",
                detail: "refused",
              }),
            )
          : Effect.succeed({
              prepared,
              session: {} as RpcSession.RpcSession,
              openProbeSocket: Effect.never,
            }),
    ).pipe(Effect.scoped);
    expect(result.refusedRouteIds).toEqual(["first"]);
  }),
);

it("does not suggest pairing for a signed-out browser or a skewed clock", () => {
  expect(
    isHostCredentialRefusal(
      new ConnectionBlockedError({
        reason: "authentication",
        hop: "server",
        sessionEnded: true,
        detail: "ended",
      }),
    ),
  ).toBe(false);
  expect(
    isHostCredentialRefusal(
      new ConnectionBlockedError({
        reason: "authentication",
        hop: "server",
        failureCause: "clock_skew",
        detail: "skew",
      }),
    ),
  ).toBe(false);
  expect(
    isHostCredentialRefusal(
      new ConnectionBlockedError({ reason: "authentication", hop: "server", detail: "refused" }),
    ),
  ).toBe(true);
});
