import { expect, it } from "@effect/vitest";
import { TailscaleStatusParseError } from "@goat/tailscale";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/http";
import * as Layer from "effect/Layer";
import * as NetAddress from "effect/net/NetAddress";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import {
  layerTailscaleServeStartupWith,
  type TailscaleServeTarget,
} from "./TailscaleServeStartup.ts";

const httpServer = (address: NetAddress.SocketAddress) =>
  Layer.succeed(
    HttpServer.HttpServer,
    HttpServer.HttpServer.of({
      address,
      serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
    }),
  );

const loopback = httpServer(NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773));

// The first status read fails as it does before tailscaled answers, then the port is free.
const readyAfterOneRead = Effect.fn("TailscaleServeStartup.test.readyAfterOneRead")(function* () {
  const reads = yield* Ref.make(0);
  return () =>
    Ref.getAndUpdate(reads, (count) => count + 1).pipe(
      Effect.flatMap((read) =>
        read === 0 ? Effect.fail("tailscaled not running") : Effect.succeed("none" as const),
      ),
    );
});

it.effect("re-applies the saved port after a failed start", () =>
  Effect.gen(function* () {
    const calls = yield* Queue.unbounded<number>();
    const failuresLeft = yield* Ref.make(1);
    const parked = yield* Deferred.make<void>();
    const ensure = Effect.fn("TailscaleServeStartup.test.ensure")(function* (
      target: TailscaleServeTarget,
    ) {
      yield* Queue.offer(calls, target.servePort);
      const left = yield* Ref.getAndUpdate(failuresLeft, (count) => (count > 0 ? count - 1 : 0));
      if (left > 0) return yield* Effect.fail("tailscaled not ready");
    });
    const layer = layerTailscaleServeStartupWith({
      enabled: true,
      servePort: 47743,
      parked,
      awaitActivation: Effect.void,
      ensure,
      disable: () => Effect.void,
      rootHolder: yield* readyAfterOneRead(),
    }).pipe(Layer.provide(loopback));

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(layer);
        yield* TestClock.adjust(Duration.seconds(2));
        expect(yield* Queue.take(calls)).toBe(47743);
        yield* TestClock.adjust(Duration.seconds(3));
        expect(yield* Queue.take(calls)).toBe(47743);
      }),
    );
  }),
);

it.effect("applies Serve once Tailscale answers a status read that failed at start", () =>
  Effect.gen(function* () {
    const calls = yield* Queue.unbounded<number>();
    const parked = yield* Deferred.make<void>();
    const layer = layerTailscaleServeStartupWith({
      enabled: true,
      servePort: 47743,
      parked,
      awaitActivation: Effect.void,
      ensure: (target) => Queue.offer(calls, target.servePort).pipe(Effect.asVoid),
      disable: () => Effect.void,
      rootHolder: yield* readyAfterOneRead(),
    }).pipe(Layer.provide(loopback));

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(layer);
        expect(yield* Queue.size(calls)).toBe(0);
        yield* TestClock.adjust(Duration.seconds(2));
        expect(yield* Queue.take(calls)).toBe(47743);
        expect(yield* Queue.size(calls)).toBe(0);
      }),
    );
  }),
);

it.effect("turns the saved port off after a successful apply", () =>
  Effect.gen(function* () {
    const disabled = yield* Queue.unbounded<number>();
    const applied = yield* Deferred.make<number>();
    const parked = yield* Deferred.make<void>();
    const ensure = Effect.fn("TailscaleServeStartup.test.ensureSucceeds")(function* (
      target: TailscaleServeTarget,
    ) {
      yield* Deferred.succeed(applied, target.servePort);
    });
    const layer = layerTailscaleServeStartupWith({
      enabled: true,
      servePort: 47743,
      parked,
      awaitActivation: Effect.void,
      ensure,
      disable: (request: { readonly servePort: number }) =>
        Queue.offer(disabled, request.servePort).pipe(Effect.asVoid),
    }).pipe(Layer.provide(loopback));

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(layer);
        expect(yield* Deferred.await(applied)).toBe(47743);
      }),
    );
    expect(yield* Queue.take(disabled)).toBe(47743);
  }),
);

it.effect("does not turn Serve off when no attempt started", () =>
  Effect.gen(function* () {
    const disabled = yield* Ref.make<ReadonlyArray<number>>([]);
    const ensured = yield* Ref.make(0);
    const parked = yield* Deferred.make<void>();
    const layer = layerTailscaleServeStartupWith({
      enabled: true,
      servePort: 47743,
      parked,
      awaitActivation: Effect.void,
      ensure: () => Ref.update(ensured, (count) => count + 1),
      disable: (request: { readonly servePort: number }) =>
        Ref.update(disabled, (ports) => [...ports, request.servePort]),
    }).pipe(Layer.provide(httpServer(NetAddress.unixPathAddress("/tmp/goat.sock"))));

    yield* Effect.scoped(Layer.build(layer));
    expect(yield* Ref.get(ensured)).toBe(0);
    expect(yield* Ref.get(disabled)).toEqual([]);
  }),
);

it.effect("does not apply or disable a Windows-reserved port", () =>
  Effect.gen(function* () {
    const ensured = yield* Ref.make(0);
    const disabled = yield* Ref.make(0);
    const parked = yield* Deferred.make<void>();
    const layer = layerTailscaleServeStartupWith({
      enabled: true,
      servePort: 46743,
      parked,
      awaitActivation: Effect.void,
      ensure: () => Ref.update(ensured, (count) => count + 1),
      disable: () => Ref.update(disabled, (count) => count + 1),
      excludedRange: () => Effect.succeed({ start: 46648, end: 46747, suggestion: 46748 }),
    }).pipe(Layer.provide(loopback));

    yield* Effect.scoped(Layer.build(layer));
    expect(yield* Ref.get(ensured)).toBe(0);
    expect(yield* Ref.get(disabled)).toBe(0);
  }),
);

it.effect.each(["other", "unparseable"] as const)(
  "leaves a Serve route alone when its holder is %s, and never turns it off",
  (holder) =>
    Effect.gen(function* () {
      const ensured = yield* Ref.make(0);
      const disabled = yield* Ref.make(0);
      const checked = yield* Deferred.make<{ readonly host: string; readonly port: number }>();
      const parked = yield* Deferred.make<void>();
      const layer = layerTailscaleServeStartupWith({
        enabled: true,
        servePort: 47743,
        parked,
        awaitActivation: Effect.void,
        ensure: () => Ref.update(ensured, (count) => count + 1),
        disable: () => Ref.update(disabled, (count) => count + 1),
        rootHolder: (target) =>
          Deferred.succeed(checked, target).pipe(
            Effect.andThen(
              holder === "other"
                ? Effect.succeed(holder)
                : Effect.fail(new TailscaleStatusParseError({ cause: "not serve status JSON" })),
            ),
          ),
      }).pipe(Layer.provide(loopback));

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(layer);
          expect(yield* Deferred.await(checked)).toEqual({ host: "127.0.0.1", port: 3773 });
        }),
      );
      expect(yield* Ref.get(ensured)).toBe(0);
      expect(yield* Ref.get(disabled)).toBe(0);
    }),
);

it.effect("takes back a Serve route another server left on a dead port", () =>
  Effect.gen(function* () {
    const calls = yield* Queue.unbounded<number>();
    const holder = yield* Ref.make<"none" | "ours" | "dead" | "other">("other");
    const parked = yield* Deferred.make<void>();
    const layer = layerTailscaleServeStartupWith({
      enabled: true,
      servePort: 47743,
      parked,
      awaitActivation: Effect.void,
      ensure: (target) => Queue.offer(calls, target.servePort).pipe(Effect.asVoid),
      disable: () => Effect.void,
      rootHolder: () => Ref.get(holder),
    }).pipe(Layer.provide(loopback));

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(layer);
        yield* TestClock.adjust(Duration.seconds(30));
        expect(yield* Queue.size(calls)).toBe(0);
        yield* Ref.set(holder, "dead");
        yield* TestClock.adjust(Duration.seconds(30));
        expect(yield* Queue.take(calls)).toBe(47743);
        yield* Ref.set(holder, "ours");
        yield* TestClock.adjust(Duration.seconds(30));
        expect(yield* Queue.size(calls)).toBe(0);
      }),
    );
  }),
);

it.effect.each([
  { atStop: "other", disabled: 0 },
  { atStop: "unreadable", disabled: 0 },
  { atStop: "ours", disabled: 1 },
] as const)(
  "at stop turns the route off only while it is ours ($atStop: $disabled)",
  ({ atStop, disabled }) =>
    Effect.gen(function* () {
      const offs = yield* Ref.make(0);
      const applied = yield* Deferred.make<void>();
      const holder = yield* Ref.make<"none" | "ours" | "other" | "unreadable">("none");
      const parked = yield* Deferred.make<void>();
      const layer = layerTailscaleServeStartupWith({
        enabled: true,
        servePort: 47743,
        parked,
        awaitActivation: Effect.void,
        ensure: () => Deferred.succeed(applied, undefined).pipe(Effect.asVoid),
        disable: () => Ref.update(offs, (count) => count + 1),
        rootHolder: () =>
          Ref.get(holder).pipe(
            Effect.filterOrFail(
              (current): current is "none" | "ours" | "other" => current !== "unreadable",
              () => "tailscaled stopped",
            ),
          ),
      }).pipe(Layer.provide(loopback));

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(layer);
          yield* Deferred.await(applied);
          yield* Ref.set(holder, atStop);
        }),
      );
      expect(yield* Ref.get(offs)).toBe(disabled);
    }),
);
