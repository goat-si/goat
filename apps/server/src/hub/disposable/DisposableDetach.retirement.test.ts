import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { listed, world } from "./DisposableAttach.testkit.ts";
import { fakeDetachHome } from "./DisposableDetach.testkit.ts";
import { detach, detachPass, HOUR, linked, THREAD } from "./DisposableDetach.flow.testkit.ts";

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
  "a stopped retirement force read back open once the machine answers says so, and a detach goes on with that removal",
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
        // OpenCodex refuses every other revoke while that one is open: even a thread's detach repeats it.
        ocx.forceOpen = false;
        yield* detach(THREAD, attachId, "d-1");
        yield* detachPass;
        expect(ocx.sent.filter((id) => id.includes(".purge."))).toEqual([]);
        expect(ocx.sent.at(-1)).toBe(force1);
      }),
    ),
);

it.effect(
  "an agent's detach never continues a forced removal of a machine that answered and then failed one check: it starts a purge",
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
        yield* detach(THREAD, attachId, "d-1");
        yield* detachPass;
        expect(forces()).toBe(before);
        expect(ocx.sent.at(-1)).toContain(".purge.");
      }),
    ),
);
