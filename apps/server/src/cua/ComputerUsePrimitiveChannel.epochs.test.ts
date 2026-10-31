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
import * as Schema from "effect/Schema";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import * as PrimitiveChannel from "./ComputerUsePrimitiveChannel.ts";
import { primitiveReplySink } from "./ComputerUseLeaseProxyOptions.ts";
import { terminalSink } from "./ComputerUseLeaseProxyPersonStop.ts";
import { terminalReplyState } from "./ComputerUseTerminal.ts";
const decodeSafety = Schema.decodeUnknownOption(
  Schema.Struct({
    structuredContent: Schema.Struct({
      code: Schema.String,
      safety: Schema.Struct({ possibleCommit: Schema.Boolean, retryClass: Schema.String }),
    }),
  }),
);

it.effect.each([
  "stop then result lock",
  "stop then rpc lock",
  "lock then stop",
  "lock then resume then stop",
  "stop then lock",
  "nested stop",
  "rpc error stop",
  "status without isError",
  "lock then reconnect stopped",
])("a pending primitive merges %s", (order) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:epochs");
    const controlId = "control:epochs";
    const signals = yield* PubSub.unbounded<void>();
    const reading = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const clock = yield* Clock.Clock;
    let hold = false;
    let recoveredStop = false;
    yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
    let notify: Parameters<
      NonNullable<ComputerUseLeases.ComputerUseLeases["Service"]["onAuthorityChange"]>
    >[0] = () => {};
    const leases = yield* ComputerUseLeases.ComputerUseLeases.pipe(
      Effect.provide(
        Layer.mock(ComputerUseLeases.ComputerUseLeases)({
          proxy: undefined,
          currentControl: () =>
            Effect.succeedSome({ controlId, threadId, expiresAt: DateTime.makeUnsafe(60000) }),
          controlState: () =>
            Effect.succeed<ComputerUseLeases.ComputerUseControlState>(
              recoveredStop
                ? { _tag: "ended", reason: "stopped" }
                : {
                    _tag: "active",
                    expiresAt: DateTime.makeUnsafe(60000),
                    interruptions: { count: 0, last: "screen_locked" },
                    apps: undefined,
                    wakeAt: 60000,
                  },
            ),
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
    const first = Option.getOrThrow(yield* Stream.runHead(registered.requests));
    if (first.state !== "primitive-request") return assert.fail("expected primitive");
    if (order === "stop then result lock" || order === "stop then rpc lock") {
      notify({ kind: "stop", threadId, controlId, terminal: "stopped_by_person" });
      const terminal = {
        code: "screen_locked",
        safety: { possibleCommit: true, retryClass: "never" },
      };
      yield* channel.reply({
        ...authority,
        registrationId: registered.registrationId,
        reply: {
          ...first,
          status: "unknown_outcome",
          ...(order === "stop then result lock"
            ? { result: { isError: true, structuredContent: terminal } }
            : { error: { code: -32000, data: terminal } }),
        },
      });
      const answer = yield* Fiber.join(pending);
      const actual = terminalReplyState(answer.result, answer.status);
      assert.equal(actual.reason, "stopped_by_person");
      assert.isTrue(actual.terminalSafety);
      assert.isTrue(actual.possibleCommit);
      return;
    }
    if (
      order === "nested stop" ||
      order === "status without isError" ||
      order === "rpc error stop"
    ) {
      yield* channel.reply({
        ...authority,
        registrationId: registered.registrationId,
        reply: {
          ...first,
          status: "unknown_outcome",
          ...(order === "rpc error stop"
            ? {
                error: {
                  code: -32000,
                  data: { code: "stopped_by_person", safety: { possibleCommit: true } },
                },
              }
            : {}),
          result: {
            ...(order !== "status without isError" ? { isError: true } : {}),
            structuredContent: {
              code: "screen_locked",
              refusal: { code: order === "rpc error stop" ? "screen_locked" : "stopped_by_person" },
              safety: { retryClass: "never", possibleCommit: order !== "rpc error stop" },
            },
          },
        },
      });
      const answer = yield* Fiber.join(pending);
      const decoded = decodeSafety(answer.result);
      assert.isTrue(Option.isSome(decoded));
      if (Option.isSome(decoded)) {
        assert.equal(decoded.value.structuredContent.code, "stopped_by_person");
        assert.isTrue(decoded.value.structuredContent.safety.possibleCommit);
        assert.equal(decoded.value.structuredContent.safety.retryClass, "never");
      }
      return;
    }
    hold = true;
    const stop = () => notify({ kind: "stop", threadId, controlId, terminal: "stopped_by_person" });
    if (order === "stop then lock") stop();
    yield* channel.reportControlCutoff({ ...report, terminal: "screen_locked" });
    yield* Deferred.await(reading);
    if (order === "lock then reconnect stopped") {
      yield* channel.closeStream({ threadId, registrationId: registered.registrationId });
      recoveredStop = true;
      const reconnected = yield* channel.registerStream({
        ...authority,
        proxyInstanceId: "next",
        kind: "thread",
      });
      if (reconnected.status !== "registered") return assert.fail("expected re-registration");
    }
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
    if (order !== "stop then lock" && order !== "lock then reconnect stopped") stop();
    yield* Deferred.succeed(release, undefined);
    const answer = yield* Fiber.join(pending);
    assert.include(JSON.stringify(answer), '"code":"stopped_by_person"');
  }),
);

it.effect("a later control does not inherit the old control's Stop", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:other-control");
    const signals = yield* PubSub.unbounded<void>();
    let current = "A";
    let notify: Parameters<
      NonNullable<ComputerUseLeases.ComputerUseLeases["Service"]["onAuthorityChange"]>
    >[0] = () => {};
    const expiresAt = DateTime.makeUnsafe(60000);
    const leases = yield* ComputerUseLeases.ComputerUseLeases.pipe(
      Effect.provide(
        Layer.mock(ComputerUseLeases.ComputerUseLeases)({
          proxy: undefined,
          currentControl: () =>
            Effect.sync(() => Option.some({ controlId: current, threadId, expiresAt })),
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
    notify({ kind: "stop", threadId, controlId: "A", terminal: "stopped_by_person" });
    current = "B";
    yield* channel.reportControlReady({
      ...authority,
      registrationId: registered.registrationId,
      controlId: "B",
      connectionId: "B:1",
      driverGeneration: 1,
    });
    const pending = yield* channel
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
    const request = Option.getOrThrow(
      yield* registered.requests.pipe(
        Stream.filter((event) => event.state === "primitive-request"),
        Stream.runHead,
      ),
    );
    if (request.state !== "primitive-request") return assert.fail("expected primitive");
    yield* channel.reply({
      ...authority,
      registrationId: registered.registrationId,
      reply: { ...request, status: "settled", result: { content: [] } },
    });
    const answer = yield* Fiber.join(pending);
    assert.equal(answer.status, "settled");
    assert.notInclude(JSON.stringify(answer), "stopped_by_person");
  }),
);

it.effect.each(["stopped_by_person", "screen_locked"] as const)(
  "retains oversized %s replies through the primitive channel",
  (reason) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:budget");
      const controlId = "control:budget";
      const signals = yield* PubSub.unbounded<void>();
      const leases = yield* ComputerUseLeases.ComputerUseLeases.pipe(
        Effect.provide(
          Layer.mock(ComputerUseLeases.ComputerUseLeases)({
            proxy: undefined,
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
            onAuthorityChange: () => () => {},
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
      yield* channel.reportControlReady({
        ...authority,
        registrationId: registered.registrationId,
        controlId,
        connectionId: "g1",
        driverGeneration: 1,
      });
      const pending = yield* channel
        .request({
          threadId,
          runId: "r",
          turnId: "t",
          callId: 1,
          deadlineMillis: 30000,
          tool: "click",
          args: {},
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      const request = Option.getOrThrow(yield* Stream.runHead(registered.requests));
      if (request.state !== "primitive-request") return assert.fail("expected primitive");
      const raw = primitiveReplySink(request, (reply) =>
        channel.reply({ ...authority, registrationId: registered.registrationId, reply }),
      );
      const sink = terminalSink(
        raw,
        { id: 1, method: "tools/call", params: { name: "click" } },
        () => reason,
        () => true,
      );
      yield* sink.answer(
        JSON.stringify({
          result: {
            isError: true,
            structuredContent: {
              code: reason,
              safety: { possibleCommit: true, retryClass: "never" },
            },
            content: [{ type: "text", text: "x".repeat(1024 * 1024) }],
          },
        }),
        "settled",
      );
      const result = terminalReplyState((yield* Fiber.join(pending)).result, "settled");
      assert.equal(result.reason, reason);
      assert.isTrue(result.possibleCommit);
      assert.isTrue(result.terminalSafety);
    }),
);
