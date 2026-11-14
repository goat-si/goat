import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { listed, world } from "./DisposableAttach.testkit.ts";
import { fakeDetachHome } from "./DisposableDetach.testkit.ts";
import {
  audits,
  detach,
  detachPass,
  HOUR,
  linked,
  PERSON,
  storeDetach,
} from "./DisposableDetach.flow.testkit.ts";

// What GOAT does with its own earlier revoke (the owner) when its reads fail, when it finished
// meanwhile, or when a newer id is refused; each needs an OpenCodex fault at a narrow moment.

/** GOAT's purge finished on the Home meanwhile (someone repeated it), with the Child's receipt. */
const finished = (ocx: ReturnType<typeof fakeDetachHome>, operationId: string) => {
  const entry = ocx.revokes.get(operationId);
  if (entry === undefined) return;
  entry.state = "committed";
  delete entry.ownsReceipt;
  delete entry.code;
};

const passes = (count: number) =>
  Effect.gen(function* () {
    for (let pass = 0; pass < count; pass += 1) yield* detachPass;
  });

it.effect(
  "a forced revoke whose owner can never be read after link_not_found stops naming no read, never a resolve of an id OpenCodex did not journal",
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
        // Someone repeats GOAT's purge on the Home: it finishes, and GOAT can never read it after.
        finished(ocx, purge);
        host.control.links.delete(linkId);
        ocx.readFails = (id) => id === purge && ocx.sent.at(-1)?.includes(".force.") === true;
        yield* detach(PERSON, attachId, "d-3");
        yield* passes(5);
        const stopped = yield* listed(attachId);
        expect(stopped?.message).toContain("gave no readable answer");
        expect(stopped?.message).toContain("link_not_found");
        expect(stopped?.message).not.toContain("resolve");
      }),
    ),
);

it.effect(
  "a new purge whose owner can never be read after link_not_found stops naming no read, never a resolve",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId, linkId } = yield* linked(pen, home, host, 1);
        const purge = attachId + ".purge.1";
        ocx.commitFails = 2;
        yield* detach(PERSON, attachId, "d-1");
        yield* detachPass;
        finished(ocx, purge);
        host.control.links.delete(linkId);
        ocx.readFails = (id) => id === purge && ocx.sent.at(-1) === attachId + ".purge.2";
        yield* detach(PERSON, attachId, "d-2");
        yield* passes(5);
        const stopped = yield* listed(attachId);
        expect(stopped?.message).toContain("gave no readable answer");
        expect(stopped?.message).not.toContain("resolve");
      }),
    ),
);

it.effect.each(["purge", "force"] as const)(
  "a person's detach that reads a %s owner finished meanwhile ends from it: purged, or recovered under the owner's id; never removed outside GOAT",
  (kind) =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId, linkId } = yield* linked(pen, home, host, 1);
        const owner = attachId + "." + kind + ".1";
        ocx.revokes.set(owner, {
          operationId: owner,
          linkId,
          force: kind === "force",
          state: "committed",
          ...(kind === "purge" ? { purged: true as const } : {}),
        });
        host.control.links.delete(linkId);
        if (kind === "force") ocx.tombstones.add(linkId);
        yield* storeDetach(attachId, {
          step: "revoke",
          attempt: 2,
          operationId: attachId + ".force.2",
          sends: 3,
          force: true,
          stop: "revoke_unsettled",
          outcome: "not_found",
          owner,
        });
        yield* detach(PERSON, attachId, "d-1");
        yield* TestClock.adjust(HOUR);
        yield* passes(3);
        const done = yield* listed(attachId);
        // A force owner leaves a tombstone, which recover cleans once the machine answers.
        expect(done?.state).toBe(kind === "purge" ? "purged" : "detaching");
        if (kind === "force") expect(done?.message).toContain("its link is gone");
        expect(done?.message).not.toContain("outside GOAT");
        expect(ocx.sent).toEqual([]);
        if (kind === "force") expect((yield* audits(attachId, "forced")).length).toBe(1);
      }),
    ),
);

it.effect(
  "after an owner_open stop, a person's Detach reads first: an owner that finished meanwhile is not sent again",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId, linkId } = yield* linked(pen, home, host, 1);
        const owner = attachId + ".force.1";
        ocx.revokes.set(owner, { operationId: owner, linkId, force: true, state: "committed" });
        host.control.links.delete(linkId);
        ocx.tombstones.add(linkId);
        yield* storeDetach(attachId, {
          step: "revoke",
          attempt: 2,
          operationId: attachId + ".force.2",
          sends: 1,
          force: true,
          stop: "link_retirement_owned",
          outcome: "owner_open",
          refusal: "link_operation_open",
          owner,
        });
        yield* detach(PERSON, attachId, "d-1");
        yield* detachPass;
        expect(ocx.sent).toEqual([]);
      }),
    ),
);

it.effect(
  "a Force whose stored id was refused keeps the owner that still holds the removal, and GOAT repeats that owner",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId, linkId } = yield* linked(pen, home, host, 1);
        const owner = attachId + ".force.1";
        const refused = attachId + ".force.2";
        ocx.revokes.set(owner, {
          operationId: owner,
          linkId,
          force: true,
          state: "unknown",
          code: "key_revoke_failed",
          ownsReceipt: true,
        });
        ocx.revokes.set(refused, {
          operationId: refused,
          linkId,
          force: true,
          state: "failed_clean",
          code: "revoke_refused",
        });
        yield* storeDetach(
          attachId,
          {
            step: "revoke",
            attempt: 2,
            operationId: refused,
            sends: 1,
            force: true,
            stop: "revoke_refused",
            outcome: "revoke_refused",
            owner,
          },
          "detaching",
        );
        yield* detach(PERSON, attachId, "d-1", true);
        yield* detachPass;
        expect(ocx.sent).toContain(owner);
        expect(ocx.tombstones.size).toBe(1);
      }),
    ),
);

it.effect(
  "a linked machine with a stopped retirement and a new host key is checked once per 30 minutes, with one conflict audit row (#3264)",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        fakeDetachHome(host);
        const { attachId, nodeId } = yield* linked(pen, home, host, 1);
        yield* storeDetach(attachId, {
          step: "revoke",
          attempt: 1,
          operationId: attachId + ".force.1",
          sends: 1,
          force: true,
          stop: "tombstone_limit",
          outcome: "tombstone_limit",
        });
        host.control.reachAnswers.set(nodeId, "host_key_changed");
        yield* TestClock.adjust(HOUR);
        const before = host.control.reached.length;
        yield* passes(3);
        expect(host.control.reached.length - before).toBe(1);
        expect((yield* audits(attachId, "conflict:host_key_changed")).length).toBe(1);
      }),
    ),
);
