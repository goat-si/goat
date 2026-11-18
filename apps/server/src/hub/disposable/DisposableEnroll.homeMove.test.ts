import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { listed, world } from "./DisposableAttach.testkit.ts";
import { enroll, joined, withIdentity } from "./DisposableEnroll.joined.testkit.ts";

const NEW_HOME = "/home/me/goat-new/userdata/disposable/known_hosts/";

it.effect(
  "after GOAT's home moves, reach uses the known_hosts file written at the current path",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        withIdentity(home);
        const { attachId } = yield* joined(pen, host, 1);
        yield* enroll; // route: the known_hosts path is stored under the old home
        host.control.knownHostsDir = NEW_HOME;
        yield* enroll; // reach
        expect(host.control.reached.at(-1)?.knownHostsFile).toBe(NEW_HOME + attachId);
        yield* enroll; // link
        yield* enroll; // verify
        expect(yield* listed(attachId)).toMatchObject({ state: "linked" });
      }),
    ),
);

it.effect(
  "after a home move, a known_hosts file GOAT cannot write at the current path holds reach before any ssh",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        withIdentity(home);
        const { attachId } = yield* joined(pen, host, 1);
        yield* enroll; // route: stored under the old home
        host.control.knownHostsDir = NEW_HOME;
        host.control.knownHostsUnwritable = true;
        yield* enroll; // reach
        // ssh never reads the old file this pass did not compare with Pen's route.
        expect(host.control.reached).toEqual([]);
        expect(yield* listed(attachId)).toMatchObject({
          state: "attaching",
          message: expect.stringContaining("could not write the machine's known_hosts file"),
        });
        host.control.knownHostsUnwritable = false;
        yield* enroll;
        expect(host.control.reached.at(-1)?.knownHostsFile).toBe(NEW_HOME + attachId);
      }),
    ),
);
