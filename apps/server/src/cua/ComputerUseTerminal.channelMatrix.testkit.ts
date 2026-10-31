import { assert } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Leases from "./ComputerUseLeases.ts";
import * as PrimitiveChannel from "./ComputerUsePrimitiveChannel.ts";
import {
  replaceWithTerminal,
  type ComputerUseTerminalReason,
  type ComputerUseTerminalState,
} from "./ComputerUseTerminal.ts";

type Input = { readonly possible: boolean; readonly reasons: readonly ComputerUseTerminalReason[] };

const channelEdge = (kind: "queueClosed" | "deadline") => (input: Input) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("matrix:channel-edge");
    const expiresAt = DateTime.makeUnsafe(60000);
    const signals = yield* PubSub.unbounded<void>();
    let notify: Parameters<
      NonNullable<Leases.ComputerUseLeases["Service"]["onAuthorityChange"]>
    >[0] = () => {};
    const leases = yield* Leases.ComputerUseLeases.pipe(
      Effect.provide(
        Layer.mock(Leases.ComputerUseLeases)({
          proxy: undefined,
          currentControl: () => Effect.succeedSome({ threadId, controlId: "A", expiresAt }),
          controlState: () =>
            Effect.succeed({
              _tag: "active",
              expiresAt,
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
      Effect.provideService(Leases.ComputerUseLeases, leases),
    );
    const authority = { threadId, attachmentGeneration: "a", proxyChannelToken: "fixture" };
    yield* channel.issue({ ...authority, expiresAt: 60000 });
    const registered = yield* channel.registerStream({
      ...authority,
      proxyInstanceId: "p",
      kind: "thread",
    });
    if (registered.status !== "registered") return yield* Effect.die("registration failed");
    yield* channel.reportControlReady({
      ...authority,
      registrationId: registered.registrationId,
      controlId: "A",
      connectionId: "g",
      driverGeneration: 1,
    });
    const report = () => {
      for (const terminal of input.reasons)
        notify({
          kind: terminal === "screen_locked" ? "pause" : "stop",
          threadId,
          controlId: "A",
          terminal,
        });
    };
    let closed = false;
    const request = {
      threadId,
      runId: "run",
      turnId: "turn",
      callId: 1,
      deadlineMillis: 30000,
      tool: "list_apps",
      args: {},
      get authority(): "claimBind" {
        if (kind === "queueClosed" && !closed) {
          closed = true;
          report();
          Effect.runSync(
            channel.closeStream({ threadId, registrationId: registered.registrationId }),
          );
        }
        return "claimBind";
      },
    };
    const pending = yield* channel
      .request(request)
      .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
    if (kind === "deadline") {
      const sent = Option.getOrThrow(yield* Stream.runHead(registered.requests));
      if (sent.state !== "primitive-request") return yield* Effect.die("expected sent primitive");
      report();
      yield* TestClock.adjust(31000);
    } else assert.isTrue(closed);
    const answer = yield* Fiber.join(pending);
    if (answer._tag !== "Failure") return yield* Effect.die("expected channel refusal");
    assert.equal(answer.failure.safety?.retryClass, "never");
    return replaceWithTerminal(answer.failure);
  });

export const channelEdgeSites: ReadonlyArray<{
  readonly name: string;
  readonly undispatched: true;
  readonly run: (input: Input) => Effect.Effect<ComputerUseTerminalState, never, Scope.Scope>;
}> = [
  {
    name: "ComputerUsePrimitiveChannel.queueClosed",
    undispatched: true,
    run: channelEdge("queueClosed"),
  },
  {
    name: "ComputerUsePrimitiveChannel.deadline",
    undispatched: true,
    run: channelEdge("deadline"),
  },
];
