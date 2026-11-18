import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { listed, world } from "./DisposableAttach.testkit.ts";
import { fakeDetachHome } from "./DisposableDetach.testkit.ts";
import { detach, detachPass, HOUR, linked, PERSON } from "./DisposableDetach.flow.testkit.ts";

// OpenCodex v2.100.3: a revoke that claimed its link's retirement receipt and failed at commit stays
// unknown and owns the removal; repeating its id resumes it, and any new journalled id is refused
// link_retirement_owned before the journal (link-routes.ts foreignRetirement).

it.effect(
  "a purge whose commit failed owns its removal: GOAT repeats it once in the same step, and it finishes",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId } = yield* linked(pen, home, host, 1);
        ocx.commitFails = 1;
        yield* detach(PERSON, attachId, "d-1");
        yield* detachPass;
        expect(ocx.sent).toEqual([attachId + ".purge.1", attachId + ".purge.1"]);
        expect((yield* listed(attachId))?.state).toBe("purged");
      }),
    ),
);

it.effect(
  "a force refused link_retirement_owned goes back to GOAT's purge that owns the removal, which finishes it",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId } = yield* linked(pen, home, host, 1);
        ocx.commitFails = 2;
        yield* detach(PERSON, attachId, "d-1");
        yield* detachPass;
        const stopped = yield* listed(attachId);
        expect(stopped?.message).toContain("forces the detach");
        expect(stopped?.message).toContain("repeats");
        yield* detach(PERSON, attachId, "d-2", true);
        yield* detachPass;
        expect(ocx.sent.slice(2)).toEqual([attachId + ".force.2", attachId + ".purge.1"]);
        expect((yield* listed(attachId))?.state).toBe("purged");
        expect(ocx.resolved).toEqual([]);
      }),
    ),
);

it.effect(
  "GOAT stopping between the new force id and the owner's repeat keeps the owner: the next pass goes back to it",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId } = yield* linked(pen, home, host, 1);
        ocx.commitFails = 2;
        yield* detach(PERSON, attachId, "d-1");
        yield* detachPass;
        yield* detach(PERSON, attachId, "d-2", true);
        // GOAT stops while the new id is on its way: it was stored, and the Home never got it.
        ocx.dropSends = 1;
        yield* detachPass;
        expect(ocx.sent.slice(2)).toEqual([]);
        yield* detachPass;
        expect(ocx.sent.slice(2)).toEqual([attachId + ".force.2", attachId + ".purge.1"]);
        expect((yield* listed(attachId))?.state).toBe("purged");
      }),
    ),
);

it.effect(
  "an owner whose repeat fails again stops with link_retirement_owned, never the tombstone text, and either way out its text names ends the detach",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId, linkId } = yield* linked(pen, home, host, 1);
        ocx.commitFails = 3;
        yield* detach(PERSON, attachId, "d-1");
        yield* detachPass;
        yield* detach(PERSON, attachId, "d-2", true);
        yield* detachPass;
        const stopped = yield* listed(attachId);
        expect(stopped?.message).toContain("ocx link operations --json");
        expect(stopped?.message).toContain(
          "ocx link revoke --link-id " + linkId + " --force --yes",
        );
        expect(stopped?.message).not.toContain("too many links removed");
        expect(stopped?.nextAction).toContain("detaches again");
        // The person fixes what failed and detaches again: GOAT repeats the owner, which finishes it.
        yield* detach(PERSON, attachId, "d-3");
        yield* detachPass;
        expect(ocx.sent.at(-1)).toBe(attachId + ".purge.1");
        expect((yield* listed(attachId))?.state).toBe("purged");
      }),
    ),
);

it.effect(
  "an owner GOAT did not start stops the detach at once; a person's plain force on the Home and a detach again end it",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId, linkId } = yield* linked(pen, home, host, 1);
        ocx.outsideOwner(linkId);
        yield* detach(PERSON, attachId, "d-1");
        yield* detachPass;
        expect(ocx.sent).toEqual([attachId + ".purge.1"]);
        expect((yield* listed(attachId))?.message).toContain("ocx link operations --json");
        ocx.plainForce(linkId);
        yield* detach(PERSON, attachId, "d-2");
        for (let pass = 0; pass < 3; pass += 1) {
          yield* detachPass;
          yield* TestClock.adjust(HOUR / 2);
        }
        expect((yield* listed(attachId))?.state).toBe("purged");
      }),
    ),
);

it.effect(
  "after tombstone_limit, a new force id refused link_retirement_owned stops with that refusal once capacity is free",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId, linkId } = yield* linked(pen, home, host, 1);
        ocx.tombstoneLimit = true;
        yield* detach(PERSON, attachId, "d-1", true);
        yield* detachPass;
        ocx.tombstoneLimit = false;
        ocx.outsideOwner(linkId);
        yield* detach(PERSON, attachId, "d-2", true);
        yield* detachPass;
        expect(ocx.sent).toEqual([
          attachId + ".force.1",
          attachId + ".force.1",
          attachId + ".force.2",
          attachId + ".force.1",
        ]);
        const stopped = yield* listed(attachId);
        expect(stopped?.message).toContain("ocx link operations --json");
        expect(stopped?.message).not.toContain("too many links removed");
      }),
    ),
);

it.effect("a stopped retirement force on a linked row names the code OpenCodex answered", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      const ocx = fakeDetachHome(host);
      const { attachId, nodeId, linkId } = yield* linked(pen, home, host, 1);
      host.control.reachAnswers.set(nodeId, "unreachable");
      ocx.machineAnswers = false;
      ocx.outsideOwner(linkId);
      yield* detachPass;
      for (let check = 0; check < 48; check += 1) {
        yield* TestClock.adjust(HOUR / 2);
        yield* detachPass;
      }
      const stopped = yield* listed(attachId);
      expect(stopped?.state).toBe("linked");
      expect(stopped?.message).toContain("link_retirement_owned");
      expect(stopped?.message).toContain("ocx link revoke --link-id " + linkId + " --force --yes");
      expect(stopped?.nextAction).toContain("detaches it");
    }),
  ),
);
