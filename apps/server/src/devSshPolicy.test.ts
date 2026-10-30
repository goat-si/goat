import { assert, it } from "@effect/vitest";
import { resolveSshCommand } from "@goat/ssh/command";
import { allowSshHosts } from "@goat/ssh/hostAccess";
import * as Effect from "effect/Effect";

import { applyDevSshPolicy } from "./devSshPolicy.ts";

const DEV_URL = new URL("http://localhost:5733");
const sshAllowed = resolveSshCommand.pipe(Effect.isSuccess);
const fresh = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.ensuring(allowSshHosts));

it.effect("a dev server refuses SSH when nobody opted in", () =>
  fresh(
    Effect.gen(function* () {
      yield* applyDevSshPolicy({ devUrl: DEV_URL }, {});
      assert.isFalse(yield* sshAllowed);
    }),
  ),
);

it.effect("a dev server refuses SSH for any value other than on", () =>
  fresh(
    Effect.gen(function* () {
      yield* applyDevSshPolicy({ devUrl: DEV_URL }, { GOAT_DEV_SSH: "1" });
      assert.isFalse(yield* sshAllowed);
    }),
  ),
);

it.effect("GOAT_DEV_SSH=on lets a dev server use SSH", () =>
  fresh(
    Effect.gen(function* () {
      yield* applyDevSshPolicy({ devUrl: DEV_URL }, { GOAT_DEV_SSH: "on" });
      assert.isTrue(yield* sshAllowed);
    }),
  ),
);

it.effect("an installed server keeps SSH whatever the variable says", () =>
  fresh(
    Effect.gen(function* () {
      yield* applyDevSshPolicy({ devUrl: undefined }, { GOAT_DEV_SSH: "off" });
      assert.isTrue(yield* sshAllowed);
    }),
  ),
);
