import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import * as AutomationHold from "../automationHold.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ManagedEndpointRuntime from "../cloud/ManagedEndpointRuntime.ts";
import {
  HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET,
  RELAY_URL_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
} from "../cloud/config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as HeldHooksWaker from "./HeldHooksWaker.ts";

it.effect("held: sends no webhook wake; release: a connected tunnel wakes held hooks", () =>
  Effect.gen(function* () {
    const hold = yield* AutomationHold.makeInMemory({
      reason: "channel-copy",
      heldAt: "2026-10-25T00:00:00.000Z",
    });
    const connections = yield* Queue.unbounded<void>();
    const pulls = yield* Queue.unbounded<void>();
    const sent = yield* Deferred.make<void>();
    let requests = 0;
    const fetch: typeof globalThis.fetch = Object.assign(
      () => {
        requests += 1;
        Deferred.doneUnsafe(sent, Effect.void);
        return Promise.resolve(Response.json({ pending: true }));
      },
      { preconnect: () => {} },
    );
    const secrets = new Map([
      [HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET, "true"],
      [RELAY_URL_SECRET, "https://relay.example.test"],
      [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "test-credential"],
    ]);
    yield* Layer.build(HeldHooksWaker.layer).pipe(
      Effect.provideService(AutomationHold.AutomationHold, hold),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.provide([
        Layer.mock(ManagedEndpointRuntime.CloudManagedEndpointRuntime)({
          tunnelConnected: Stream.fromEffectRepeat(
            Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(connections))),
          ),
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("held-environment")),
        }),
        Layer.mock(ServerSecretStore.ServerSecretStore)({
          get: (name) =>
            Effect.succeed(
              Option.map(Option.fromUndefinedOr(secrets.get(name)), (value) =>
                new TextEncoder().encode(value),
              ),
            ),
        }),
      ]),
    );
    yield* Queue.take(pulls);
    yield* Queue.offer(connections, undefined);
    yield* Queue.take(pulls);
    yield* TestClock.adjust("3 seconds");
    expect(requests).toBe(0);
    yield* hold.release;
    yield* Queue.offer(connections, undefined);
    yield* Queue.take(pulls);
    yield* TestClock.adjust("3 seconds");
    yield* Deferred.await(sent);
    expect(requests).toBe(1);
  }).pipe(Effect.scoped),
);

vi.mock("@goat/shared/goatConnect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goat/shared/goatConnect")>()),
  isGoatConnectEnabled: () => true,
}));
