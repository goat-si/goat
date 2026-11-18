import { vi } from "vite-plus/test";

vi.mock("@goat/shared/goatConnect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goat/shared/goatConnect")>()),
  isGoatConnectEnabled: () => true,
}));

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as ManagedRelay from "../relay/managedRelay.ts";
import {
  DESCRIPTOR,
  ENVIRONMENT_ID,
  makeHarness,
  persistedToken,
  websocketTicket,
} from "./remoteAuthorization.testkit.ts";
import { RemoteEnvironmentAuthorization } from "./service.ts";

const authorizePrepared = Effect.gen(function* () {
  const service = yield* RemoteEnvironmentAuthorization;
  return yield* service.authorizeDpop({
    expectedEnvironmentId: ENVIRONMENT_ID,
    readDescriptor: true,
  });
});

it.effect("a cached relay token reads the descriptor beside its ticket", () =>
  Effect.gen(function* () {
    const ticket = Promise.withResolvers<Response>();
    const descriptor = Promise.withResolvers<Response>();
    const ticketStarted = Promise.withResolvers<void>();
    const descriptorStarted = Promise.withResolvers<void>();
    const h = yield* makeHarness({
      initialToken: persistedToken(),
      responses: Array.from({ length: 2 }, () => (init: RequestInit) => {
        if (init.method === "POST") {
          ticketStarted.resolve();
          return ticket.promise;
        }
        descriptorStarted.resolve();
        return descriptor.promise;
      }),
    });
    const preparing = yield* authorizePrepared.pipe(Effect.provide(h.layer), Effect.forkChild);
    yield* Effect.promise(() => Promise.all([ticketStarted.promise, descriptorStarted.promise]));
    ticket.resolve(websocketTicket("cached"));
    descriptor.resolve(Response.json(DESCRIPTOR));
    const authorized = yield* Fiber.join(preparing);
    expect(authorized.descriptor).toMatchObject(DESCRIPTOR);
    expect(authorized.socketUrl).toContain("wsTicket=cached");
  }),
);

it.effect("a cached relay ticket does not substitute for a failed descriptor read", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({
      initialToken: persistedToken(),
      responses: Array.from(
        { length: 2 },
        () => (init: RequestInit) =>
          init.method === "POST" ? websocketTicket("cached") : new Response(null, { status: 503 }),
      ),
    });
    const error = yield* authorizePrepared.pipe(Effect.provide(h.layer), Effect.flip);
    expect(error._tag).toBe("ConnectionTransientError");
  }),
);

it.effect("a blocked cached ticket interrupts its pending descriptor read", () =>
  Effect.gen(function* () {
    const started = Promise.withResolvers<void>();
    const interrupted = Promise.withResolvers<void>();
    const h = yield* makeHarness({
      initialToken: persistedToken(),
      beforeProof: ({ method, url }) =>
        Effect.promise(() => started.promise).pipe(
          Effect.andThen(
            Effect.fail(
              new ManagedRelay.ManagedRelayDpopProofCreationError({
                method,
                url,
                cause: "key unavailable",
              }),
            ),
          ),
        ),
      responses: [
        (init) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener(
              "abort",
              () => {
                interrupted.resolve();
                reject(init.signal?.reason);
              },
              { once: true },
            );
            started.resolve();
          }),
      ],
    });
    const error = yield* authorizePrepared.pipe(Effect.provide(h.layer), Effect.flip);
    expect(error._tag).toBe("ConnectionBlockedError");
    yield* Effect.promise(() => interrupted.promise);
  }),
);
