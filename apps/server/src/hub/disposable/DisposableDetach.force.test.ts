import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { listed, world } from "./DisposableAttach.testkit.ts";
import { fakeDetachHome } from "./DisposableDetach.testkit.ts";
import { detach, detachPass, HOUR, linked, PERSON } from "./DisposableDetach.flow.testkit.ts";
import { makeHold } from "./DisposableEnroll.testkit.ts";

const audits = (attachId: string, outcome: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql<{ readonly outcome: string }>`SELECT outcome FROM audit_events
      WHERE target = ${attachId} AND outcome = ${outcome}`,
  );

it.effect(
  "a stopped retirement force is dropped once the machine answers, names no force, and a later 24 silent hours retire it again",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId, nodeId } = yield* linked(pen, home, host, 1);
        const silent = (on: boolean) => {
          if (on) host.control.reachAnswers.set(nodeId, "unreachable");
          else host.control.reachAnswers.delete(nodeId);
          ocx.machineAnswers = !on;
        };
        silent(true);
        ocx.tombstoneLimit = true;
        yield* detachPass;
        for (let check = 0; check < 48; check += 1) {
          yield* TestClock.adjust(HOUR / 2);
          yield* detachPass;
        }
        const stopped = yield* listed(attachId);
        expect(stopped?.message).toContain("stopped");
        // A linked row offers Detach only: no text names a force.
        expect(stopped?.message).not.toMatch(/forces? the detach/u);
        expect(stopped?.nextAction).not.toMatch(/forces? the detach/u);
        expect(stopped?.nextAction).toContain("detaches it");
        silent(false);
        ocx.tombstoneLimit = false;
        yield* TestClock.adjust(HOUR / 2);
        yield* detachPass;
        const back = yield* listed(attachId);
        expect(back?.state).toBe("linked");
        expect(back?.message).not.toContain("stopped");
        expect(back?.message).not.toMatch(/forces? the detach/u);
        silent(true);
        yield* detachPass;
        for (let check = 0; check < 49; check += 1) {
          yield* TestClock.adjust(HOUR / 2);
          yield* detachPass;
        }
        expect((yield* listed(attachId))?.state).toBe("retired");
        expect(ocx.sent.filter((id) => id.includes(".force.")).at(-1)).toBe(attachId + ".force.2");
      }),
    ),
);

it.effect(
  "a link_retirement_pending that persists after the one resend waits 30 minutes between tries, with no audit row per repeat, until a person's detach buys one more resend",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId } = yield* linked(pen, home, host, 1);
        ocx.machineAnswers = false;
        yield* detach(PERSON, attachId, "d-1", true);
        yield* detachPass;
        ocx.machineAnswers = true;
        ocx.pendingReceipt = true;
        ocx.pendingFault = true;
        for (let tick = 0; tick < 12; tick += 1) {
          yield* TestClock.adjust(HOUR / 4);
          yield* detachPass;
          yield* detachPass;
        }
        expect(ocx.sent).toEqual([attachId + ".force.1", attachId + ".force.1"]);
        expect((yield* audits(attachId, "forced")).length).toBe(1);
        const recovers = host.control.calls.filter((args) => args[1] === "recover").length;
        // Three hours at one try per 30 minutes, give or take the first.
        expect(recovers).toBeLessThanOrEqual(7);
        // The fault is fixed: the text tells a person to detach again, which repeats the revoke once.
        expect((yield* listed(attachId))?.message).toContain("detaches it again");
        ocx.pendingFault = false;
        yield* detach(PERSON, attachId, "d-2");
        for (let tick = 0; tick < 6; tick += 1) {
          yield* TestClock.adjust(HOUR / 2);
          yield* detachPass;
        }
        expect(ocx.sent.filter((id) => id === attachId + ".force.1")).toHaveLength(3);
        expect((yield* listed(attachId))?.state).toBe("purged");
      }),
    ),
);

it.effect(
  "a force while a silent machine's purge is in flight resolves that purge once the force commits",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId } = yield* linked(pen, home, host, 1);
        ocx.machineAnswers = false;
        yield* detach(PERSON, attachId, "d-1");
        const hold = yield* makeHold();
        host.control.holdRevoke = hold;
        const purging = yield* Effect.forkChild(detachPass);
        yield* Deferred.await(hold.arrived);
        // The person forces while the purge runs: its answer is lost to the moved fence.
        yield* detach(PERSON, attachId, "d-2", true);
        yield* Deferred.succeed(hold.release, undefined);
        yield* Fiber.join(purging);
        host.control.holdRevoke = undefined;
        yield* detachPass;
        expect(ocx.sent).toEqual([attachId + ".purge.1", attachId + ".force.2"]);
        expect(ocx.resolved).toEqual([attachId + ".purge.1"]);
      }),
    ),
);

it.effect(
  "a force while a purge is in flight that then commits with its receipt ends purged, not removed outside GOAT",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId } = yield* linked(pen, home, host, 1);
        yield* detach(PERSON, attachId, "d-1");
        const hold = yield* makeHold();
        host.control.holdRevoke = hold;
        const purging = yield* Effect.forkChild(detachPass);
        yield* Deferred.await(hold.arrived);
        yield* detach(PERSON, attachId, "d-2", true);
        yield* Deferred.succeed(hold.release, undefined);
        yield* Fiber.join(purging);
        host.control.holdRevoke = undefined;
        yield* detachPass;
        const done = yield* listed(attachId);
        expect(done?.state).toBe("purged");
        expect(done?.message).not.toContain("outside GOAT");
        expect(ocx.sent).toEqual([attachId + ".purge.1"]);
      }),
    ),
);

it.effect("a force after a handshake found a changed host key resolves the purge it replaces", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      const ocx = fakeDetachHome(host);
      const { attachId, nodeId } = yield* linked(pen, home, host, 1);
      ocx.purgeIncomplete = true;
      host.control.reachAnswers.set(nodeId, "host_key_changed");
      yield* detach(PERSON, attachId, "d-1");
      yield* detachPass;
      expect((yield* listed(attachId))?.class).toBe("conflict");
      yield* detach(PERSON, attachId, "d-2", true);
      yield* detachPass;
      expect(ocx.sent).toEqual([attachId + ".purge.1", attachId + ".force.2"]);
      expect(ocx.resolved).toEqual([attachId + ".purge.1"]);
    }),
  ),
);

it.effect(
  "a stopped retirement force that had committed is read back once the machine answers: retired, with its audit row",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId, nodeId } = yield* linked(pen, home, host, 1);
        host.control.reachAnswers.set(nodeId, "unreachable");
        ocx.machineAnswers = false;
        // Every read of the force is lost until it stops after three sends; the next read finds it committed.
        ocx.loseRead = 7;
        yield* detachPass;
        // The force goes at the 49th failure and stops after its third send, a pass later.
        for (let check = 0; check < 51; check += 1) {
          yield* TestClock.adjust(HOUR / 2);
          yield* detachPass;
        }
        expect((yield* listed(attachId))?.message).toContain("stopped");
        host.control.reachAnswers.delete(nodeId);
        ocx.machineAnswers = true;
        yield* TestClock.adjust(HOUR / 2);
        yield* detachPass;
        yield* TestClock.adjust(HOUR / 2);
        yield* detachPass;
        expect((yield* listed(attachId))?.state).toBe("retired");
        expect((yield* audits(attachId, "retired")).length).toBe(1);
      }),
    ),
);

it.effect(
  "a machine that answers while its stopped retirement cannot be read back is handshaken once per 30 minutes",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { nodeId } = yield* linked(pen, home, host, 1);
        host.control.reachAnswers.set(nodeId, "unreachable");
        ocx.machineAnswers = false;
        ocx.tombstoneLimit = true;
        yield* detachPass;
        for (let check = 0; check < 48; check += 1) {
          yield* TestClock.adjust(HOUR / 2);
          yield* detachPass;
        }
        host.control.reachAnswers.delete(nodeId);
        ocx.machineAnswers = true;
        ocx.loseRead = 100;
        yield* TestClock.adjust(HOUR / 2);
        const before = host.control.reached.length;
        for (let pass = 0; pass < 5; pass += 1) yield* detachPass;
        expect(host.control.reached.length - before).toBe(1);
      }),
    ),
);

it.effect("a resolve still owed at the last recover is retried before the record ends", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      const ocx = fakeDetachHome(host);
      const { attachId } = yield* linked(pen, home, host, 1);
      ocx.machineAnswers = false;
      yield* detach(PERSON, attachId, "d-1");
      yield* detachPass;
      // The resolve fails: the Home's journal is unreadable for that one call.
      ocx.resolveFails = 2;
      yield* detach(PERSON, attachId, "d-2", true);
      yield* detachPass;
      ocx.machineAnswers = true;
      yield* TestClock.adjust(HOUR / 2);
      yield* detachPass;
      const owed = yield* listed(attachId);
      expect(owed?.state).not.toBe("purged");
      expect(owed?.message).toContain(
        "ocx link operations resolve --operation-id " + attachId + ".purge.1 --yes",
      );
      yield* TestClock.adjust(HOUR / 2);
      yield* detachPass;
      yield* detachPass;
      expect(ocx.resolved).toEqual([attachId + ".purge.1"]);
      expect((yield* listed(attachId))?.state).toBe("purged");
    }),
  ),
);
