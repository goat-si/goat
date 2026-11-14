import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { listed, world } from "./DisposableAttach.testkit.ts";
import { fakeDetachHome } from "./DisposableDetach.testkit.ts";
import { detach, detachPass, HOUR, linked, PERSON } from "./DisposableDetach.flow.testkit.ts";

// An owner GOAT repeats can meet an OpenCodex fault at a narrow moment (v2.100.3: a resume that
// fails and cannot settle stays open; a plain force reopens the owner and leaves it unresolved).

type Home = ReturnType<typeof fakeDetachHome>;

/** GOAT's forced revoke F1 owns the removal; the person resolved it, and F2 met it and stopped. */
const stopAtForceOwner = (ocx: Home, attachId: string, beforeRepeat: () => void = () => {}) =>
  Effect.gen(function* () {
    ocx.commitFails = 100;
    yield* detach(PERSON, attachId, "d-1", true);
    for (let pass = 0; pass < 4; pass += 1) yield* detachPass;
    const owner = ocx.revokes.get(attachId + ".force.1");
    if (owner !== undefined) owner.resolvedAt = "2026-11-15T00:00:00.000Z";
    yield* detach(PERSON, attachId, "d-2", true);
    beforeRepeat();
    yield* detachPass;
  });
const settle = (attachId: string) =>
  Effect.gen(function* () {
    for (let pass = 0; pass < 4; pass += 1) {
      yield* detachPass;
      if ((yield* listed(attachId))?.state === "purged") return;
      yield* TestClock.adjust(HOUR / 2);
    }
  });

it.effect(
  "the owner a plain force left unknown is resolved once the removal is done, so no entry of the record stays unsettled",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId, linkId } = yield* linked(pen, home, host, 1);
        yield* stopAtForceOwner(ocx, attachId);
        expect((yield* listed(attachId))?.message).toContain("ocx link revoke --link-id " + linkId);
        ocx.commitFails = 0;
        ocx.plainForce(linkId);
        expect(ocx.revokes.get(attachId + ".force.1")?.resolvedAt).toBeUndefined();
        yield* detach(PERSON, attachId, "d-3");
        yield* settle(attachId);
        expect(ocx.resolved).toContain(attachId + ".force.1");
        expect((yield* listed(attachId))?.state).toBe("purged");
      }),
    ),
);

it.effect(
  "an owner left open is named, and GOAT repeats it when its new id meets link_operation_open",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId } = yield* linked(pen, home, host, 1);
        const owner = attachId + ".force.1";
        yield* stopAtForceOwner(ocx, attachId, () => (ocx.resumeOpen = true));
        const stopped = yield* listed(attachId);
        expect(stopped?.message).toContain(owner);
        expect(stopped?.message).toContain("still open");
        ocx.resumeOpen = false;
        ocx.commitFails = 0;
        yield* detach(PERSON, attachId, "d-3");
        yield* detachPass;
        expect(ocx.sent.at(-1)).toBe(owner);
        expect(ocx.tombstones.size).toBe(1);
        expect((yield* listed(attachId))?.message).toContain("its link is gone");
      }),
    ),
);

it.effect("a purge that GOAT's own repeat left open is described as running, not unknown", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      const ocx = fakeDetachHome(host);
      const { attachId } = yield* linked(pen, home, host, 1);
      ocx.commitFails = 1;
      ocx.resumeOpen = true;
      yield* detach(PERSON, attachId, "d-1");
      yield* detachPass;
      expect((yield* listed(attachId))?.message).toContain("as running");
    }),
  ),
);

it.effect(
  "an owner purge that finished meanwhile ends the record purged, not removed outside GOAT",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId, linkId } = yield* linked(pen, home, host, 1);
        const purge = attachId + ".purge.1";
        ocx.commitFails = 3;
        yield* detach(PERSON, attachId, "d-1");
        yield* detachPass;
        yield* detach(PERSON, attachId, "d-2", true);
        yield* detachPass;
        expect((yield* listed(attachId))?.message).toContain("unfinished removal");
        // Someone repeats GOAT's purge on the Home while GOAT is stopped: it finishes, with its receipt.
        const entry = ocx.revokes.get(purge);
        if (entry !== undefined) {
          entry.state = "committed";
          delete entry.ownsReceipt;
          delete entry.code;
        }
        host.control.links.delete(linkId);
        yield* detach(PERSON, attachId, "d-3");
        yield* settle(attachId);
        const done = yield* listed(attachId);
        expect(done?.state).toBe("purged");
        expect(done?.message).not.toContain("outside GOAT");
      }),
    ),
);
