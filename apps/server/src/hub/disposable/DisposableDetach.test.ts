import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Attach from "./DisposableAttach.ts";
import { attach, key, listed, reconcile, switchTo, world } from "./DisposableAttach.testkit.ts";
import { makeDetach } from "./DisposableDetach.ts";
import { makeHold } from "./DisposableEnroll.testkit.ts";
import { fakeDetachHome } from "./DisposableDetach.testkit.ts";
import { enroll, joined, withIdentity } from "./DisposableEnroll.joined.testkit.ts";
import { decodeEnroll, encodeEnroll } from "./enrollModel.ts";
import { withPersonConsent } from "./disposableSwitch.ts";
import * as Settings from "../../serverSettings.ts";

import {
  detach,
  detachPass,
  HOUR,
  linked,
  PERSON,
  release,
  THREAD,
} from "./DisposableDetach.flow.testkit.ts";

it.effect(
  "the provisioner detaches a linked machine: one journalled purge, the record ends purged and its key keeps its slot while in Pen",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId, linkId } = yield* linked(pen, home, host, 1);
        const started = yield* detach(THREAD, attachId, "d-1");
        expect(started.state).toBe("detaching");
        yield* detachPass;
        expect(ocx.sent).toEqual([attachId + ".purge.1"]);
        expect(host.control.links.has(linkId)).toBe(false);
        expect(host.control.knownHosts.has(attachId)).toBe(false);
        const done = yield* listed(attachId);
        expect(done).toMatchObject({ state: "purged", penMember: true });
        expect(done?.message).toContain("pen revoke");
        // A repeat of the request answers the record; nothing is sent again.
        expect((yield* detach(THREAD, attachId, "d-1")).state).toBe("purged");
        yield* detachPass;
        expect(ocx.sent).toHaveLength(1);
      }),
    ),
);

it.effect("only the provisioner or a person detaches, and only a person forces", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      fakeDetachHome(host);
      const { attachId } = yield* linked(pen, home, host, 1);
      const other: Attach.AttachCaller = { provisioner: { kind: "thread", threadId: "other" } };
      const refused = yield* detach(other, attachId, "d-1").pipe(Effect.flip);
      expect(refused.reason).toBe("provisioner_refused");
      const forced = yield* detach(THREAD, attachId, "d-2", true).pipe(Effect.flip);
      expect(forced.reason).toBe("person_required");
      expect((yield* listed(attachId))?.state).toBe("linked");
    }),
  ),
);

it.effect(
  "a silent machine keeps its link: GOAT tries a new purge every 30 minutes, removes the link without it after 24 hours, and cleans it once it answers",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId, linkId } = yield* linked(pen, home, host, 1);
        ocx.machineAnswers = false;
        yield* detach(PERSON, attachId, "d-1");
        yield* detachPass;
        yield* detachPass; // inside the 30 minutes: nothing is sent
        expect(ocx.sent).toEqual([attachId + ".purge.1"]);
        expect((yield* listed(attachId))?.message).toContain("does not answer");
        for (let check = 0; check < 48; check += 1) {
          yield* TestClock.adjust(HOUR / 2);
          yield* detachPass;
        }
        // Each try used a new id (OpenCodex replays a failed_clean id). 48 failures span 23.5 hours,
        // so the 49th, 24 hours after the first, forces.
        expect(ocx.sent.filter((id) => id.includes(".purge."))).toHaveLength(49);
        expect(ocx.sent.at(-1)).toBe(attachId + ".force.50");
        // Each purge it gave up on is resolved, so the Home keeps no trail of unknown entries.
        expect(ocx.resolved).toHaveLength(49);
        expect(ocx.tombstones.has(linkId)).toBe(true);
        expect((yield* listed(attachId))?.message).toContain(
          "ocx link recover --forget --link-id " + linkId,
        );
        ocx.machineAnswers = true;
        yield* TestClock.adjust(HOUR / 2);
        yield* detachPass;
        expect(ocx.tombstones.has(linkId)).toBe(false);
        expect((yield* listed(attachId))?.state).toBe("purged");
      }),
    ),
);

it.effect(
  "a Child that refuses the purge holds the detach for a person, who forces it; recover then cleans it",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId, linkId } = yield* linked(pen, home, host, 1);
        ocx.childRefusal = "child_residual";
        yield* detach(THREAD, attachId, "d-1");
        yield* detachPass;
        yield* TestClock.adjust(2 * HOUR);
        yield* detachPass;
        // No blind retry: the refusal waits for a person.
        expect(ocx.sent).toEqual([attachId + ".purge.1"]);
        const held = yield* listed(attachId);
        expect(held?.message).toContain("records it cannot restore");
        expect(held?.message).toContain(attachId + ".purge.1");
        yield* detach(PERSON, attachId, "d-2", true);
        yield* detachPass;
        expect(ocx.sent.at(-1)).toBe(attachId + ".force.2");
        expect(ocx.tombstones.has(linkId)).toBe(true);
        yield* TestClock.adjust(HOUR);
        yield* detachPass;
        expect((yield* listed(attachId))?.state).toBe("purged");
      }),
    ),
);

it.effect("a lost answer is read back and the same revoke id is sent again, never a new one", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      const ocx = fakeDetachHome(host);
      const { attachId } = yield* linked(pen, home, host, 1);
      yield* detach(THREAD, attachId, "d-1");
      ocx.loseRead = 1;
      yield* detachPass;
      yield* detachPass;
      // The repeat replays the purge that committed while its answer was lost.
      expect(ocx.sent).toEqual([attachId + ".purge.1", attachId + ".purge.1"]);
      expect((yield* listed(attachId))?.state).toBe("purged");
    }),
  ),
);

it.effect("a person's force on a silent machine resolves the unknown purge it supersedes", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      const ocx = fakeDetachHome(host);
      const { attachId } = yield* linked(pen, home, host, 1);
      ocx.machineAnswers = false;
      yield* detach(PERSON, attachId, "d-1");
      yield* detachPass; // the purge settles unknown on the Home
      yield* detach(PERSON, attachId, "d-2", true);
      yield* detachPass;
      expect(ocx.resolved).toEqual([attachId + ".purge.1"]);
      expect(ocx.sent).toEqual([attachId + ".purge.1", attachId + ".force.2"]);
    }),
  ),
);

it.effect(
  "a linked machine silent for 24 hours is retired, returns once it answers, and then detaches at once",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId, nodeId, linkId } = yield* linked(pen, home, host, 1);
        host.control.reachAnswers.set(nodeId, "unreachable");
        ocx.machineAnswers = false;
        yield* detachPass;
        for (let check = 0; check < 47; check += 1) {
          yield* TestClock.adjust(HOUR / 2);
          yield* detachPass;
        }
        // 48 failures span 23.5 hours: not yet.
        expect((yield* listed(attachId))?.state).toBe("linked");
        yield* TestClock.adjust(HOUR / 2);
        yield* detachPass;
        expect((yield* listed(attachId))?.state).toBe("retired");
        expect(ocx.tombstones.has(linkId)).toBe(true);
        host.control.reachAnswers.delete(nodeId);
        ocx.machineAnswers = true;
        yield* TestClock.adjust(HOUR / 2);
        yield* detachPass;
        expect((yield* listed(attachId))?.state).toBe("returned");
        const sent = ocx.sent.length;
        yield* detach(PERSON, attachId, "d-1");
        yield* detachPass;
        expect(ocx.sent).toHaveLength(sent);
        expect((yield* listed(attachId))?.state).toBe("purged");
      }),
    ),
);

it.effect("an answer before the 48th failed check resets the count", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      fakeDetachHome(host);
      const { attachId, nodeId } = yield* linked(pen, home, host, 1);
      host.control.reachAnswers.set(nodeId, "unreachable");
      for (let check = 0; check < 47; check += 1) {
        yield* detachPass;
        yield* TestClock.adjust(HOUR / 2);
      }
      host.control.reachAnswers.delete(nodeId);
      yield* detachPass;
      host.control.reachAnswers.set(nodeId, "unreachable");
      for (let check = 0; check < 10; check += 1) {
        yield* TestClock.adjust(HOUR / 2);
        yield* detachPass;
      }
      expect((yield* listed(attachId))?.state).toBe("linked");
    }),
  ),
);

it.effect(
  "recover's refusal is a wait with its own text, and a tombstone a person forgot ends the detach",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId, linkId } = yield* linked(pen, home, host, 1);
        ocx.recoverRefusal = "alias_linked";
        yield* detach(PERSON, attachId, "d-1", true);
        yield* detachPass;
        yield* TestClock.adjust(HOUR);
        yield* detachPass;
        expect((yield* listed(attachId))?.message).toContain(
          "another link of this hub uses its alias",
        );
        ocx.forget(linkId);
        yield* TestClock.adjust(HOUR);
        yield* detachPass;
        const done = yield* listed(attachId);
        expect(done?.state).toBe("purged");
        expect(done?.message).toContain("forgot its cleanup");
      }),
    ),
);

it.effect("a linked machine whose link names a moved key path says to move GOAT's home back", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      fakeDetachHome(host);
      const { attachId, linkId } = yield* linked(pen, home, host, 1);
      const record = host.control.links.get(linkId);
      host.control.links.set(linkId, {
        ...record,
        explicitRoute: {
          ...(record?.explicitRoute as object),
          identityFile: "/old/goat/machine_ed25519",
        },
      });
      yield* detachPass;
      expect((yield* listed(attachId))?.message).toContain("Move it back to bring the link back");
    }),
  ),
);

it.effect(
  "a detach during an open link operation waits for its journal and removes the link it committed",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        withIdentity(home);
        const { attachId } = yield* joined(pen, host, 1);
        host.control.adds.push("open");
        for (let pass = 0; pass < 3; pass += 1) yield* enroll; // the add left its entry open
        yield* detach(THREAD, attachId, "d-1");
        yield* detachPass;
        expect(ocx.sent).toEqual([]);
        expect((yield* listed(attachId))?.message).toContain(
          "reading what its last link operation left",
        );
        // The Home finishes the operation: the link exists, and only now is it removed.
        const operation = host.control.journal.get(attachId + ".link.1");
        if (operation !== undefined) {
          operation.state = "committed";
          host.control.links.set(operation.linkId, {
            id: operation.linkId,
            alias: operation.alias,
          });
        }
        yield* detachPass;
        yield* detachPass;
        expect(ocx.sent).toEqual([attachId + ".purge.1"]);
        expect((yield* listed(attachId))?.state).toBe("purged");
      }),
    ),
);

it.effect(
  "an invite used without a saved admit holds its slot until a person releases it, and the text names pen revoke",
  () =>
    world((pen, _home, _grant, _host) =>
      Effect.gen(function* () {
        const first = yield* attach(1);
        pen.control.join(first.attachId + ".1", false);
        yield* reconcile;
        const stuck = yield* listed(first.attachId);
        expect(stuck?.state).toBe("unknown");
        // Mobile users and agents learn of Release from the message itself.
        expect(stuck?.message).toContain("Release");
        yield* attach(2);
        // The cap is 2 and the unknown record still holds its slot.
        expect((yield* attach(3).pipe(Effect.flip)).reason).toBe("cap_reached");
        expect((yield* release(THREAD, first.attachId, "r-1").pipe(Effect.flip)).reason).toBe(
          "person_required",
        );
        // While its invite could still be used, nothing is released.
        expect((yield* release(PERSON, first.attachId, "r-3").pipe(Effect.flip)).reason).toBe(
          "conflict",
        );
        yield* TestClock.adjust(11 * 60 * 1000);
        const released = yield* release(PERSON, first.attachId, "r-2");
        expect(released.state).toBe("failed");
        expect(released.message).toContain("did not hold its key");
        expect((yield* attach(3)).state).toBe("invited");
        // The pass that acknowledges its burned invite keeps the record released.
        yield* reconcile;
        expect(yield* listed(first.attachId)).toMatchObject({ state: "failed", step: "released" });
      }),
    ),
);

it.effect(
  "a detach while enrollment is sending its link add waits for it and removes the link it made",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        withIdentity(home);
        const { attachId } = yield* joined(pen, host, 1);
        yield* enroll; // route
        yield* enroll; // reach
        host.control.holdAdd = yield* makeHold();
        const linking = yield* Effect.forkChild(enroll);
        yield* Deferred.await(host.control.holdAdd.arrived); // the id is stored, ocx not yet run
        yield* detach(THREAD, attachId, "d-1");
        yield* detachPass;
        expect((yield* listed(attachId))?.state).toBe("detaching");
        yield* Deferred.succeed(host.control.holdAdd.release, undefined);
        yield* Fiber.join(linking);
        for (let pass = 0; pass < 3; pass += 1) yield* detachPass;
        expect(ocx.sent).toEqual([attachId + ".purge.1"]);
        expect(host.control.links.size).toBe(0);
        expect((yield* listed(attachId))?.state).toBe("purged");
      }),
    ),
);

it.effect("a revoke whose id was stored but never answered is sent again under that id", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      const ocx = fakeDetachHome(host);
      const { attachId } = yield* linked(pen, home, host, 1);
      yield* detach(THREAD, attachId, "d-1");
      // GOAT stopped right after storing the id: no answer was saved.
      const sql = yield* SqlClient.SqlClient;
      const [stored] = yield* sql<{ readonly enroll_json: string }>`SELECT enroll_json
        FROM disposable_machines WHERE attach_id = ${attachId}`;
      const enrolled = decodeEnroll(stored?.enroll_json ?? "{}");
      const intent = { step: "revoke", attempt: 1, operationId: attachId + ".purge.1", sends: 1 };
      const json = encodeEnroll({ ...enrolled, detach: intent });
      yield* sql`UPDATE disposable_machines SET enroll_json = ${json} WHERE attach_id = ${attachId}`;
      yield* detachPass;
      expect(ocx.sent).toEqual([attachId + ".purge.1"]);
      expect((yield* listed(attachId))?.state).toBe("purged");
    }),
  ),
);

it.effect(
  "a silent machine removed from Pen while detaching is forced 24 hours after its first failed purge, and ends once a person forgets its cleanup",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId, linkId } = yield* linked(pen, home, host, 1);
        ocx.machineAnswers = false;
        yield* detach(THREAD, attachId, "d-1");
        yield* detachPass;
        pen.members.delete(key(1));
        yield* reconcile;
        expect(yield* listed(attachId)).toMatchObject({ state: "detaching", penMember: false });
        for (let check = 0; check < 48; check += 1) {
          yield* TestClock.adjust(HOUR / 2);
          yield* detachPass;
        }
        // Out of Pen it cannot answer again; the open record holds its slot until its cleanup ends.
        expect(ocx.tombstones.has(linkId)).toBe(true);
        const forced = yield* listed(attachId);
        expect(forced?.message).toContain("ocx link recover --forget --link-id " + linkId);
        expect(forced?.message).toContain("has left Pen");
        ocx.forget(linkId);
        yield* TestClock.adjust(HOUR / 2);
        yield* detachPass;
        const done = yield* listed(attachId);
        expect(done).toMatchObject({ state: "purged", penMember: false });
        // It left Pen, so nothing tells a person to remove it again.
        expect(done?.message).toContain("has left Pen");
        expect(done?.message).not.toContain("pen revoke");
      }),
    ),
);

it.effect(
  "a refused forced revoke waits for a person, who forces again: the same id first, which only replays, then a new id, as OpenCodex asks",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId, linkId } = yield* linked(pen, home, host, 1);
        ocx.tombstoneLimit = true;
        yield* detach(PERSON, attachId, "d-1", true);
        yield* detachPass;
        yield* TestClock.adjust(2 * HOUR);
        yield* detachPass;
        expect(ocx.sent).toEqual([attachId + ".force.1"]);
        expect((yield* listed(attachId))?.message).toContain("too many links removed");
        expect((yield* listed(attachId))?.message).toContain("forces the detach again");
        ocx.tombstoneLimit = false;
        yield* detach(PERSON, attachId, "d-2", true);
        yield* detachPass;
        expect(ocx.sent).toEqual([
          attachId + ".force.1",
          attachId + ".force.1",
          attachId + ".force.2",
        ]);
        expect(ocx.tombstones.has(linkId)).toBe(true);
      }),
    ),
);

it.effect("every record gets its turn when a pass takes fewer records than are open", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      fakeDetachHome(host);
      const first = yield* linked(pen, home, host, 1);
      const second = yield* linked(pen, home, host, 2);
      const exclusive = (yield* Semaphore.make(1)).withPermits(1);
      const small = yield* makeDetach(exclusive, () => Effect.succeed(false), 1);
      const checked = () => new Set(host.control.reached.map((route) => route.nodeId));
      const before = host.control.reached.length;
      yield* small.pass;
      yield* small.pass;
      const nodes = new Set(host.control.reached.slice(before).map((route) => route.nodeId));
      expect(checked().size).toBeGreaterThan(0);
      expect(nodes).toEqual(new Set([first.nodeId, second.nodeId]));
    }),
  ),
);

it.effect("a thread the switch no longer names cannot detach", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      fakeDetachHome(host);
      const { attachId } = yield* linked(pen, home, host, 1);
      yield* switchTo({ provisioners: [] });
      expect((yield* detach(THREAD, attachId, "d-1").pipe(Effect.flip)).reason).toBe(
        "provisioner_refused",
      );
    }),
  ),
);

it.effect(
  "a linked machine that presents another SSH host key says so and how to remove it, and names its link once out of Pen",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        fakeDetachHome(host);
        const { attachId, nodeId, linkId } = yield* linked(pen, home, host, 1);
        host.control.reachAnswers.set(nodeId, "host_key_changed");
        yield* detachPass;
        const changed = yield* listed(attachId);
        expect(changed?.class).toBe("conflict");
        expect(changed?.message).toContain("another SSH host key");
        expect(changed?.message).toContain("pen revoke");
        pen.members.delete(key(1));
        yield* reconcile;
        yield* enroll;
        expect((yield* listed(attachId))?.message).toContain("ocx link revoke --link-id " + linkId);
        // A forced revoke leaves a tombstone, which only a person forgets.
        expect((yield* listed(attachId))?.message).toContain(
          "ocx link recover --forget --link-id " + linkId,
        );
      }),
    ),
);

it.effect("a link removed outside GOAT ends the detach with a text that says so", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      const ocx = fakeDetachHome(host);
      const { attachId, linkId } = yield* linked(pen, home, host, 1);
      host.control.links.delete(linkId);
      yield* detach(THREAD, attachId, "d-1");
      yield* detachPass;
      expect((yield* listed(attachId))?.message).toContain("removed outside GOAT");
      yield* detachPass;
      const done = yield* listed(attachId);
      expect(done?.state).toBe("purged");
      expect(done?.message).toContain("removed outside GOAT");
      expect(done?.message).not.toContain("forgot");
      expect(ocx.tombstones.size).toBe(0);
    }),
  ),
);

it.effect(
  "a forced revoke refused before the journal three times waits for a person, whose force reads its id and goes on",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId, linkId } = yield* linked(pen, home, host, 1);
        ocx.busy = 3;
        yield* detach(PERSON, attachId, "d-1", true);
        for (let pass = 0; pass < 5; pass += 1) yield* detachPass;
        expect(ocx.sent).toEqual([
          attachId + ".force.1",
          attachId + ".force.1",
          attachId + ".force.1",
        ]);
        // Refused before its journal entry: OpenCodex never recorded it, so there is nothing to resolve.
        expect((yield* listed(attachId))?.message).toContain("never recorded");
        yield* detach(PERSON, attachId, "d-2", true);
        yield* detachPass;
        expect(ocx.sent.at(-1)).toBe(attachId + ".force.1");
        expect(ocx.tombstones.has(linkId)).toBe(true);
      }),
    ),
);

it.effect("a machine with no planted ocx-child stops for a person with its own text", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      const ocx = fakeDetachHome(host);
      const { attachId } = yield* linked(pen, home, host, 1);
      ocx.childMissing = true;
      yield* detach(THREAD, attachId, "d-1");
      yield* detachPass;
      yield* TestClock.adjust(HOUR);
      yield* detachPass;
      expect(ocx.sent).toEqual([attachId + ".purge.1"]);
      expect((yield* listed(attachId))?.message).toContain("no planted ocx-child");
    }),
  ),
);

it.effect(
  "a changed host key blocks a thread, and a person's force removes the link without the machine",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId, nodeId, linkId } = yield* linked(pen, home, host, 1);
        host.control.reachAnswers.set(nodeId, "host_key_changed");
        yield* detachPass;
        expect((yield* detach(THREAD, attachId, "d-1").pipe(Effect.flip)).reason).toBe("conflict");
        yield* detach(PERSON, attachId, "d-2", true);
        yield* detachPass;
        expect(ocx.sent).toEqual([attachId + ".force.1"]);
        expect(ocx.tombstones.has(linkId)).toBe(true);
        yield* TestClock.adjust(HOUR);
        yield* detachPass;
        expect((yield* listed(attachId))?.state).toBe("purged");
      }),
    ),
);

it.effect(
  "release asks Pen first: a key that joined is recorded as in Pen and refused, an unreadable list is refused",
  () =>
    world((pen, _home, _grant, _host) =>
      Effect.gen(function* () {
        const first = yield* attach(1);
        pen.control.join(first.attachId + ".1", false);
        yield* reconcile;
        yield* TestClock.adjust(11 * 60 * 1000);
        pen.control.membersUnreadable = true;
        const unreadable = yield* release(PERSON, first.attachId, "r-1").pipe(Effect.flip);
        expect(unreadable.reason).toBe("pen_unavailable");
        pen.control.membersUnreadable = false;
        pen.members.add(key(1));
        const joinedAnyway = yield* release(PERSON, first.attachId, "r-2").pipe(Effect.flip);
        expect(joinedAnyway.reason).toBe("conflict");
        expect(joinedAnyway.detail).toContain("joined Pen");
        const machine = yield* listed(first.attachId);
        expect(machine).toMatchObject({ penMember: true });
        expect(machine?.message).toContain("pen revoke");
        // It holds its slot again: the cap of 2 counts it.
        yield* attach(2);
        expect((yield* attach(3).pipe(Effect.flip)).reason).toBe("cap_reached");
      }),
    ),
);

it.effect(
  "a retirement force whose answer was lost is read back before the machine counts as linked again",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId, nodeId, linkId } = yield* linked(pen, home, host, 1);
        host.control.reachAnswers.set(nodeId, "unreachable");
        ocx.machineAnswers = false;
        yield* detachPass;
        for (let check = 0; check < 47; check += 1) {
          yield* TestClock.adjust(HOUR / 2);
          yield* detachPass;
        }
        ocx.loseRead = 1;
        yield* TestClock.adjust(HOUR / 2);
        yield* detachPass; // the force commits, its answer is lost
        expect(ocx.tombstones.has(linkId)).toBe(true);
        host.control.reachAnswers.delete(nodeId);
        ocx.machineAnswers = true;
        yield* TestClock.adjust(HOUR / 2);
        yield* detachPass;
        expect((yield* listed(attachId))?.state).not.toBe("linked");
      }),
    ),
);

// A consent read before the lock sees the thread still named while the person's change holds it;
// only a read under the lock sees the change, so a pre-lock check lets this detach through.
it.effect(
  "a person's provisioner change that holds the settings lock decides a thread's detach waiting on it",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        fakeDetachHome(host);
        const { attachId } = yield* linked(pen, home, host, 1);
        const settings = yield* Settings.ServerSettingsService;
        const holding = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const removing = yield* Effect.forkChild(
          withPersonConsent(
            settings.updateSettings(
              { hub: { attachDisposableMachines: { provisioners: [] } } },
              Deferred.succeed(holding, undefined).pipe(Effect.andThen(Deferred.await(gate))),
            ),
          ),
        );
        yield* Deferred.await(holding); // the person's change holds the settings write lock
        home.settingsAccess = yield* Deferred.make<void>();
        const detaching = yield* Effect.forkChild(Effect.flip(detach(THREAD, attachId, "d-1")));
        yield* Deferred.await(home.settingsAccess); // the detach reads the consent now
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(removing);
        expect((yield* Fiber.join(detaching)).reason).toBe("provisioner_refused");
        expect((yield* listed(attachId))?.state).toBe("linked");
      }),
    ),
);

it.effect(
  "checks that fail while Pen's daemon does not answer do not count toward retirement; once it answers they do",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        fakeDetachHome(host);
        const { attachId, nodeId } = yield* linked(pen, home, host, 1);
        host.control.reachAnswers.set(nodeId, "unreachable");
        // The hub is up and Pen's route file is still in place, but Pen's daemon does not answer.
        pen.control.membersUnreadable = true;
        yield* detachPass;
        for (let check = 0; check < 50; check += 1) {
          yield* TestClock.adjust(HOUR / 2);
          yield* detachPass;
        }
        expect((yield* listed(attachId))?.state).toBe("linked");
        pen.control.membersUnreadable = false;
        for (let check = 0; check < 49; check += 1) {
          yield* TestClock.adjust(HOUR / 2);
          yield* detachPass;
        }
        expect((yield* listed(attachId))?.state).toBe("retired");
      }),
    ),
);
