import { assert, it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import * as PrimitiveChannel from "./ComputerUsePrimitiveChannel.ts";

it.effect.each(["lock then stop", "lock then resume then stop", "stop then lock"])(
  "a pending primitive merges %s",
  (order) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:epochs");
      const controlId = "control:epochs";
      const signals = yield* PubSub.unbounded<void>();
      const reading = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const clock = yield* Clock.Clock;
      let hold = false;
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
      let notify: Parameters<
        NonNullable<ComputerUseLeases.ComputerUseLeases["Service"]["onAuthorityChange"]>
      >[0] = () => {};
      const leases = yield* ComputerUseLeases.ComputerUseLeases.pipe(
        Effect.provide(
          Layer.mock(ComputerUseLeases.ComputerUseLeases)({
            currentControl: () =>
              Effect.succeedSome({ controlId, threadId, expiresAt: DateTime.makeUnsafe(60000) }),
            controlState: () =>
              Effect.succeed({
                _tag: "active",
                expiresAt: DateTime.makeUnsafe(60000),
                interruptions: { count: 0, last: "screen_locked" },
                apps: undefined,
                wakeAt: 60000,
              }),
            subscribe: PubSub.subscribe(signals),
            onAuthorityChange: (listener) => {
              notify = listener;
              return () => {};
            },
          }),
        ),
      );
      const channel = yield* PrimitiveChannel.make.pipe(
        Effect.provideService(ComputerUseLeases.ComputerUseLeases, leases),
      );
      const authority = { threadId, attachmentGeneration: "a", proxyChannelToken: "token" };
      yield* channel.issue({ ...authority, expiresAt: 60000 });
      const registered = yield* channel.registerStream({
        ...authority,
        proxyInstanceId: "p",
        kind: "thread",
      });
      if (registered.status !== "registered") return assert.fail("expected registration");
      const report = {
        ...authority,
        registrationId: registered.registrationId,
        controlId,
        connectionId: "g1",
        driverGeneration: 1,
      };
      yield* channel.reportControlReady(report);
      const pending = yield* channel
        .request({
          threadId,
          runId: "run",
          turnId: "turn",
          callId: 1,
          deadlineMillis: 30000,
          tool: "list_apps",
          args: {},
        })
        .pipe(
          Effect.provideService(Clock.Clock, {
            ...clock,
            currentTimeMillis: Effect.suspend(() =>
              hold
                ? Deferred.succeed(reading, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(clock.currentTimeMillis),
                  )
                : clock.currentTimeMillis,
            ),
          }),
          Effect.forkChild({ startImmediately: true }),
        );
      yield* Stream.runHead(registered.requests);
      hold = true;
      const stop = () =>
        notify({ kind: "stop", threadId, controlId, terminal: "stopped_by_person" });
      if (order === "stop then lock") stop();
      yield* channel.reportControlCutoff({ ...report, terminal: "screen_locked" });
      yield* Deferred.await(reading);
      if (order === "lock then resume then stop") {
        yield* channel.reportControlReady({ ...report, connectionId: "g2", driverGeneration: 2 });
        const later = yield* channel
          .request({
            threadId,
            runId: "run",
            turnId: "turn",
            callId: 2,
            deadlineMillis: 30000,
            tool: "list_apps",
            args: {},
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        const next = Option.getOrThrow(
          yield* registered.requests.pipe(
            Stream.filter((event) => event.state === "primitive-request"),
            Stream.runHead,
          ),
        );
        if (next.state !== "primitive-request") return assert.fail("expected primitive");
        yield* channel.reply({
          ...authority,
          registrationId: registered.registrationId,
          reply: { ...next, status: "settled", result: { content: [] } },
        });
        assert.equal((yield* Fiber.join(later)).status, "settled");
      }
      if (order !== "stop then lock") stop();
      yield* Deferred.succeed(release, undefined);
      const answer = yield* Fiber.join(pending);
      assert.include(JSON.stringify(answer), '"code":"stopped_by_person"');
    }),
);
