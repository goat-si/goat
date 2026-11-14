import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { listed, world } from "./DisposableAttach.testkit.ts";
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

// Every detach stop, left by doing what the row says. Not walked: link_foreign without a force,
// which needs an unsettled entry with no reserved id, never journalled at v2.100.3. The owner
// walks of link_retirement_owned are in DisposableDetach.owner.test.ts.

/** What the row says now: its message and next action. */
const says = (attachId: string) =>
  Effect.map(listed(attachId), (machine) => ({
    message: machine?.message ?? "",
    next: machine?.nextAction ?? "",
  }));
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
  /** What the stop's message says. */
  readonly says: string;
  /** What its next action tells a person to do. */
  readonly next: string;
  /** What reaches the stop on a linked machine, before the detach. */
  readonly arrange: (ocx: Home, linkId: string) => void;
  /** What the stop's text tells a person to do: fix it on the machine or hub, then a detach or a force. */
  readonly leave: (ocx: Home, attachId: string, linkId: string) => { readonly force: boolean };
  /** Detach or force (the person's first click) that reaches the stop. */
  readonly start?: "force";
}
const purge1 = (attachId: string) => attachId + ".purge.1";
const WALKS: ReadonlyArray<Walk> = [
  {
    stop: "revoke_child_residual",
    says: "keeps records it cannot restore",
    next: "forces the detach",
    arrange: (ocx) => (ocx.childRefusal = "child_residual"),
    leave: () => ({ force: true }),
  },
  {
    stop: "revoke_child_link_mismatch",
    says: "belongs to another link",
    next: "detaches again",
    arrange: (ocx) => (ocx.childRefusal = "child_link_mismatch"),
    // The person lets the other connect finish on the machine, then detaches again.
    leave: (ocx) => ((ocx.childRefusal = undefined), { force: false }),
  },

  {
    stop: "revoke_answered",
    says: "the machine answers, yet",
    next: "then forces the detach",
    arrange: (ocx) => (ocx.purgeIncomplete = true),
    leave: (ocx, attachId) => (
      (ocx.purgeIncomplete = false),
      resolved(ocx.revokes.get(purge1(attachId))),
      { force: true }
    ),
  },
  {
    stop: "revoke_expect_link_unsupported",
    says: "too old to check which link",
    next: "forces the detach",
    arrange: (ocx) => (ocx.childRefusal = "expect_link_unsupported"),
    leave: () => ({ force: true }),
  },
  {
    stop: "revoke_child_missing",
    says: "no planted ocx-child",
    next: "forces the detach",
    arrange: (ocx) => (ocx.childMissing = true),
    // Forced, recover then waits for a person to forget the cleanup of a machine with no ocx-child.
    leave: () => ({ force: true }),
  },
  {
    stop: "revoke_refused",
    says: "refused the revoke",
    next: "forces the detach",
    arrange: (ocx) => (ocx.purgeRefusal = "purge_unsupported"),
    leave: () => ({ force: true }),
  },
  {
    stop: "revoke_unsettled",
    says: "never recorded",
    next: "detaches again",
    // The Home's journal cannot record the revoke: never journalled.
    arrange: (ocx) => (ocx.journalRefuses = 3),
    leave: (ocx) => ((ocx.journalRefuses = 0), { force: false }),
  },
  {
    stop: "tombstone_limit",
    says: "too many links removed",
    next: "forces the detach",
    arrange: (ocx) => (ocx.tombstoneLimit = true),
    start: "force",
    leave: (ocx) => ((ocx.tombstoneLimit = false), { force: true }),
  },
  {
    stop: "link_retirement_owned",
    says: "an unfinished removal holds its link",
    next: "detaches again",
    // A journalled revoke GOAT did not start failed at commit and owns the removal.
    arrange: (ocx, linkId) => ocx.outsideOwner(linkId),
    // The person finishes it with a plain force on the Home, as the text names.
    leave: (ocx, _attachId, linkId) => (ocx.plainForce(linkId), { force: false }),
  },
];

it.effect.each(WALKS)("$stop: the way out its text names ends the detach", (walk) =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      const ocx = fakeDetachHome(host);
      const { attachId, linkId } = yield* linked(pen, home, host, 1);
      walk.arrange(ocx, linkId);
      yield* detach(PERSON, attachId, "d-1", walk.start === "force");
      for (let pass = 0; pass < 4; pass += 1) yield* detachPass;
      const stopped = yield* says(attachId);
      expect(stopped.message).toContain(walk.says);
      expect(stopped.next).toContain(walk.next);
      // The way out matches what the text names: a force, or a detach again.
      const { force } = walk.leave(ocx, attachId, linkId);
      expect(force).toBe(walk.next.includes("forces"));
      yield* detach(PERSON, attachId, "d-2", force);
      yield* detachPass;
      expect((yield* says(attachId)).message).not.toContain(walk.says);
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
  "revoke_unsettled on an open purge: the person fixes the Home and detaches again, GOAT repeats that id; the recovered entry is forced, as its text says, and GOAT resolves it once the force is done",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId } = yield* linked(pen, home, host, 1);
        ocx.purgeOpen = true;
        yield* detach(PERSON, attachId, "d-1");
        for (let pass = 0; pass < 4; pass += 1) yield* detachPass;
        const open = yield* says(attachId);
        expect(open.message).toContain("still lists the revoke");
        expect(open.next).toContain("detaches again");
        expect(open.next).not.toContain("resolve");
        ocx.purgeOpen = false;
        yield* detach(PERSON, attachId, "d-2");
        yield* detachPass;
        expect(ocx.sent.at(-1)).toBe(purge1(attachId));
        const recovered = yield* says(attachId);
        expect(recovered.message).toContain("could not tell what the revoke");
        expect(recovered.next).toContain("checks the machine, then forces the detach");
        yield* detach(PERSON, attachId, "d-3", true);
        yield* settle(attachId);
        expect(ocx.resolved).toContain(purge1(attachId));
        expect((yield* listed(attachId))?.state).toBe("purged");
      }),
    ),
);

it.effect(
  "a force on an open purge repeats that id before any force id, and goes on by itself once it settles: the replaced purge is resolved once the force commits",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId } = yield* linked(pen, home, host, 1);
        ocx.purgeOpen = true;
        yield* detach(PERSON, attachId, "d-1");
        for (let pass = 0; pass < 4; pass += 1) yield* detachPass;
        ocx.purgeOpen = false;
        const before = ocx.sent.length;
        yield* detach(PERSON, attachId, "d-2", true);
        yield* detachPass;
        // The open purge goes first; once it settles unknown the person's force goes on, no second click.
        expect(ocx.sent.slice(before)).toEqual([purge1(attachId), attachId + ".force.2"]);
        yield* settle(attachId);
        expect(ocx.resolved).toContain(purge1(attachId));
        expect((yield* listed(attachId))?.state).toBe("purged");
      }),
    ),
);

it.effect(
  "a force whose commit failed owns its removal: GOAT repeats that id, which resumes it, never a new one",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId } = yield* linked(pen, home, host, 1);
        ocx.commitFails = 1;
        yield* detach(PERSON, attachId, "d-1", true);
        yield* settle(attachId);
        expect(ocx.sent).toEqual([attachId + ".force.1", attachId + ".force.1"]);
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
        const stopped = yield* says(attachId);
        expect(stopped.message).toContain("too many links removed");
        expect(stopped.next).toContain("detaches it");
        ocx.tombstoneLimit = false;
        yield* detach(PERSON, attachId, "d-1");
        yield* detachPass;
        expect((yield* says(attachId)).message).not.toContain("too many links removed");
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
        expect((yield* says(attachId)).next).toContain(
          "resolves the operation on the hub and detaches again",
        );
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
      expect((yield* says(attachId)).message).toContain("as running after 10 quiet minutes");
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
      expect((yield* says(attachId)).message).toContain("has no record of");
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
