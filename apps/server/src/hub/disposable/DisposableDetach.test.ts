import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as Attach from "./DisposableAttach.ts";
import { listed, rows, world } from "./DisposableAttach.testkit.ts";
import { fakeDetachHome } from "./DisposableDetach.testkit.ts";
import { enroll, joined, withIdentity } from "./DisposableEnroll.joined.testkit.ts";

const HOUR = 60 * 60 * 1000;
const THREAD: Attach.AttachCaller = {
  provisioner: { kind: "thread", threadId: "thread-provisioner" },
};
const PERSON: Attach.AttachCaller = { provisioner: { kind: "person" } };
const detachPass = Effect.flatMap(Attach.DisposableAttach, (service) => service.detachPass);
const detach = (caller: Attach.AttachCaller, attachId: string, request: string, force?: boolean) =>
  Effect.flatMap(Attach.DisposableAttach, (service) =>
    service.detach(caller, caller.provisioner.kind + ":x", {
      attachId,
      clientRequestId: request,
      ...(force === undefined ? {} : { force }),
    }),
  );

/** Machine n joined and linked as an exclusive lightweight Child. */
const linked = (
  pen: Parameters<Parameters<typeof world>[0]>[0],
  home: Parameters<Parameters<typeof world>[0]>[1],
  host: Parameters<Parameters<typeof world>[0]>[3],
  n: number,
) =>
  Effect.gen(function* () {
    withIdentity(home);
    const joinedMachine = yield* joined(pen, host, n);
    for (let pass = 0; pass < 4; pass += 1) yield* enroll;
    const machine = yield* listed(joinedMachine.attachId);
    expect(machine?.state).toBe("linked");
    const row = (yield* rows).find((one) => one.attach_id === joinedMachine.attachId);
    return { ...joinedMachine, linkId: String(row?.link_id) };
  });

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
      ocx.machineAnswers = false;
      yield* detach(THREAD, attachId, "d-1");
      ocx.loseRead = 1;
      yield* detachPass;
      ocx.machineAnswers = true;
      yield* detachPass;
      expect(ocx.sent).toEqual([attachId + ".purge.1", attachId + ".purge.1"]);
      expect((yield* listed(attachId))?.state).toBe("purged");
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
          "another link of this hub uses the machine's alias",
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
