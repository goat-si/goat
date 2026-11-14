import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { attach, key, listed, reconcile, rows, world } from "./DisposableAttach.testkit.ts";
import { fakeDetachHome } from "./DisposableDetach.testkit.ts";
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
  "a final record whose key left Pen is pruned with its request keys 30 days after it ended; one still in Pen stays",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        fakeDetachHome(host);
        const gone = yield* linked(pen, home, host, 1);
        const kept = yield* linked(pen, home, host, 2);
        yield* detach(THREAD, gone.attachId, "d-1");
        yield* detach(THREAD, kept.attachId, "d-2");
        yield* detachPass;
        pen.members.delete(key(1));
        yield* reconcile;
        expect(yield* listed(gone.attachId)).toMatchObject({ state: "purged", penMember: false });
        const requests = Effect.flatMap(
          SqlClient.SqlClient,
          (sql) =>
            sql<{ readonly attach_id: string }>`SELECT attach_id FROM disposable_machine_requests`,
        );
        yield* TestClock.adjust(29 * 24 * HOUR);
        yield* detachPass;
        expect(yield* listed(gone.attachId)).toBeDefined();
        yield* TestClock.adjust(2 * 24 * HOUR);
        yield* detachPass;
        expect(yield* listed(gone.attachId)).toBeUndefined();
        expect((yield* requests).map((row) => row.attach_id)).not.toContain(gone.attachId);
        expect((yield* listed(kept.attachId))?.state).toBe("purged");
      }),
    ),
);

it.effect("a released record is kept past 30 days while Pen's list cannot show its key gone", () =>
  world((pen, _home, _grant, _host) =>
    Effect.gen(function* () {
      const first = yield* attach(1);
      pen.control.join(first.attachId + ".1", false);
      yield* reconcile;
      yield* TestClock.adjust(11 * 60 * 1000);
      yield* release(PERSON, first.attachId, "r-1");
      // The machine joins after all, and the record ages past the retention.
      pen.members.add(key(1));
      yield* TestClock.adjust(31 * 24 * HOUR);
      yield* detachPass;
      expect(yield* listed(first.attachId)).toBeDefined();
      pen.members.delete(key(1));
      yield* detachPass;
      expect(yield* listed(first.attachId)).toBeUndefined();
    }),
  ),
);

it.effect(
  "a person forces past a changed host key, then removes the machine from Pen: the record keeps its detach, names its cleanup, and is pruned once settled",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId, nodeId, linkId } = yield* linked(pen, home, host, 1);
        host.control.reachAnswers.set(nodeId, "host_key_changed");
        ocx.recoverRefusal = "host_key_changed";
        yield* detachPass;
        yield* detach(PERSON, attachId, "d-1", true);
        yield* detachPass;
        expect(ocx.tombstones.has(linkId)).toBe(true);
        pen.members.delete(key(1));
        yield* reconcile;
        const left = yield* listed(attachId);
        expect(left?.state).toBe("detaching");
        expect(left?.message).toContain("ocx link recover --forget --link-id " + linkId);
        expect(left?.message).not.toContain("ocx link revoke");
        ocx.forget(linkId);
        yield* TestClock.adjust(HOUR / 2);
        yield* detachPass;
        expect(yield* listed(attachId)).toMatchObject({ state: "purged", penMember: false });
        yield* TestClock.adjust(31 * 24 * HOUR);
        yield* detachPass;
        expect(yield* listed(attachId)).toBeUndefined();
      }),
    ),
);

it.effect(
  "the 30 days count from leaving Pen: a purged record that left Pen later stays 30 days after that",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        fakeDetachHome(host);
        const { attachId } = yield* linked(pen, home, host, 1);
        yield* detach(THREAD, attachId, "d-1");
        yield* detachPass;
        expect(yield* listed(attachId)).toMatchObject({ state: "purged", penMember: true });
        yield* TestClock.adjust(10 * 24 * HOUR);
        pen.members.delete(key(1));
        yield* reconcile;
        // 35 days after it ended, 25 after it left Pen.
        yield* TestClock.adjust(25 * 24 * HOUR);
        yield* detachPass;
        expect(yield* listed(attachId)).toBeDefined();
        yield* TestClock.adjust(6 * 24 * HOUR);
        yield* detachPass;
        expect(yield* listed(attachId)).toBeUndefined();
      }),
    ),
);

it.effect("a record that comes to owe Pen an ack while the prune reads Pen's list is kept", () =>
  world((pen, _home, _grant, _host) =>
    Effect.gen(function* () {
      const first = yield* attach(1);
      pen.control.join(first.attachId + ".1", false);
      yield* reconcile;
      yield* TestClock.adjust(11 * 60 * 1000);
      yield* release(PERSON, first.attachId, "r-1");
      yield* TestClock.adjust(31 * 24 * HOUR);
      pen.control.membersStarted = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      pen.control.membersGate = gate;
      const pruning = yield* Effect.forkChild(detachPass);
      yield* Deferred.await(pen.control.membersStarted);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE disposable_machines
        SET effects_json = json_remove(json_set(effects_json, '$[0].settled', 'expired'), '$[0].acked')
        WHERE attach_id = ${first.attachId}`;
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(pruning);
      expect((yield* rows).map((row) => row.attach_id)).toContain(first.attachId);
    }),
  ),
);
