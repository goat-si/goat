import { assert, describe, it } from "@effect/vitest";
import type { PenMembershipView } from "@goat/ssh/penMembershipWatch";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { PenMembershipWatch } from "../pen/PenMembershipWatch.ts";
import * as PenManagedRoutes from "./PenManagedRoutes.ts";

const id = (letter: string) => letter.repeat(26);
const key = (letter: string) => letter.repeat(43);
const alias = `pen-${id("a")}`;
const binding = { meshId: id("m"), nodeId: id("a"), noisePub: key("a") };
const ready = (...members: Array<readonly [string, string]>): PenMembershipView => ({
  kind: "ready",
  selfName: "hub",
  snapshot: {
    gen: 1,
    mesh: id("m"),
    self: id("s"),
    revoked: [],
    members: [["s", "s"] as const, ...members].map(([node, noise]) => ({
      nodeId: id(node),
      noisePub: key(noise),
      name: `box-${node}`,
      online: true,
    })),
  },
});
const trusted = (noise = "a") => ({
  alias,
  nodeId: id("a"),
  noisePub: key(noise),
  revision: "pen:a",
  target: { alias, hostname: alias, username: "me", port: null },
});

const harness = (start: PenMembershipView = ready(["a", "a"])) => {
  const state = {
    view: start,
    route: trusted() as ReturnType<typeof trusted> | { refused: "no-recorded-key" },
  };
  return Effect.map(
    PenManagedRoutes.make({ inspect: () => Effect.sync(() => state.route) }).pipe(
      Effect.provideService(
        PenMembershipWatch,
        PenMembershipWatch.of({
          current: Effect.sync(() => state.view),
          changes: Stream.never,
        }),
      ),
    ),
    (routes) => ({ routes, state }),
  );
};

describe("PenManagedRoutes", () => {
  it.effect("admits a held alias only while Pen lists the member with the key ssh pins", () =>
    Effect.gen(function* () {
      const { routes, state } = yield* harness();
      assert.equal((yield* Effect.flip(routes.admit(alias)))._tag, "SshInvalidTargetError");
      yield* routes.hold(alias, binding);
      assert.isTrue(routes.isManaged(alias));
      assert.deepEqual(yield* routes.admit(alias), { selfNodeId: id("s") });

      state.route = trusted("x");
      assert.equal((yield* Effect.flip(routes.admit(alias)))._tag, "SshInvalidTargetError");
      state.route = { refused: "no-recorded-key" };
      assert.equal((yield* Effect.flip(routes.admit(alias)))._tag, "SshInvalidTargetError");
      state.route = trusted();

      for (const view of [
        ready(["a", "x"]),
        ready(),
        { kind: "unavailable", reason: "daemon-down" },
        { kind: "not-member" },
      ] satisfies PenMembershipView[]) {
        state.view = view;
        assert.equal((yield* Effect.flip(routes.admit(alias)))._tag, "SshInvalidTargetError");
      }
      assert.isTrue(routes.isManaged(alias));
    }),
  );

  it.effect("release closes what was opened, and an alias whose cleanup failed stays blocked", () =>
    Effect.gen(function* () {
      const { routes } = yield* harness();
      const closed: string[] = [];
      let fail = true;
      yield* routes.registerCleanup((released) =>
        Effect.suspend(() => {
          closed.push(released);
          return fail ? Effect.die("tunnel would not close") : Effect.void;
        }),
      );
      yield* routes.hold(alias, binding);
      const error = yield* Effect.flip(routes.release(alias));
      assert.equal(error._tag, "PenRouteCleanupError");
      assert.isTrue(routes.isManaged(alias));
      assert.equal((yield* Effect.flip(routes.admit(alias)))._tag, "SshInvalidTargetError");
      fail = false;
      yield* routes.release(alias);
      assert.isFalse(routes.isManaged(alias));
      assert.deepEqual(closed, [alias, alias]);
    }),
  );
});
