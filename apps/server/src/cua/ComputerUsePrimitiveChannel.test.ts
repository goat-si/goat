import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ThreadId,
  type ComputerUseControlEnd,
  type ComputerUsePrimitiveRequest,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import * as PrimitiveChannel from "./ComputerUsePrimitiveChannel.ts";

const threadId = ThreadId.make("thread:primitive");
const controlId = "control:primitive";
const authority = {
  threadId,
  attachmentGeneration: "attachment:one",
  proxyChannelToken: "channel:secret",
};
const fixture = Effect.fn("PrimitiveChannelTest.fixture")(function* () {
  const signals = yield* PubSub.unbounded<void>();
  const leases = ComputerUseLeases.ComputerUseLeases.of({
    currentControl: () => Effect.succeedSome({ controlId }),
    controlState: () => Effect.succeed({ _tag: "active" }),
    subscribe: PubSub.subscribe(signals),
  } as unknown as ComputerUseLeases.ComputerUseLeases["Service"]);
  const channel = yield* PrimitiveChannel.make.pipe(
    Effect.provideService(ComputerUseLeases.ComputerUseLeases, leases),
  );
  yield* channel.issue({ ...authority, expiresAt: 60_000 });
  const registered = yield* channel.registerStream({
    ...authority,
    proxyInstanceId: "proxy:one",
    kind: "thread",
  });
  if (registered.status !== "registered") throw new Error("expected registration");
  const report = (driverGeneration: number, connectionId = `driver:${driverGeneration}`) => ({
    ...authority,
    registrationId: registered.registrationId,
    controlId,
    connectionId,
    driverGeneration,
  });
  const request = () =>
    channel.request({
      threadId,
      runId: "run:one",
      turnId: "cell:one",
      callId: 1,
      deadlineMillis: 30_000,
      tool: "click",
      args: { pid: 123, window_id: 4 },
    });
  return {
    channel,
    rawRegistered: registered,
    registered: {
      ...registered,
      requests: registered.requests.pipe(
        Stream.filter(
          (item): item is ComputerUsePrimitiveRequest => item.state === "primitive-request",
        ),
      ),
    },
    report,
    request,
  };
});

/** The control-state fields the channel reads. */
type TurnState =
  | { readonly _tag: "active"; readonly idle?: true }
  | { readonly _tag: "ended"; readonly reason: ComputerUseControlEnd };

/** One thread whose control state a test moves between turns, Stop and revocation. */
const turnFixture = Effect.fn("PrimitiveChannelTest.turnFixture")(function* (options?: {
  readonly before?: (
    channel: PrimitiveChannel.ComputerUsePrimitiveChannel["Service"],
  ) => Effect.Effect<void>;
}) {
  const signals = yield* PubSub.unbounded<void>();
  let state: TurnState = { _tag: "active" };
  const leases = ComputerUseLeases.ComputerUseLeases.of({
    // An ended control keeps its record with the reason, as ComputerUseLeases.end writes it.
    currentControl: () =>
      Effect.sync(() =>
        Option.some(state._tag === "ended" ? { controlId, ended: state.reason } : { controlId }),
      ),
    controlState: () => Effect.sync(() => state),
    subscribe: PubSub.subscribe(signals),
  } as unknown as ComputerUseLeases.ComputerUseLeases["Service"]);
  const channel = yield* PrimitiveChannel.make.pipe(
    Effect.provideService(ComputerUseLeases.ComputerUseLeases, leases),
  );
  if (options?.before !== undefined) yield* options.before(channel);
  yield* channel.issue({ ...authority, controlId, expiresAt: 60_000 });
  const registration = yield* channel.registerStream({
    ...authority,
    proxyInstanceId: "proxy:one",
    kind: "thread",
  });
  if (registration.status !== "registered") throw new Error("expected registration");
  return {
    channel,
    registration,
    setState: (next: TurnState) =>
      Effect.sync(() => {
        state = next;
      }).pipe(Effect.andThen(PubSub.publish(signals, undefined))),
    report: (current: typeof authority, driverGeneration: number) => ({
      ...current,
      registrationId: registration.registrationId,
      controlId,
      connectionId: `driver:${driverGeneration}`,
      driverGeneration,
    }),
    request: () =>
      channel.request({
        threadId,
        runId: "run:one",
        turnId: "cell:one",
        callId: 1,
        deadlineMillis: 30_000,
        tool: "click",
        args: {},
      }),
  };
});

describe("ComputerUsePrimitiveChannel", () => {
  it.effect("a terminal driver cutoff settles before a delayed stop report", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      assert.isTrue(yield* f.channel.reportControlReady(f.report(1)));
      const waiter = yield* f.request().pipe(Effect.forkChild);
      yield* Stream.runHead(f.registered.requests);
      assert.isTrue(
        yield* f.channel.reportControlCutoff({ ...f.report(1), terminal: "stopped_by_person" }),
      );
      const answer = yield* Fiber.join(waiter);
      assert.include(JSON.stringify(answer), '"code":"stopped_by_person"');
      assert.include(JSON.stringify(answer), '"retryClass":"never"');
    }),
  );
  it.effect("a stop settles an in-flight call with its terminal person reason", () =>
    Effect.gen(function* () {
      const f = yield* turnFixture();
      assert.isTrue(yield* f.channel.reportControlReady(f.report(authority, 1)));
      const waiter = yield* f.request().pipe(Effect.forkChild);
      yield* Stream.runHead(f.registration.requests);
      yield* f.setState({ _tag: "ended", reason: "stopped_all" });
      const answer = yield* Fiber.join(waiter);
      assert.include(JSON.stringify(answer), '"code":"stopped_by_person"');
      assert.include(JSON.stringify(answer), '"retryClass":"never"');
    }),
  );
  it.effect("cancel after delivery emits a proxy marker for the admitted request", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      assert.isTrue(yield* f.channel.reportControlReady(f.report(1)));
      const waiter = yield* f.request().pipe(Effect.forkChild);
      const request = Option.getOrThrow(yield* Stream.runHead(f.registered.requests));
      yield* f.channel.cancel("run:one", "cell:one");
      assert.equal((yield* Fiber.join(waiter)).status, "unknown_outcome");
      const marker = Option.getOrThrow(yield* Stream.runHead(f.rawRegistered.requests));
      assert.deepEqual(marker, { state: "primitive-cancel", requestId: request.requestId });
    }),
  );

  it.effect("cursor bursts do not close registration or block a following primitive", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      assert.isTrue(yield* f.channel.reportControlReady(f.report(1)));
      for (let sequence = 1; sequence <= 64; sequence++)
        assert.isTrue(
          yield* f.channel.cursor({
            threadId,
            event: {
              op: "show",
              phase: "thinking",
              identity: {
                environmentId: EnvironmentId.make("environment"),
                runId: "run",
                turnId: "turn",
                targetId: "target",
                generation: 1,
                sequence,
              },
            },
          }),
        );
      const waiter = yield* f.request().pipe(Effect.forkChild);
      assert.equal(
        Option.getOrThrow(yield* Stream.runHead(f.registered.requests)).state,
        "primitive-request",
      );
      yield* f.channel.cancel("run:one", "cell:one");
      assert.equal((yield* Fiber.join(waiter)).status, "unknown_outcome");
    }),
  );
  it.effect("routes a scoped cursor state to the live proxy without a driver call", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      assert.isTrue(yield* f.channel.reportControlReady(f.report(1)));
      const event = {
        op: "show" as const,
        phase: "thinking" as const,
        identity: {
          environmentId: EnvironmentId.make("environment"),
          runId: "run",
          turnId: "turn",
          targetId: "target",
          generation: 1,
          sequence: 1,
        },
      };
      assert.isTrue(yield* f.channel.cursor({ threadId, event }));
      assert.deepEqual(Option.getOrThrow(yield* Stream.runHead(f.rawRegistered.requests)), {
        state: "cursor-state",
        controlId,
        connectionGeneration: "driver:1",
        event,
      });
    }),
  );
  it.effect("stale connection generation refuses before enqueue", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      assert.isTrue(yield* f.channel.reportControlReady(f.report(1)));
      const result = yield* f.channel
        .request({
          threadId,
          runId: "run:one",
          turnId: "cell:one",
          callId: 2,
          deadlineMillis: 30_000,
          tool: "click",
          args: {},
          expectedConnectionGeneration: "driver:0",
        })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.code, "stale_reference");
        assert.isFalse(result.failure.effectStarted);
      }
      yield* f.channel.closeStream({ threadId, registrationId: f.registered.registrationId });
    }),
  );
  it.effect(
    "a thread's next turn reaches the desktop through the proxy it registered in its first turn",
    () =>
      Effect.gen(function* () {
        const t = yield* turnFixture();
        assert.isTrue(yield* t.channel.reportControlReady(t.report(authority, 0)));
        const pending = yield* t.request().pipe(Effect.forkChild);
        yield* Stream.runHead(t.registration.requests);
        yield* t.setState({ _tag: "active", idle: true });
        assert.equal((yield* Fiber.join(pending)).status, "unknown_outcome");
        assert.equal(
          yield* t.channel.authenticate({
            threadId,
            proxyChannelToken: authority.proxyChannelToken,
          }),
          authority.attachmentGeneration,
        );
        const idle = yield* Effect.flip(t.request());
        assert.equal(idle.reason, "desktop_not_ready");
        // Waiting cannot bring back a control that is not live; the agent is told how to ask.
        assert.include(idle.nextStep, 'goat_call {path:"computer_use.request"}');

        yield* t.setState({ _tag: "active" });
        const next = { ...authority, attachmentGeneration: "attachment:two" };
        yield* t.channel.issue({ ...next, controlId, expiresAt: 60_000 });
        assert.equal(
          yield* t.channel.authenticate({
            threadId,
            proxyChannelToken: authority.proxyChannelToken,
          }),
          next.attachmentGeneration,
        );
        assert.isTrue(yield* t.channel.reportControlCutoff(t.report(next, 0)));
        assert.isTrue(yield* t.channel.reportControlReady(t.report(next, 1)));
        const waiter = yield* t.request().pipe(Effect.forkChild);
        const delivered = Option.getOrThrow(
          yield* Stream.runHead(
            t.registration.requests.pipe(
              Stream.filter(
                (item): item is ComputerUsePrimitiveRequest => item.state === "primitive-request",
              ),
            ),
          ),
        );
        assert.equal(delivered.registrationId, t.registration.registrationId);
        assert.equal(delivered.connectionGeneration, "driver:1");
        yield* t.channel.cancel("run:one", "cell:one");
        assert.equal((yield* Fiber.join(waiter)).status, "unknown_outcome");
      }).pipe(Effect.scoped),
  );

  it.effect.each(["stopped", "stopped_all"] as const)(
    "%s cancels in-flight input and the next turn reuses the same proxy registration",
    (reason) =>
      Effect.gen(function* () {
        const t = yield* turnFixture();
        assert.isTrue(yield* t.channel.reportControlReady(t.report(authority, 0)));
        const pending = yield* t.request().pipe(Effect.forkChild);
        const delivered = Option.getOrThrow(yield* Stream.runHead(t.registration.requests));
        yield* t.setState({ _tag: "ended", reason });
        assert.equal((yield* Fiber.join(pending)).status, "unknown_outcome");
        assert.deepEqual(Option.getOrThrow(yield* Stream.runHead(t.registration.requests)), {
          state: "primitive-cancel",
          requestId: (delivered as ComputerUsePrimitiveRequest).requestId,
        });
        assert.equal((yield* Effect.flip(t.request())).reason, "desktop_not_ready");

        const next = { ...authority, attachmentGeneration: "attachment:two" };
        yield* t.setState({ _tag: "active" });
        yield* t.channel.issue({ ...next, controlId, expiresAt: 60_000 });
        assert.isTrue(yield* t.channel.reportControlReady(t.report(next, 1)));
        const waiter = yield* t.request().pipe(Effect.forkChild);
        const resumed = Option.getOrThrow(yield* Stream.runHead(t.registration.requests));
        assert.equal(resumed.state, "primitive-request");
        yield* t.channel.cancel("run:one", "cell:one");
        assert.equal((yield* Fiber.join(waiter)).status, "unknown_outcome");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a control that expires leaves the thread proxy authorized to report its cutoff and the next turn's ready",
    () =>
      Effect.gen(function* () {
        const t = yield* turnFixture();
        assert.isTrue(yield* t.channel.reportControlReady(t.report(authority, 0)));
        yield* TestClock.adjust(60_000);
        yield* t.setState({ _tag: "ended", reason: "expired" });
        // The proxy's reporter stops for good on a 401, so the cutoff route must still authorize.
        assert.equal(
          yield* t.channel.authenticate({
            threadId,
            proxyChannelToken: authority.proxyChannelToken,
          }),
          authority.attachmentGeneration,
        );
        assert.isTrue(yield* t.channel.reportControlCutoff(t.report(authority, 0)));
        assert.equal((yield* Effect.flip(t.request())).reason, "desktop_not_ready");

        const next = { ...authority, attachmentGeneration: "attachment:two" };
        yield* t.setState({ _tag: "active" });
        yield* t.channel.issue({ ...next, controlId, expiresAt: 120_000 });
        assert.isTrue(yield* t.channel.reportControlReady(t.report(next, 1)));
        const waiter = yield* t.channel
          .request({
            threadId,
            runId: "run:one",
            turnId: "cell:one",
            callId: 2,
            deadlineMillis: 90_000,
            tool: "click",
            args: {},
          })
          .pipe(Effect.forkChild);
        const resumed = Option.getOrThrow(yield* Stream.runHead(t.registration.requests));
        assert.equal(resumed.state, "primitive-request");
        yield* t.channel.cancel("run:one", "cell:one");
        assert.equal((yield* Fiber.join(waiter)).status, "unknown_outcome");
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    ["idle", { _tag: "active", idle: true }],
    ["stopped", { _tag: "ended", reason: "stopped" }],
  ] as const)(
    "an attachment that goes %s before its thread proxy registers still admits that proxy",
    ([, state]) =>
      Effect.gen(function* () {
        const early = ThreadId.make("thread:proxy-not-yet-registered");
        const earlyAuthority = { ...authority, threadId: early };
        const t = yield* turnFixture({
          before: (channel) => channel.issue({ ...earlyAuthority, controlId, expiresAt: 60_000 }),
        });
        assert.isTrue(yield* t.channel.reportControlReady(t.report(authority, 0)));
        const pending = yield* t.request().pipe(Effect.forkChild);
        yield* Stream.runHead(t.registration.requests);
        yield* t.setState(state);
        // The sweep settles this thread's request after it has passed the earlier attachment.
        assert.equal((yield* Fiber.join(pending)).status, "unknown_outcome");
        const late = yield* t.channel.registerStream({
          ...earlyAuthority,
          proxyInstanceId: "proxy:late",
          kind: "thread",
        });
        assert.equal(late.status, "registered");
      }).pipe(Effect.scoped),
  );

  it.effect.each(["revoked", "disabled", "unauthorized"] as const)(
    "a control ended as %s closes the channel and quarantines in-flight input",
    (reason) =>
      Effect.gen(function* () {
        const t = yield* turnFixture();
        assert.isTrue(yield* t.channel.reportControlReady(t.report(authority, 0)));
        const pending = yield* t.request().pipe(Effect.forkChild);
        yield* Stream.runHead(t.registration.requests);
        yield* t.setState({ _tag: "ended", reason });
        assert.equal((yield* Fiber.join(pending)).status, "unknown_outcome");
        assert.isUndefined(
          yield* t.channel.authenticate({
            threadId,
            proxyChannelToken: authority.proxyChannelToken,
          }),
        );
        const next = { ...authority, attachmentGeneration: "attachment:two" };
        yield* t.setState({ _tag: "active" });
        yield* t.channel.issue({ ...next, controlId, expiresAt: 60_000 });
        assert.isFalse(yield* t.channel.reportControlReady(t.report(next, 1)));
      }).pipe(Effect.scoped),
  );

  it.effect(
    "an explicit revoke closes the channel even when the next attachment reuses the token",
    () =>
      Effect.gen(function* () {
        const t = yield* turnFixture();
        assert.isTrue(yield* t.channel.reportControlReady(t.report(authority, 0)));
        yield* t.channel.revoke({ threadId, proxyChannelToken: authority.proxyChannelToken });
        assert.isUndefined(
          yield* t.channel.authenticate({
            threadId,
            proxyChannelToken: authority.proxyChannelToken,
          }),
        );
        const next = { ...authority, attachmentGeneration: "attachment:two" };
        yield* t.channel.issue({ ...next, controlId, expiresAt: 60_000 });
        assert.isFalse(yield* t.channel.reportControlReady(t.report(next, 1)));
        assert.equal((yield* Effect.flip(t.request())).reason, "desktop_not_ready");
        const reconnected = yield* t.channel.registerStream({
          ...next,
          proxyInstanceId: "proxy:two",
          kind: "thread",
        });
        assert.equal(reconnected.status, "registered");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "second registrant is refused until EOF and a reconnect may start at generation zero",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const second = () =>
          f.channel.registerStream({ ...authority, proxyInstanceId: "proxy:two", kind: "thread" });
        assert.equal((yield* second()).status, "conflict");
        yield* f.channel.closeStream({ threadId, registrationId: f.registered.registrationId });
        const replacement = yield* second();
        assert.equal(replacement.status, "registered");
        if (replacement.status !== "registered") return;
        assert.isTrue(
          yield* f.channel.reportControlReady({
            ...f.report(0),
            registrationId: replacement.registrationId,
          }),
        );
        assert.isFalse(yield* f.channel.reportControlReady(f.report(1)));
      }),
  );

  it.effect("attachment replacement revokes the old token and quarantines its pending reply", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      assert.isTrue(yield* f.channel.reportControlReady(f.report(0)));
      const waiter = yield* f.request().pipe(Effect.forkChild);
      const delivered = Option.getOrThrow(yield* Stream.runHead(f.registered.requests));
      yield* f.channel.issue({
        threadId,
        attachmentGeneration: "attachment:two",
        proxyChannelToken: "channel:new-secret",
        expiresAt: 60_000,
      });
      yield* f.channel.revoke({ threadId, proxyChannelToken: authority.proxyChannelToken });
      assert.equal(
        yield* f.channel.authenticate({ threadId, proxyChannelToken: "channel:new-secret" }),
        "attachment:two",
      );
      assert.equal((yield* Fiber.join(waiter)).status, "unknown_outcome");
      assert.isUndefined(
        yield* f.channel.authenticate({ threadId, proxyChannelToken: authority.proxyChannelToken }),
      );
      assert.isFalse(
        yield* f.channel.reply({
          ...authority,
          registrationId: f.registered.registrationId,
          reply: {
            requestId: delivered.requestId,
            registrationId: delivered.registrationId,
            controlId: delivered.controlId,
            connectionGeneration: delivered.connectionGeneration,
            runId: delivered.runId,
            turnId: delivered.turnId,
            callId: delivered.callId,
            status: "settled",
          },
        }),
      );
    }),
  );

  it.effect("attachment replacement before registration remains available to the new proxy", () =>
    Effect.gen(function* () {
      const signals = yield* PubSub.unbounded<void>();
      const leases = ComputerUseLeases.ComputerUseLeases.of({
        currentControl: () => Effect.succeedSome({ controlId }),
        controlState: () => Effect.succeed({ _tag: "active" }),
        subscribe: PubSub.subscribe(signals),
      } as unknown as ComputerUseLeases.ComputerUseLeases["Service"]);
      const channel = yield* PrimitiveChannel.make.pipe(
        Effect.provideService(ComputerUseLeases.ComputerUseLeases, leases),
      );
      yield* channel.issue({ ...authority, expiresAt: 60_000 });
      yield* channel.issue({
        threadId,
        attachmentGeneration: "attachment:two",
        proxyChannelToken: "channel:new-secret",
        expiresAt: 60_000,
      });
      assert.equal(
        yield* channel.authenticate({ threadId, proxyChannelToken: "channel:new-secret" }),
        "attachment:two",
      );
    }),
  );

  it.effect("duplicate ready is refused and an older cutoff cannot clear a newer driver", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      assert.isTrue(yield* f.channel.reportControlReady(f.report(1)));
      assert.isFalse(yield* f.channel.reportControlReady(f.report(1)));
      assert.isTrue(yield* f.channel.reportControlCutoff(f.report(0)));
      const waiter = yield* f.request().pipe(Effect.forkChild);
      const delivered = Option.getOrThrow(yield* Stream.runHead(f.registered.requests));
      assert.equal(delivered.connectionGeneration, "driver:1");
      yield* f.channel.cancel("run:one", "cell:one");
      assert.equal((yield* Fiber.join(waiter)).status, "unknown_outcome");
    }),
  );

  it.effect(
    "cutoff before ready rejects that generation and only a higher ready restores delivery",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        assert.isTrue(yield* f.channel.reportControlCutoff(f.report(0)));
        assert.isFalse(yield* f.channel.reportControlReady(f.report(0)));
        // The control is active and its driver was cut off: the call waits for a restart.
        const unbound = yield* Effect.flip(f.request()).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* TestClock.adjust(PrimitiveChannel.DRIVER_BIND_WAIT_MS);
        assert.equal((yield* Fiber.join(unbound)).reason, "desktop_not_ready");
        assert.isTrue(yield* f.channel.reportControlReady(f.report(1)));
        const waiter = yield* f.request().pipe(Effect.forkChild);
        const delivered = Option.getOrThrow(yield* Stream.runHead(f.registered.requests));
        assert.equal(delivered.connectionGeneration, "driver:1");
        assert.isTrue(
          yield* f.channel.reply({
            ...authority,
            registrationId: f.registered.registrationId,
            reply: {
              requestId: delivered.requestId,
              registrationId: delivered.registrationId,
              controlId: delivered.controlId,
              connectionGeneration: delivered.connectionGeneration,
              runId: delivered.runId,
              turnId: delivered.turnId,
              callId: delivered.callId,
              status: "settled",
              result: { ok: true },
            },
          }),
        );
        assert.equal((yield* Fiber.join(waiter)).status, "settled");
      }),
  );

  it.effect("a higher cutoff clears an older binding and quarantines sent work", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      assert.isTrue(yield* f.channel.reportControlReady(f.report(0)));
      const waiter = yield* f.request().pipe(Effect.forkChild);
      yield* Stream.runHead(f.registered.requests);
      assert.isTrue(yield* f.channel.reportControlCutoff(f.report(1)));
      assert.equal((yield* Fiber.join(waiter)).status, "unknown_outcome");
      // The control is active and its driver was cut off: the call waits for a restart.
      const unbound = yield* Effect.flip(f.request()).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust(PrimitiveChannel.DRIVER_BIND_WAIT_MS);
      assert.equal((yield* Fiber.join(unbound)).reason, "desktop_not_ready");
      assert.isFalse(yield* f.channel.reportControlReady(f.report(1)));
    }),
  );

  it.effect("a duplicate reply or prior registration cannot settle a later request", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      assert.isTrue(yield* f.channel.reportControlReady(f.report(0)));
      const waiter = yield* f.request().pipe(Effect.forkChild);
      const delivered = Option.getOrThrow(yield* Stream.runHead(f.registered.requests));
      const reply = {
        requestId: delivered.requestId,
        registrationId: delivered.registrationId,
        controlId: delivered.controlId,
        connectionGeneration: delivered.connectionGeneration,
        runId: delivered.runId,
        turnId: delivered.turnId,
        callId: delivered.callId,
        status: "settled" as const,
        result: { ok: true },
      };
      assert.isFalse(
        yield* f.channel.reply({
          ...authority,
          registrationId: f.registered.registrationId,
          reply: { ...reply, turnId: "cell:other" },
        }),
      );
      assert.isTrue(
        yield* f.channel.reply({
          ...authority,
          registrationId: f.registered.registrationId,
          reply,
        }),
      );
      assert.isFalse(
        yield* f.channel.reply({
          ...authority,
          registrationId: f.registered.registrationId,
          reply,
        }),
      );
      assert.equal((yield* Fiber.join(waiter)).status, "settled");
      yield* f.channel.closeStream({ threadId, registrationId: f.registered.registrationId });
      assert.isFalse(yield* f.channel.reportControlReady(f.report(1)));
    }),
  );
});

describe("ComputerUsePrimitiveChannel while a control is replaced", () => {
  it.effect("a call waiting for a driver never crosses into a successor control", () =>
    Effect.gen(function* () {
      const signals = yield* PubSub.unbounded<void>();
      let current = "control:a";
      const leases = ComputerUseLeases.ComputerUseLeases.of({
        currentControl: () => Effect.sync(() => Option.some({ controlId: current })),
        controlState: () => Effect.succeed({ _tag: "active" }),
        subscribe: PubSub.subscribe(signals),
      } as unknown as ComputerUseLeases.ComputerUseLeases["Service"]);
      const channel = yield* PrimitiveChannel.make.pipe(
        Effect.provideService(ComputerUseLeases.ComputerUseLeases, leases),
      );
      yield* channel.issue({ ...authority, expiresAt: 60_000 });
      const registered = yield* channel.registerStream({
        ...authority,
        proxyInstanceId: "proxy:one",
        kind: "thread",
      });
      if (registered.status !== "registered") throw new Error("expected registration");
      // launch_app names no driver generation, so nothing downstream would refuse it.
      const waiting = yield* Effect.flip(
        channel.request({
          threadId,
          runId: "run:one",
          turnId: "cell:one",
          callId: 1,
          deadlineMillis: 30_000,
          tool: "launch_app",
          args: { bundle_id: "org.example.Editor" },
        }),
      ).pipe(Effect.forkChild({ startImmediately: true }));
      current = "control:b";
      assert.isTrue(
        yield* channel.reportControlReady({
          ...authority,
          registrationId: registered.registrationId,
          controlId: "control:b",
          connectionId: "driver:1",
          driverGeneration: 1,
        }),
      );
      assert.equal((yield* Fiber.join(waiting)).reason, "desktop_not_ready");
    }),
  );
});

it.effect("only forwards claimBind authority when supplied as a host request field", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    assert.isTrue(yield* f.channel.reportControlReady(f.report(1)));
    const hostCall = yield* f.channel
      .request({
        threadId,
        runId: "run:bind",
        turnId: "turn:bind",
        callId: 1,
        deadlineMillis: 30_000,
        tool: "get_browser_state",
        authority: "claimBind",
        args: { pid: 123, window_id: 4, mode: "bind", origin_scope: ["https://example.test"] },
      })
      .pipe(Effect.forkChild({ startImmediately: true }));
    const host = Option.getOrThrow(yield* Stream.runHead(f.registered.requests));
    assert.equal(host.authority, "claimBind");
    yield* f.channel.cancel("run:bind", "turn:bind");
    yield* Fiber.join(hostCall);
    const agentCall = yield* f.channel
      .request({
        threadId,
        runId: "run:cell",
        turnId: "turn:cell",
        callId: 2,
        deadlineMillis: 30_000,
        tool: "get_browser_state",
        args: { authority: "claimBind", pid: 123, window_id: 4 },
      })
      .pipe(Effect.forkChild({ startImmediately: true }));
    const agent = Option.getOrThrow(yield* Stream.runHead(f.registered.requests));
    assert.isUndefined(agent.authority);
    yield* f.channel.cancel("run:cell", "turn:cell");
    yield* Fiber.join(agentCall);
  }),
);
