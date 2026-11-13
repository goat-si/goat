import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { SshConnectionProfile } from "./catalog.ts";
import { SshConnectionTarget } from "./model.ts";
import { penRouteConnectionId } from "./routes.ts";
import { EnvironmentRegistry } from "./registry.ts";
import {
  awaitConnectionState,
  makeHarness,
  SSH_CONNECTION,
  SSH_TARGET,
} from "./registry.testkit.ts";

const target = new SshConnectionTarget({
  ...SSH_CONNECTION,
  connectionId: penRouteConnectionId("a".repeat(26), "b".repeat(26)),
});
const profile = new SshConnectionProfile({
  environmentId: target.environmentId,
  connectionId: target.connectionId,
  label: target.label,
  target: SSH_TARGET,
});

describe("Pen connection gate", () => {
  it.effect("holds a Pen entry before the member list without changing the person's switch", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness([target], [profile]);
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry;
        yield* registry.start;
        expect((yield* registry.state(target.environmentId)).desired).toBe(false);
        yield* registry.reconnect(target.environmentId);
        yield* registry.setEnabled(target.environmentId, false);
        yield* registry.setEnabled(target.environmentId, true);
        expect((yield* registry.state(target.environmentId)).desired).toBe(false);
        yield* registry.setPenLive(new Set([target.environmentId]));
        yield* awaitConnectionState(
          registry,
          target.environmentId,
          (state) => state.phase === "connected",
        );
        yield* registry.setPenLive(new Set());
        yield* awaitConnectionState(registry, target.environmentId, (state) => !state.desired);
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(target.environmentId)?.enabled,
        ).toBe(true);
        expect(yield* Ref.get(h.disconnectedSshTargets)).toContainEqual(SSH_TARGET);
        expect(yield* Ref.get(h.storedDisabled)).toEqual(new Set());
      }).pipe(Effect.provide(h.layer));
    }),
  );
  it.effect("hold reopen hold during a stalled teardown ends torn down", () =>
    Effect.gen(function* () {
      const calls = yield* Queue.unbounded<Deferred.Deferred<void>>();
      const h = yield* makeHarness([target], [profile], [], {
        holdSshDisconnect: () =>
          Effect.gen(function* () {
            const release = yield* Deferred.make<void>();
            yield* Queue.offer(calls, release);
            yield* Deferred.await(release);
          }),
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry;
        const live = new Set([target.environmentId]);
        yield* registry.start;
        yield* registry.setPenLive(live);
        yield* awaitConnectionState(
          registry,
          target.environmentId,
          (state) => state.phase === "connected",
        );
        yield* registry.setPenLive(new Set());
        const first = yield* Queue.take(calls);
        yield* awaitConnectionState(registry, target.environmentId, (state) => !state.desired);
        yield* registry.setPenLive(live);
        yield* awaitConnectionState(registry, target.environmentId, (state) => state.desired);
        yield* registry.setPenLive(new Set());
        yield* Deferred.succeed(first, undefined);
        const second = yield* Queue.take(calls);
        yield* Deferred.succeed(second, undefined);
        expect(yield* Ref.get(h.disconnectedSshTargets)).toHaveLength(2);
      }).pipe(Effect.provide(h.layer));
    }),
  );
});

it.effect("holding immediately after opening still tears down the SSH backend", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness([target], [profile]);
    yield* Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry;
      yield* registry.start;
      yield* registry.setPenLive(new Set([target.environmentId]));
      yield* registry.setPenLive(new Set());
      expect(yield* Ref.get(h.disconnectedSshTargets)).toEqual([SSH_TARGET]);
    }).pipe(Effect.provide(h.layer));
  }),
);
