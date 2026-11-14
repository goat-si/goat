import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { listed, rows, world } from "./DisposableAttach.testkit.ts";
import { fakeDetachHome } from "./DisposableDetach.testkit.ts";
import {
  detach,
  detachPass,
  HOUR,
  linked,
  PERSON,
  THREAD,
} from "./DisposableDetach.flow.testkit.ts";
import { enroll, joined, withIdentity } from "./DisposableEnroll.joined.testkit.ts";
import { decodeEnroll } from "./enrollModel.ts";

// Every detach stop, reached and then left by doing what its own text tells a person to do.
// A stop whose way out lies outside GOAT names it here: none does. link_foreign without a force
// needs an unsettled entry with no reserved id, which v2.100.3 never journals; its force ends it
// (the alias-sharing test below).

const stopOf = (attachId: string) =>
  Effect.map(rows, (all) => {
    const row = all.find((one) => one.attach_id === attachId);
    return typeof row?.enroll_json === "string"
      ? decodeEnroll(row.enroll_json).detach?.stop
      : undefined;
  });
/** Runs passes, 30 minutes apart, until the record is final or the budget runs out. */
const settle = (attachId: string) =>
  Effect.gen(function* () {
    for (let pass = 0; pass < 6; pass += 1) {
      yield* detachPass;
      if ((yield* listed(attachId))?.state === "purged") return;
      yield* TestClock.adjust(HOUR / 2);
    }
  });
const resolved = (entry: { resolvedAt?: string } | undefined) => {
  if (entry !== undefined) entry.resolvedAt = "2026-11-15T00:00:00.000Z";
};

type Home = ReturnType<typeof fakeDetachHome>;
interface Walk {
  readonly stop: string;
  /** What reaches the stop on a linked machine, before the detach. */
  readonly arrange: (ocx: Home) => void;
  /** What the stop's text tells a person to do: fix it on the machine or hub, then a detach or a force. */
  readonly leave: (ocx: Home, attachId: string) => { readonly force: boolean };
  /** Detach or force (the person's first click) that reaches the stop. */
  readonly start?: "force";
}
const purge1 = (attachId: string) => attachId + ".purge.1";
const WALKS: ReadonlyArray<Walk> = [
  {
    stop: "revoke_child_residual",
    arrange: (ocx) => (ocx.childRefusal = "child_residual"),
    leave: () => ({ force: true }),
  },
  {
    stop: "revoke_child_link_mismatch",
    arrange: (ocx) => (ocx.childRefusal = "child_link_mismatch"),
    // The person lets the other connect finish on the machine, then detaches again.
    leave: (ocx) => ((ocx.childRefusal = undefined), { force: false }),
  },

  {
    stop: "revoke_answered",
    arrange: (ocx) => (ocx.purgeIncomplete = true),
    leave: (ocx, attachId) => (
      (ocx.purgeIncomplete = false),
      resolved(ocx.revokes.get(purge1(attachId))),
      { force: true }
    ),
  },
  {
    stop: "revoke_expect_link_unsupported",
    arrange: (ocx) => (ocx.childRefusal = "expect_link_unsupported"),
    leave: () => ({ force: true }),
  },
  {
    stop: "revoke_child_missing",
    arrange: (ocx) => (ocx.childMissing = true),
    // Forced, recover then waits for a person to forget the cleanup of a machine with no ocx-child.
    leave: () => ({ force: true }),
  },
  {
    stop: "revoke_refused",
    arrange: (ocx) => (ocx.purgeRefusal = "purge_unsupported"),
    leave: () => ({ force: true }),
  },
  {
    stop: "revoke_unsettled",
    // The Home's journal cannot record the revoke: never journalled.
    arrange: (ocx) => (ocx.journalRefuses = 3),
    leave: (ocx) => ((ocx.journalRefuses = 0), { force: false }),
  },
  {
    stop: "tombstone_limit",
    arrange: (ocx) => (ocx.tombstoneLimit = true),
    start: "force",
    leave: (ocx) => ((ocx.tombstoneLimit = false), { force: true }),
  },
];

it.effect.each(WALKS)("$stop: the way out its text names ends the detach", (walk) =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      const ocx = fakeDetachHome(host);
      const { attachId, linkId } = yield* linked(pen, home, host, 1);
      walk.arrange(ocx);
      yield* detach(PERSON, attachId, "d-1", walk.start === "force");
      for (let pass = 0; pass < 4; pass += 1) yield* detachPass;
      expect(yield* stopOf(attachId)).toBe(walk.stop);
      const { force } = walk.leave(ocx, attachId);
      yield* detach(PERSON, attachId, "d-2", force);
      yield* detachPass;
      expect(yield* stopOf(attachId)).toBeUndefined();
      yield* settle(attachId);
      // A machine with no planted ocx-child waits in recover until a person forgets its cleanup.
      if ((yield* listed(attachId))?.state !== "purged") {
        expect((yield* listed(attachId))?.message).toContain("ocx link recover --forget");
        ocx.forget(linkId);
        yield* settle(attachId);
      }
      expect((yield* listed(attachId))?.state).toBe("purged");
    }),
  ),
);

it.effect(
  "revoke_unsettled on an open purge: the person fixes the Home and detaches again, GOAT repeats that id, and the walk ends",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId } = yield* linked(pen, home, host, 1);
        ocx.purgeOpen = true;
        yield* detach(PERSON, attachId, "d-1");
        for (let pass = 0; pass < 4; pass += 1) yield* detachPass;
        expect(yield* stopOf(attachId)).toBe("revoke_unsettled");
        const open = yield* listed(attachId);
        expect(open?.message).toContain("detaches again");
        expect(open?.nextAction).not.toContain("resolve");
        // A force while the purge is open repeats the purge id: OpenCodex refuses any other revoke.
        ocx.purgeOpen = false;
        yield* detach(PERSON, attachId, "d-2", true);
        yield* detachPass;
        expect(ocx.sent.filter((id) => id.includes(".force."))).toEqual([]);
        expect(ocx.sent.at(-1)).toBe(purge1(attachId));
        // The recovered entry is unknown: the person checks, resolves it, and detaches again.
        expect(yield* stopOf(attachId)).toBe("revoke_unsettled");
        resolved(ocx.revokes.get(purge1(attachId)));
        yield* detach(PERSON, attachId, "d-3");
        yield* settle(attachId);
        expect((yield* listed(attachId))?.state).toBe("purged");
      }),
    ),
);

it.effect(
  "tombstone_limit on a force that owns its retirement: a resend resumes it once capacity is free, with no new id",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId } = yield* linked(pen, home, host, 1);
        ocx.tombstoneLimit = true;
        ocx.ownsReceiptOnLimit = true;
        yield* detach(PERSON, attachId, "d-1", true);
        yield* detachPass;
        expect(yield* stopOf(attachId)).toBe("tombstone_limit");
        // Capacity still full: the new id meets the owner, GOAT goes back to it and stops there.
        yield* detach(PERSON, attachId, "d-2", true);
        yield* detachPass;
        expect(ocx.sent).toEqual([
          attachId + ".force.1",
          attachId + ".force.1",
          attachId + ".force.2",
          attachId + ".force.1",
        ]);
        expect(yield* stopOf(attachId)).toBe("tombstone_limit");
        ocx.tombstoneLimit = false;
        yield* detach(PERSON, attachId, "d-3", true);
        yield* settle(attachId);
        expect(ocx.sent.slice(4)).toEqual([attachId + ".force.1"]);
        expect((yield* listed(attachId))?.state).toBe("purged");
      }),
    ),
);

it.effect(
  "a retirement force that stopped on a linked row: the person recovers or forgets cleanups and detaches it, and the removal goes on",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId, nodeId } = yield* linked(pen, home, host, 1);
        host.control.reachAnswers.set(nodeId, "unreachable");
        ocx.machineAnswers = false;
        ocx.tombstoneLimit = true;
        yield* detachPass;
        for (let check = 0; check < 48; check += 1) {
          yield* TestClock.adjust(HOUR / 2);
          yield* detachPass;
        }
        expect(yield* stopOf(attachId)).toBe("tombstone_limit");
        expect((yield* listed(attachId))?.nextAction).toContain("detaches it");
        ocx.tombstoneLimit = false;
        yield* detach(PERSON, attachId, "d-1");
        yield* detachPass;
        expect(yield* stopOf(attachId)).toBeUndefined();
        expect(ocx.tombstones.size).toBe(1);
        ocx.machineAnswers = true;
        host.control.reachAnswers.delete(nodeId);
        yield* settle(attachId);
        expect((yield* listed(attachId))?.state).toBe("purged");
      }),
    ),
);

it.effect(
  "revoke_unsettled after sends OpenCodex never recorded names the refusal, not a resolve",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId } = yield* linked(pen, home, host, 1);
        ocx.journalRefuses = 3;
        yield* detach(PERSON, attachId, "d-1");
        for (let pass = 0; pass < 4; pass += 1) yield* detachPass;
        const stopped = yield* listed(attachId);
        expect(stopped?.message).toContain("operation_journal_full");
        expect(stopped?.message).not.toContain("resolve");
        expect(stopped?.nextAction).not.toContain("resolve");
      }),
    ),
);

/** A machine joined whose link add the Home left in a given state. */
const unsettledAdd = (
  pen: Parameters<Parameters<typeof world>[0]>[0],
  home: Parameters<Parameters<typeof world>[0]>[1],
  host: Parameters<Parameters<typeof world>[0]>[3],
  script: "unknown" | "open",
) =>
  Effect.gen(function* () {
    withIdentity(home);
    const { attachId, nodeId } = yield* joined(pen, host, 1);
    host.control.adds.push(script);
    if (script === "open") host.control.openStaysOpen = true;
    for (let pass = 0; pass < 3; pass += 1) yield* enroll;
    return { attachId, nodeId };
  });

it.effect(
  "link_unsettled: the person resolves the operation and detaches again, and the detach ends",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        fakeDetachHome(host);
        const { attachId } = yield* unsettledAdd(pen, home, host, "unknown");
        yield* detach(THREAD, attachId, "d-1");
        yield* detachPass;
        expect(yield* stopOf(attachId)).toBe("link_unsettled");
        resolved(host.control.journal.get(attachId + ".link.1"));
        yield* detach(THREAD, attachId, "d-2");
        yield* settle(attachId);
        expect((yield* listed(attachId))?.state).toBe("purged");
      }),
    ),
);

it.effect("link_open: the person forces, and the detach ends once the quiet window passed", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      fakeDetachHome(host);
      const { attachId } = yield* unsettledAdd(pen, home, host, "open");
      yield* detach(THREAD, attachId, "d-1");
      yield* detachPass;
      yield* TestClock.adjust(11 * 60 * 1000);
      yield* detachPass;
      expect(yield* stopOf(attachId)).toBe("link_open");
      yield* detach(PERSON, attachId, "d-2", true);
      yield* settle(attachId);
      expect((yield* listed(attachId))?.state).toBe("purged");
    }),
  ),
);

it.effect("link_lost: the person forces, and the detach ends", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      fakeDetachHome(host);
      const { attachId } = yield* unsettledAdd(pen, home, host, "unknown");
      host.control.forget(attachId + ".link.1");
      yield* TestClock.adjust(3 * HOUR);
      yield* detach(THREAD, attachId, "d-1");
      yield* detachPass;
      yield* TestClock.adjust(11 * 60 * 1000);
      yield* detachPass;
      expect(yield* stopOf(attachId)).toBe("link_lost");
      yield* detach(PERSON, attachId, "d-2", true);
      yield* settle(attachId);
      expect((yield* listed(attachId))?.state).toBe("purged");
    }),
  ),
);

it.effect(
  "a link that only shares the alias never stops the record: a force ends it unproven and names that link, untouched",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId, nodeId } = yield* unsettledAdd(pen, home, host, "unknown");
        host.control.forget(attachId + ".link.1");
        host.control.links.set("lnk_00000000000000aa", {
          id: "lnk_00000000000000aa",
          alias: "pen-" + nodeId,
          childKind: "full",
          exclusive: false,
        });
        yield* TestClock.adjust(3 * HOUR);
        yield* detach(PERSON, attachId, "d-1", true);
        yield* detachPass;
        yield* TestClock.adjust(11 * 60 * 1000);
        yield* detachPass;
        const done = yield* listed(attachId);
        expect(done?.state).toBe("purged");
        expect(done?.message).toContain("lnk_00000000000000aa");
        expect(host.control.links.has("lnk_00000000000000aa")).toBe(true);
        expect(ocx.sent).toEqual([]);
      }),
    ),
);
