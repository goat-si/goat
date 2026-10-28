import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { runMigrations } from "../persistence/Migrations.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import { database } from "./ComputerUseLeases.projection.testkit.ts";
import * as PrimitiveChannel from "./ComputerUsePrimitiveChannel.ts";

const layer = it.layer(
  Layer.merge(
    database,
    ComputerUseLeases.layer.pipe(Layer.provide(Layer.merge(database, NodeServices.layer))),
  ),
);

layer("ComputerUsePrimitiveChannel with real leases", (it) => {
  it.effect.each(["stop", "stopAll"] as const)(
    "turning computer use off after %s closes the thread's proxy registration",
    (how) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* runMigrations();
          const leases = yield* ComputerUseLeases.ComputerUseLeases;
          const channel = yield* PrimitiveChannel.make;
          const threadId = ThreadId.make(`thread-channel-disable-${how}`);
          const control = yield* leases.control(threadId, Option.none());
          const authority = {
            threadId,
            attachmentGeneration: "attachment:one",
            proxyChannelToken: "channel:secret",
          };
          yield* channel.issue({
            ...authority,
            controlId: control.controlId,
            expiresAt: Number.MAX_SAFE_INTEGER,
          });
          const registered = yield* channel.registerStream({
            ...authority,
            proxyInstanceId: "proxy:one",
            kind: "thread",
          });
          if (registered.status !== "registered") throw new Error("expected registration");
          const closed = yield* Stream.runDrain(registered.requests).pipe(Effect.forkChild);
          if (how === "stop") yield* leases.stop(threadId);
          else yield* leases.stopAll;
          yield* leases.disable;
          // The registration's request stream ends only when the channel closes it.
          yield* Fiber.await(closed);
          assert.isUndefined(
            yield* channel.authenticate({
              threadId,
              proxyChannelToken: authority.proxyChannelToken,
            }),
          );
          const next = yield* leases.control(threadId, Option.none());
          const reissued = { ...authority, attachmentGeneration: "attachment:two" };
          yield* channel.issue({
            ...reissued,
            controlId: next.controlId,
            expiresAt: Number.MAX_SAFE_INTEGER,
          });
          assert.isFalse(
            yield* channel.reportControlReady({
              ...reissued,
              registrationId: registered.registrationId,
              controlId: next.controlId,
              connectionId: "driver:1",
              driverGeneration: 1,
            }),
          );
        }),
      ),
  );
});

layer("ComputerUsePrimitiveChannel while a driver starts", (it) => {
  it.effect("a call waits for a starting driver to bind, inside its own budget", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const leases = yield* ComputerUseLeases.ComputerUseLeases;
        const channel = yield* PrimitiveChannel.make;
        const threadId = ThreadId.make("thread-channel-starting-driver");
        const control = yield* leases.control(threadId, Option.none());
        const authority = {
          threadId,
          attachmentGeneration: "attachment:one",
          proxyChannelToken: "channel:secret",
        };
        yield* channel.issue({
          ...authority,
          controlId: control.controlId,
          expiresAt: Number.MAX_SAFE_INTEGER,
        });
        const call = {
          threadId,
          runId: "run:one",
          turnId: "turn:one",
          callId: 1,
          deadlineMillis: 30_000,
          tool: "list_apps",
          args: {},
        };
        // No proxy has registered, so no driver will bind: the call does not wait.
        const unregistered = yield* Effect.flip(channel.request({ ...call, callId: 0 }));
        assert.equal(unregistered.reason, "desktop_not_ready");
        const registered = yield* channel.registerStream({
          ...authority,
          proxyInstanceId: "proxy:one",
          kind: "thread",
        });
        if (registered.status !== "registered") throw new Error("expected registration");
        const delivered = yield* Stream.runHead(registered.requests).pipe(Effect.forkChild);
        // No driver has bound yet, as after a new turn or a replaced child.
        const waiting = yield* channel
          .request(call)
          .pipe(Effect.forkChild({ startImmediately: true }));
        assert.isTrue(
          yield* channel.reportControlReady({
            ...authority,
            registrationId: registered.registrationId,
            controlId: control.controlId,
            connectionId: "driver:1",
            driverGeneration: 1,
          }),
        );
        const request = Option.getOrThrow(yield* Fiber.join(delivered));
        assert.equal(request.state === "primitive-request" && request.tool, "list_apps");
        yield* Fiber.interrupt(waiting);
        // A driver that never binds: the call fails retryably once its wait passes.
        yield* channel.reportControlCutoff({
          ...authority,
          registrationId: registered.registrationId,
          controlId: control.controlId,
          connectionId: "driver:1",
          driverGeneration: 1,
        });
        const unbound = yield* channel
          .request({ ...call, callId: 2 })
          .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust(PrimitiveChannel.DRIVER_BIND_WAIT_MS);
        const failed = yield* Fiber.join(unbound);
        assert.isTrue(failed._tag === "Failure" && failed.failure.reason === "desktop_not_ready");
        // Its proxy going away while a call waits ends the wait at once.
        const orphaned = yield* Effect.flip(channel.request({ ...call, callId: 3 })).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* channel.closeStream({ threadId, registrationId: registered.registrationId });
        assert.equal((yield* Fiber.join(orphaned)).reason, "desktop_not_ready");
      }),
    ),
  );
});
