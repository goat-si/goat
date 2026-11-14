import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { listed, world } from "./DisposableAttach.testkit.ts";
import { fakeDetachHome } from "./DisposableDetach.testkit.ts";
import { detach, detachPass, HOUR, PERSON, THREAD } from "./DisposableDetach.flow.testkit.ts";
import { enroll, joined, withIdentity } from "./DisposableEnroll.joined.testkit.ts";

it.effect(
  "a detach stopped at an unsettled link operation is forced by a person: no link listed ends it with a text naming the operation",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        withIdentity(home);
        const { attachId } = yield* joined(pen, host, 1);
        host.control.adds.push("unknown");
        for (let pass = 0; pass < 3; pass += 1) yield* enroll; // the add ended unknown
        expect((yield* listed(attachId))?.state).toBe("unknown");
        yield* detach(PERSON, attachId, "d-1");
        yield* detachPass;
        expect((yield* listed(attachId))?.message).toContain(attachId + ".link.1");
        yield* detach(PERSON, attachId, "d-2", true);
        yield* detachPass;
        const done = yield* listed(attachId);
        expect(done?.state).toBe("purged");
        expect(done?.message).toContain(attachId + ".link.1");
        expect(done?.message).toContain("may hold the planted Child");
        expect(ocx.sent).toEqual([]);
      }),
    ),
);

it.effect(
  "a detach whose link operation stays open stops after 10 quiet minutes naming it, and a person's force ends it by the link list",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        withIdentity(home);
        const { attachId } = yield* joined(pen, host, 1);
        host.control.adds.push("open");
        host.control.openStaysOpen = true;
        for (let pass = 0; pass < 3; pass += 1) yield* enroll; // the Home stopped mid-add
        yield* detach(THREAD, attachId, "d-1");
        yield* detachPass;
        expect((yield* listed(attachId))?.message).toContain(
          "reading what its last link operation",
        );
        yield* TestClock.adjust(11 * 60 * 1000);
        yield* detachPass;
        const stopped = yield* listed(attachId);
        expect(stopped?.message).toContain("still lists");
        expect(stopped?.message).toContain(attachId + ".link.1");
        yield* detach(PERSON, attachId, "d-2", true);
        yield* detachPass;
        expect((yield* listed(attachId))?.state).toBe("purged");
        expect(ocx.sent).toEqual([]);
      }),
    ),
);

it.effect(
  "a link operation a person resolved lets the detach remove the link OpenCodex lists",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        withIdentity(home);
        const { attachId } = yield* joined(pen, host, 1);
        host.control.adds.push("unknown");
        for (let pass = 0; pass < 3; pass += 1) yield* enroll;
        const operation = host.control.journal.get(attachId + ".link.1");
        if (operation !== undefined) operation.resolvedAt = "2026-11-15T00:00:00.000Z";
        // OpenCodex commits the link under the id the operation reserved.
        host.control.commit(attachId + ".link.1");
        if (operation !== undefined) operation.state = "unknown";
        yield* detach(THREAD, attachId, "d-1");
        for (let pass = 0; pass < 3; pass += 1) yield* detachPass;
        expect(ocx.sent).toEqual([attachId + ".purge.1"]);
        expect((yield* listed(attachId))?.state).toBe("purged");
      }),
    ),
);

it.effect(
  "a person's force at settle waits out the quiet window of an open link add; the add then commits and its link is revoked",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        withIdentity(home);
        const { attachId } = yield* joined(pen, host, 1);
        host.control.adds.push("open");
        host.control.openStaysOpen = true;
        for (let pass = 0; pass < 3; pass += 1) yield* enroll;
        yield* detach(THREAD, attachId, "d-1");
        yield* detachPass;
        // The Home may still be running GOAT's add; a force does not read the link list yet.
        yield* detach(PERSON, attachId, "d-2", true);
        yield* detachPass;
        expect((yield* listed(attachId))?.state).toBe("detaching");
        const linkId = host.control.journal.get(attachId + ".link.1")?.linkId ?? "";
        host.control.commit(attachId + ".link.1");
        for (let pass = 0; pass < 3; pass += 1) yield* detachPass;
        expect(host.control.links.has(linkId)).toBe(false);
        expect(ocx.sent).toEqual([attachId + ".force.1"]);
        expect((yield* listed(attachId))?.message).not.toContain("lists no link");
      }),
    ),
);

it.effect(
  "a person's force at settle never revokes a link the operation did not reserve: the record ends unproven and the link stays",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        withIdentity(home);
        const { attachId, nodeId } = yield* joined(pen, host, 1);
        host.control.adds.push("unknown");
        for (let pass = 0; pass < 3; pass += 1) yield* enroll;
        // A full install linked by hand under the same alias: not the id the add reserved.
        host.control.links.set("lnk_00000000000000aa", {
          id: "lnk_00000000000000aa",
          alias: "pen-" + nodeId,
          childKind: "full",
          exclusive: false,
        });
        yield* detach(PERSON, attachId, "d-1", true);
        yield* detachPass;
        expect(ocx.sent).toEqual([]);
        expect(host.control.links.has("lnk_00000000000000aa")).toBe(true);
        const done = yield* listed(attachId);
        expect(done?.state).toBe("purged");
        expect(done?.message).toContain("may hold the planted Child");
        expect(done?.message).toContain("lnk_00000000000000aa");
      }),
    ),
);

it.effect(
  "a link operation OpenCodex no longer has stops with its own text, and a person's force ends it",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        withIdentity(home);
        const { attachId } = yield* joined(pen, host, 1);
        host.control.adds.push("unknown");
        for (let pass = 0; pass < 3; pass += 1) yield* enroll;
        host.control.forget(attachId + ".link.1");
        yield* TestClock.adjust(3 * HOUR);
        yield* detach(THREAD, attachId, "d-1");
        yield* detachPass;
        yield* TestClock.adjust(11 * 60 * 1000);
        yield* detachPass;
        const stopped = yield* listed(attachId);
        expect(stopped?.message).toContain("has no record");
        expect(stopped?.nextAction).toContain("forces the detach");
        yield* detach(PERSON, attachId, "d-2", true);
        yield* detachPass;
        expect((yield* listed(attachId))?.state).toBe("purged");
        expect(ocx.sent).toEqual([]);
      }),
    ),
);
