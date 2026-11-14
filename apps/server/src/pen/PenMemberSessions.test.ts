import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { PenMembershipView } from "@goat/ssh/penMembershipWatch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Auth from "../auth/EnvironmentAuth.ts";
import { MAIN_LISTENER } from "../auth/connectionContext.testkit.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import { SessionStore } from "../auth/SessionStore.ts";
import * as Config from "../config.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as PenMemberSessions from "./PenMemberSessions.ts";

const layer = Auth.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(Secrets.layer),
  Layer.provide(Environment.layerIdentity),
  Layer.provide(Config.layerTest(process.cwd(), { prefix: "goat-pen-member-sessions-" })),
  Layer.provide(NodeServices.layer),
);

const id = (letter: string) => letter.repeat(26);
const ready = (...letters: string[]): PenMembershipView => ({
  kind: "ready",
  selfName: "hub",
  snapshot: {
    gen: 1,
    mesh: id("m"),
    self: id("s"),
    revoked: [],
    members: ["s", ...letters].map((letter) => ({
      nodeId: id(letter),
      noisePub: letter.repeat(43),
      name: `box-${letter}`,
      online: true,
    })),
  },
});

it.effect(
  "a member's session works only while Pen lists the member here, and is revoked when it leaves",
  () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore;
      const { apply } = yield* PenMemberSessions.make();
      const a = yield* sessions.issue({ penMemberNode: id("a") });
      const b = yield* sessions.issue({ penMemberNode: id("b") });
      const ordinary = yield* sessions.issue({ subject: "browser" });
      const works = (token: typeof a.token) =>
        sessions.verify(token, MAIN_LISTENER).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
      const held = Effect.map(sessions.listPenMemberSessions, (rows) =>
        rows.map((row) => row.penMemberNode).toSorted(),
      );

      // Before any member list: closed.
      expect([yield* works(a.token), yield* works(b.token)]).toEqual([false, false]);
      expect(yield* works(ordinary.token)).toBe(true);

      yield* apply(ready("a", "b"));
      expect([yield* works(a.token), yield* works(b.token)]).toEqual([true, true]);

      // Pen down: nobody signs in, nothing is thrown away.
      yield* apply({ kind: "unavailable", reason: "daemon-down" });
      expect([yield* works(a.token), yield* works(b.token)]).toEqual([false, false]);
      expect(yield* held).toEqual([id("a"), id("b")]);
      expect(yield* works(ordinary.token)).toBe(true);

      // Back, and b has left: a works again without a new sign-in, b is revoked for good.
      yield* apply(ready("a"));
      expect([yield* works(a.token), yield* works(b.token)]).toEqual([true, false]);
      expect(yield* held).toEqual([id("a")]);
      yield* apply(ready("a", "b"));
      expect(yield* works(b.token)).toBe(false);

      // This machine left the mesh: every member session goes.
      yield* apply({ kind: "not-member" });
      expect(yield* works(a.token)).toBe(false);
      expect(yield* held).toEqual([]);
      expect(yield* works(ordinary.token)).toBe(true);
    }).pipe(Effect.provide(layer)),
);
