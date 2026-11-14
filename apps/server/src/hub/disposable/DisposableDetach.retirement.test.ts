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
import { decodeEnroll } from "./enrollModel.ts";

type Host = Parameters<Parameters<typeof world>[0]>[3];

/** A linked machine that stops answering, with the switch for its handshake and its Child. */
const silencer =
  (host: Host, ocx: ReturnType<typeof fakeDetachHome>, nodeId: string) => (on: boolean) => {
    if (on) host.control.reachAnswers.set(nodeId, "unreachable");
    else host.control.reachAnswers.delete(nodeId);
    ocx.machineAnswers = !on;
  };
/** 24 silent hours of checks: the retirement force goes at the last one. */
const silentDay = Effect.gen(function* () {
  yield* detachPass;
  for (let check = 0; check < 48; check += 1) {
    yield* TestClock.adjust(HOUR / 2);
    yield* detachPass;
  }
});

it.effect(
  "a stopped retirement force read back open once the machine answers says so; a thread's detach is refused and a person's goes on with that removal",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId, nodeId } = yield* linked(pen, home, host, 1);
        const force1 = attachId + ".force.1";
        const silent = silencer(host, ocx, nodeId);
        silent(true);
        ocx.forceOpen = true;
        yield* silentDay;
        expect(ocx.sent).toEqual([force1]);
        yield* detachPass;
        // The third send's reads are lost, so the stop keeps an unreadable outcome for an open entry.
        ocx.loseRead = 2;
        yield* detachPass;
        yield* detachPass;
        expect((yield* listed(attachId))?.message).toContain("stopped");
        silent(false);
        yield* TestClock.adjust(HOUR / 2);
        yield* detachPass;
        expect((yield* listed(attachId))?.message).toContain("is still open in OpenCodex");
        ocx.forceOpen = false;
        // Repeating it may resume a removal without the machine: only a person goes on with it.
        const refused = yield* detach(THREAD, attachId, "d-1").pipe(Effect.flip);
        expect(refused.reason).toBe("person_required");
        expect((yield* listed(attachId))?.state).toBe("linked");
        yield* detach(PERSON, attachId, "d-2");
        yield* detachPass;
        expect(ocx.sent.filter((id) => id.includes(".purge."))).toEqual([]);
        expect(ocx.sent.at(-1)).toBe(force1);
      }),
    ),
);

it.effect(
  "an agent's detach of a machine that answered and then failed one check is refused while its forced removal reads unknown: it neither continues it nor drops its id",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId, nodeId } = yield* linked(pen, home, host, 1);
        const silent = silencer(host, ocx, nodeId);
        const forces = () => ocx.sent.filter((id) => id.includes(".force.")).length;
        silent(true);
        ocx.commitFails = 100;
        yield* silentDay;
        for (let pass = 0; pass < 3; pass += 1) yield* detachPass;
        expect((yield* listed(attachId))?.message).toContain("stopped");
        // It answers (the force's entry stays unknown), then misses one check.
        silent(false);
        yield* TestClock.adjust(HOUR / 2);
        yield* detachPass;
        silent(true);
        yield* TestClock.adjust(HOUR / 2);
        yield* detachPass;
        const before = forces();
        const refused = yield* detach(THREAD, attachId, "d-1").pipe(Effect.flip);
        expect(refused.reason).toBe("person_required");
        yield* detachPass;
        expect(forces()).toBe(before);
        expect(ocx.sent.filter((id) => id.includes(".purge."))).toEqual([]);
        expect((yield* listed(attachId))?.message).toContain(attachId + ".force.1");
      }),
    ),
);

it.effect(
  "a person's detach after an unreadable read-back reads the forced removal first: one OpenCodex still holds is repeated, never replaced by a purge",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId, nodeId } = yield* linked(pen, home, host, 1);
        const force1 = attachId + ".force.1";
        const silent = silencer(host, ocx, nodeId);
        silent(true);
        // The force claims its removal and fails at commit: unknown, owning it.
        ocx.commitFails = 100;
        yield* silentDay;
        yield* detachPass;
        // The third send's reads are lost, so the stop keeps an unreadable outcome.
        ocx.loseRead = 2;
        yield* detachPass;
        yield* detachPass;
        silent(false);
        ocx.loseRead = 100;
        yield* TestClock.adjust(HOUR / 2);
        yield* detachPass;
        expect((yield* listed(attachId))?.message).toContain("reads it again within 30 minutes");
        ocx.loseRead = 0;
        ocx.commitFails = 0;
        yield* detach(PERSON, attachId, "d-1");
        yield* detachPass;
        expect(ocx.sent.filter((id) => id.includes(".purge."))).toEqual([]);
        expect(ocx.sent.at(-1)).toBe(force1);
        expect(ocx.tombstones.size).toBe(1);
      }),
    ),
);

it.effect(
  "a stopped retirement that cannot be read back once the machine answers never claims it is still open, and a person's detach then purges, as the text says",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId, nodeId, linkId } = yield* linked(pen, home, host, 1);
        const silent = silencer(host, ocx, nodeId);
        silent(true);
        ocx.tombstoneLimit = true;
        yield* silentDay;
        expect((yield* listed(attachId))?.message).toContain("too many links removed");
        silent(false);
        ocx.tombstoneLimit = false;
        ocx.loseRead = 100;
        // GOAT's home moved meanwhile: the unreadable read-back still records it.
        const record = host.control.links.get(linkId);
        host.control.links.set(linkId, {
          ...record,
          explicitRoute: {
            ...(record?.explicitRoute as object),
            identityFile: "/old/goat/machine_ed25519",
          },
        });
        yield* TestClock.adjust(HOUR / 2);
        yield* detachPass;
        const shown = yield* listed(attachId);
        expect(shown?.message).not.toContain("still open");
        expect(shown?.message).toContain("reads it again within 30 minutes");
        expect(shown?.message).toContain("removes the link together with the machine");
        const row = (yield* rows).find((one) => one.attach_id === attachId);
        expect(decodeEnroll(String(row?.enroll_json)).linkKeyMoved).toBe(true);
        ocx.loseRead = 0;
        yield* detach(PERSON, attachId, "d-1");
        yield* detachPass;
        expect(ocx.sent.at(-1)).toContain(".purge.");
      }),
    ),
);

it.effect(
  "a forced retirement that reads unknown once the machine answers is repeated first by a person's detach, as its text says",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId, nodeId } = yield* linked(pen, home, host, 1);
        const silent = silencer(host, ocx, nodeId);
        silent(true);
        ocx.commitFails = 4;
        yield* silentDay;
        for (let pass = 0; pass < 3; pass += 1) yield* detachPass;
        silent(false);
        yield* TestClock.adjust(HOUR / 2);
        yield* detachPass;
        const shown = yield* listed(attachId);
        expect(shown?.message).toContain("reads unknown in OpenCodex");
        expect(shown?.message).toContain("which repeats it first");
        // The fault is fixed: the person's detach repeats the forced id, which finishes the removal.
        ocx.commitFails = 0;
        yield* detach(PERSON, attachId, "d-1");
        yield* detachPass;
        expect(ocx.sent.at(-1)).toBe(attachId + ".force.1");
        expect(ocx.tombstones.size).toBe(1);
        expect((yield* listed(attachId))?.message).toContain("its link is gone");
      }),
    ),
);
