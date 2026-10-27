import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

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
