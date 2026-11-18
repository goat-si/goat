import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { penNodeId } from "./attachModel.ts";
import * as Attach from "./DisposableAttach.ts";
import { attach, key, listed, reissue, world } from "./DisposableAttach.testkit.ts";
import { fakeDetachHome } from "./DisposableDetach.testkit.ts";
import { penRouteOf } from "./DisposableEnroll.testkit.ts";
import { enroll, withIdentity } from "./DisposableEnroll.joined.testkit.ts";
import {
  detach,
  detachPass,
  HOUR,
  linked,
  PERSON,
  THREAD,
} from "./DisposableDetach.flow.testkit.ts";

const stops = (attachId: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql<{ readonly outcome: string }>`SELECT outcome FROM audit_events
      WHERE target = ${attachId} AND outcome LIKE 'stopped:%'`,
  );

it.effect("a person's force resolves the purge it supersedes only once the force commits", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      const ocx = fakeDetachHome(host);
      const { attachId } = yield* linked(pen, home, host, 1);
      ocx.machineAnswers = false;
      yield* detach(PERSON, attachId, "d-1");
      yield* detachPass;
      ocx.tombstoneLimit = true;
      yield* detach(PERSON, attachId, "d-2", true);
      yield* detachPass;
      // The force stopped: the purge stays unknown, so its suspension keeps the tunnel off.
      expect(ocx.resolved).toEqual([]);
      ocx.tombstoneLimit = false;
      yield* detach(PERSON, attachId, "d-3", true);
      yield* detachPass;
      expect(ocx.resolved).toEqual([attachId + ".purge.1"]);
    }),
  ),
);

it.effect("a person's force while a resolve is still owed keeps the text that names it", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      const ocx = fakeDetachHome(host);
      const { attachId } = yield* linked(pen, home, host, 1);
      ocx.machineAnswers = false;
      yield* detach(PERSON, attachId, "d-1");
      yield* detachPass;
      ocx.resolveFails = 3;
      yield* detach(PERSON, attachId, "d-2", true);
      yield* detachPass;
      yield* TestClock.adjust(HOUR / 2);
      yield* detachPass;
      const resolveCommand =
        "ocx link operations resolve --operation-id " + attachId + ".purge.1 --yes";
      expect((yield* listed(attachId))?.message).toContain(resolveCommand);
      yield* detach(PERSON, attachId, "d-3", true);
      expect((yield* listed(attachId))?.message).toContain(resolveCommand);
    }),
  ),
);

it.effect("a reissue whose request id embeds a detach's does not answer that detach", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      fakeDetachHome(host);
      withIdentity(home);
      const started = yield* attach(1);
      yield* reissue(started.attachId, "detach\nd-1");
      pen.control.join(started.attachId + ".2", true);
      const nodeId = penNodeId(key(1)) ?? "";
      host.control.routes.set(
        nodeId,
        penRouteOf({ nodeId, noisePub: key(101) }, "ssh-ed25519 " + "1".repeat(68)),
      );
      yield* listed(started.attachId);
      for (let pass = 0; pass < 4; pass += 1) yield* enroll;
      const service = yield* Attach.DisposableAttach;
      const detaching = yield* service.detach(THREAD, "thread:thread-provisioner", {
        attachId: started.attachId,
        clientRequestId: "d-1",
      });
      expect(detaching.state).toBe("detaching");
    }),
  ),
);

it.effect(
  "a machine that answers while its purge stays unknown stops for a person, and a new purge waits until the entry is resolved",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId } = yield* linked(pen, home, host, 1);
        ocx.purgeIncomplete = true;
        yield* detach(THREAD, attachId, "d-1");
        yield* detachPass;
        const stopped = yield* listed(attachId);
        expect(stopped?.message).toContain("the machine answers");
        expect(stopped?.message).toContain(
          "ocx link operations resolve --operation-id " + attachId + ".purge.1 --yes",
        );
        expect(ocx.resolved).toEqual([]);
        // A plain detach again sends no new id while the entry is unresolved.
        yield* detach(THREAD, attachId, "d-2");
        yield* detachPass;
        expect(ocx.sent).toEqual([attachId + ".purge.1"]);
        const entry = ocx.revokes.get(attachId + ".purge.1");
        if (entry !== undefined) entry.resolvedAt = "2026-11-15T00:00:00.000Z";
        ocx.purgeIncomplete = false;
        yield* detach(THREAD, attachId, "d-3");
        yield* detachPass;
        expect(ocx.sent).toEqual([attachId + ".purge.1", attachId + ".purge.2"]);
        expect((yield* listed(attachId))?.state).toBe("purged");
      }),
    ),
);

it.effect("recover's link_retirement_pending sends the stored force id once more", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      const ocx = fakeDetachHome(host);
      const { attachId } = yield* linked(pen, home, host, 1);
      ocx.machineAnswers = false;
      yield* detach(PERSON, attachId, "d-1", true);
      yield* detachPass;
      ocx.machineAnswers = true;
      ocx.recoverRefusal = "link_retirement_pending";
      yield* TestClock.adjust(HOUR / 2);
      yield* detachPass;
      ocx.recoverRefusal = undefined;
      yield* detachPass;
      expect(ocx.sent).toEqual([attachId + ".force.1", attachId + ".force.1"]);
      yield* TestClock.adjust(HOUR / 2);
      yield* detachPass;
      expect((yield* listed(attachId))?.state).toBe("purged");
    }),
  ),
);

it.effect(
  "a retirement force that stopped waits for a person with its own text and is not retried every 30 minutes",
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
        const forces = ocx.sent.length;
        expect((yield* stops(attachId)).length).toBe(1);
        for (let check = 0; check < 4; check += 1) {
          yield* TestClock.adjust(HOUR / 2);
          yield* detachPass;
        }
        expect(ocx.sent).toHaveLength(forces);
        expect((yield* stops(attachId)).length).toBe(1);
        const machine = yield* listed(attachId);
        expect(machine?.message).toContain("removal of its link without it stopped");
        expect(machine?.nextAction).toContain("A person");
      }),
    ),
);

it.effect("a forced revoke of a link removed outside GOAT ends saying so", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      fakeDetachHome(host);
      const { attachId, linkId } = yield* linked(pen, home, host, 1);
      host.control.links.delete(linkId);
      yield* detach(PERSON, attachId, "d-1", true);
      yield* detachPass;
      yield* detachPass;
      const done = yield* listed(attachId);
      expect(done?.state).toBe("purged");
      expect(done?.message).toContain("removed outside GOAT");
    }),
  ),
);
