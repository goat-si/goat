import type { DesktopPenMembersState } from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { PenMembersGateway } from "../platform/capabilities.ts";
import { layer, PenMembership, trustedPenMember } from "./penMembership.ts";

const owner = { meshId: "mesh", nodeId: "node" };
const member = {
  nodeId: "node",
  name: "Node",
  online: true,
  noisePub: "key",
  route: {
    kind: "trusted" as const,
    target: { alias: "node", hostname: "node", username: null, port: null },
    revision: "1",
  },
};
const ready = (seq: number): Extract<DesktopPenMembersState, { kind: "ready" }> => ({
  kind: "ready",
  seq,
  meshId: "mesh",
  selfNodeId: "self",
  members: [member],
});
const removed: DesktopPenMembersState = { kind: "not-member", seq: 2 };

const awaitLatest = (
  ref: PenMembership["latest"],
  predicate: (
    value: Option.Option<import("../platform/capabilities.ts").PenMembersInput>,
  ) => boolean,
) =>
  SubscriptionRef.changes(ref).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

const run = (
  test: (h: {
    desktop: Queue.Queue<DesktopPenMembersState>;
    enabled: Queue.Queue<boolean>;
    membership: PenMembership;
  }) => Effect.Effect<void>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const desktop = yield* Queue.unbounded<DesktopPenMembersState>();
      const enabled = yield* Queue.unbounded<boolean>();
      const gateway = Layer.succeed(PenMembersGateway, {
        desktop: Stream.fromQueue(desktop),
        enabled: Stream.fromQueue(enabled),
      });
      yield* Effect.gen(function* () {
        const membership = yield* PenMembership;
        yield* test({ desktop, enabled, membership });
      }).pipe(Effect.provide(layer.pipe(Layer.provide(gateway))));
    }),
  );

describe("Pen membership", () => {
  it.effect("waits for the setting and first desktop state before admission", () =>
    run(({ desktop, enabled, membership }) =>
      Effect.gen(function* () {
        const fiber = yield* membership
          .admit(owner)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        expect(fiber.pollUnsafe()).toBeUndefined();
        yield* Queue.offer(enabled, true);
        yield* Queue.offer(desktop, ready(1));
        yield* Fiber.join(fiber);
        expect(fiber.pollUnsafe()).toBeDefined();
      }),
    ),
  );

  it.effect.each([
    [{ kind: "disabled" }, "Pen machines are turned off in Settings."],
    [removed, "This machine is no longer in the Pen mesh."],
    [{ ...ready(1), meshId: "other" }, "This machine belongs to another Pen mesh."],
    [{ ...ready(1), members: [] }, "That machine is no longer a trusted Pen member."],
    [
      { ...ready(1), members: [{ ...member, route: { kind: "refused", reason: "key-mismatch" } }] },
      "That machine is no longer a trusted Pen member.",
    ],
  ] as const)("refuses %s", ([state, detail]) =>
    run(({ desktop, enabled, membership }) =>
      Effect.gen(function* () {
        if (state.kind === "disabled") yield* Queue.offer(enabled, false);
        else {
          yield* Queue.offer(enabled, true);
          yield* Queue.offer(desktop, state);
        }
        const result = yield* Effect.flip(membership.admit(owner));
        expect(result).toMatchObject({ reason: "configuration", detail });
      }),
    ),
  );

  it.effect.each([{ kind: "unavailable", seq: 1, reason: "stale" }, ready(1)] as const)(
    "admits %s",
    (state) =>
      run(({ desktop, enabled, membership }) =>
        Effect.gen(function* () {
          yield* Queue.offer(enabled, true);
          yield* Queue.offer(desktop, state);
          yield* membership.admit(owner);
          expect(trustedPenMember(state, owner)).toEqual(
            state.kind === "ready" ? member : undefined,
          );
        }),
      ),
  );

  it.effect("drops older desktop states after a removal", () =>
    run(({ desktop, enabled, membership }) =>
      Effect.gen(function* () {
        yield* Queue.offer(enabled, true);
        yield* Queue.offer(desktop, removed);
        yield* awaitLatest(
          membership.latest,
          (value) => Option.isSome(value) && value.value.kind === "not-member",
        );
        const observer = yield* SubscriptionRef.changes(membership.latest).pipe(
          Stream.filter((value) => Option.isSome(value) && value.value.kind !== "not-member"),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* Queue.offer(desktop, ready(1));
        yield* Queue.offer(desktop, { kind: "unavailable", seq: 3, reason: "stale" });
        const observed = yield* Fiber.join(observer);
        expect(observed).toEqual(Option.some({ kind: "unavailable", seq: 3, reason: "stale" }));
      }),
    ),
  );

  it.effect("restores the last desktop state when re-enabled", () =>
    run(({ desktop, enabled, membership }) =>
      Effect.gen(function* () {
        yield* Queue.offer(enabled, true);
        yield* Queue.offer(desktop, ready(1));
        yield* awaitLatest(
          membership.latest,
          (value) => Option.isSome(value) && value.value.kind === "ready",
        );
        yield* Queue.offer(enabled, false);
        yield* awaitLatest(
          membership.latest,
          (value) => Option.isSome(value) && value.value.kind === "disabled",
        );
        yield* Queue.offer(enabled, true);
        yield* awaitLatest(
          membership.latest,
          (value) => Option.isSome(value) && value.value.kind === "ready",
        );
        yield* membership.admit(owner);
      }),
    ),
  );
});
