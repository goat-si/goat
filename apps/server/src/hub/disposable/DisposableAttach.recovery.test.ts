import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Settings from "../../serverSettings.ts";
import {
  attach,
  GRANT,
  INVITE_MS,
  input,
  key,
  listed,
  reason,
  reconcile,
  reissue,
  rows,
  switchTo,
  world,
} from "./DisposableAttach.testkit.ts";
import { withPersonConsent } from "./disposableSwitch.ts";

const attachIdOf = Effect.map(rows, (all) => String(all[0]?.attach_id));
const liveMints = (book: ReadonlyMap<string, { state: string }>) =>
  [...book.entries()].filter(([, entry]) => entry.state === "live").map(([mintId]) => mintId);

// A thread's modes or profile and a session change without the settings lock, so the check that
// guards the token must come after the commit: any change before it then withdraws the invite.
it.effect(
  "the last grant check runs after the commit, and a grant lost by then gets no token",
  () =>
    world((pen, _home, grant) =>
      Effect.gen(function* () {
        grant.gate = yield* Deferred.make<void>();
        grant.reached = yield* Deferred.make<void>();
        grant.gateOnCall = 2;
        const attaching = yield* attach(1).pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(grant.reached);
        expect(yield* rows).toMatchObject([{ state: "invited" }]);
        grant.value = { ...GRANT, goatclaw: { ...GRANT.goatclaw, hosts: ["pen-other"] } };
        yield* Deferred.succeed(grant.gate, undefined);
        const outcome = yield* Fiber.join(attaching);
        expect(outcome._tag === "Failure" && outcome.failure.reason).toBe("delegation_lost");
        expect(JSON.stringify(outcome)).not.toContain("pen1_TOKEN");
        expect(liveMints(pen.book)).toEqual([]);
      }),
    ),
);

// Cancelling a mintId Pen does not know leaves a fence and answers cancelled; for an invite GOAT
// knows was made, that answer would hide an admission Pen lost track of.
it.effect("a known invite Pen no longer has keeps its slot, under withdrawal and reissue", () =>
  world((pen) =>
    Effect.gen(function* () {
      const first = yield* attach(1);
      const second = yield* attach(2);
      pen.book.clear();
      const again = yield* reissue(second.attachId, "re-1");
      expect(again).not.toHaveProperty("invite");
      expect(again.state).not.toBe("failed");
      yield* switchTo({ enabled: false });
      yield* reconcile;
      expect(yield* listed(first.attachId)).toMatchObject({ state: "paused" });
      expect((yield* rows).every((row) => row.final_at === null)).toBe(true);
      expect(pen.control.tokensSeen).toHaveLength(2);
    }),
  ),
);

it.effect("a switch change while the last grant check is pending still withholds the token", () =>
  world((pen, _home, grant) =>
    Effect.gen(function* () {
      grant.gate = yield* Deferred.make<void>();
      grant.reached = yield* Deferred.make<void>();
      grant.gateOnCall = 2;
      const attaching = yield* attach(1).pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(grant.reached);
      yield* switchTo({ cap: 5 });
      yield* Deferred.succeed(grant.gate, undefined);
      const outcome = yield* Fiber.join(attaching);
      expect(outcome._tag === "Failure" && outcome.failure.reason).toBe("switch_off");
      expect(liveMints(pen.book)).toEqual([]);
    }),
  ),
);

// The mint's answer was lost, so GOAT learns the invite id from Pen's status, and from then on
// asks by it: a later loss of Pen's book must not read as a fence.
it.effect(
  "an invite id learned from status after a lost mint answer keeps the slot if Pen loses it",
  () =>
    world((pen) =>
      Effect.gen(function* () {
        pen.control.loseMint = true;
        pen.control.loseCancel = true;
        expect(yield* reason(attach(1))).toBe("unknown_outcome");
        expect(yield* reason(attach(2))).toBe("unknown_outcome");
        pen.control.loseMint = false;
        pen.control.loseCancel = false;
        yield* reconcile;
        pen.book.clear();
        const [, second] = yield* rows;
        const again = yield* reissue(String(second?.attach_id), "re-1");
        expect(again).not.toHaveProperty("invite");
        yield* switchTo({ enabled: false });
        yield* reconcile;
        expect((yield* rows).every((row) => row.final_at === null)).toBe(true);
        expect(pen.control.tokensSeen).toEqual([]);
      }),
    ),
);

it.effect("a reissue of an expired invite mints nothing, and the record frees its slot", () =>
  world((pen) =>
    Effect.gen(function* () {
      const first = yield* attach(1);
      yield* TestClock.adjust(INVITE_MS + 1);
      const settled = yield* reissue(first.attachId, "re-1");
      expect(settled).not.toHaveProperty("invite");
      expect(liveMints(pen.book)).toEqual([]);
      expect(settled.state).toBe("failed");
    }),
  ),
);

it.effect("a settlement that read the record before a reissue never drops the new mint", () =>
  world((pen) =>
    Effect.gen(function* () {
      const first = yield* attach(1);
      pen.control.statusGate = yield* Deferred.make<void>();
      pen.control.statusStarted = yield* Deferred.make<void>();
      const settling = yield* reconcile.pipe(Effect.forkChild);
      yield* Deferred.await(pen.control.statusStarted);
      const reissuing = yield* reissue(first.attachId, "re-1").pipe(Effect.forkChild);
      yield* Deferred.succeed(pen.control.statusGate, undefined);
      yield* Fiber.join(settling);
      const again = yield* Fiber.join(reissuing);
      expect(again.invite?.token).toBe("pen1_TOKEN_" + first.attachId + ".2");
      expect(liveMints(pen.book)).toEqual([first.attachId + ".2"]);
      expect(yield* listed(first.attachId)).toMatchObject({
        state: "invited",
        steps: [
          { step: "invite", outcome: "cancelled" },
          { step: "invite", outcome: "ok" },
        ],
      });
    }),
  ),
);

it.effect(
  "lost authority withdraws an open invite, and one burned before the cancel shows joined after",
  () =>
    world((pen, _home, grant) =>
      Effect.gen(function* () {
        const open = yield* attach(1);
        const joined = yield* attach(2);
        pen.control.join(joined.attachId + ".1", true);
        grant.value = { ...GRANT, goatclaw: { ...GRANT.goatclaw, capabilities: [] } };
        yield* reconcile;
        expect(liveMints(pen.book)).toEqual([]);
        expect(yield* listed(open.attachId)).toMatchObject({ state: "failed", penMember: false });
        expect(yield* listed(joined.attachId)).toMatchObject({ state: "paused", penMember: true });
      }),
    ),
);

it.effect("a key removed from Pen after admission frees its slot", () =>
  world((pen) =>
    Effect.gen(function* () {
      yield* switchTo({ cap: 1 });
      const first = yield* attach(1);
      pen.control.join(first.attachId + ".1", true);
      yield* reconcile;
      expect(yield* listed(first.attachId)).toMatchObject({ state: "admitted", penMember: true });
      expect(yield* reason(attach(2))).toBe("cap_reached");
      pen.members.delete(key(1));
      yield* reconcile;
      expect(yield* listed(first.attachId)).toMatchObject({ state: "failed", penMember: false });
      expect((yield* attach(2)).state).toBe("invited");
    }),
  ),
);

it.effect("Pen forgets each terminal entry once GOAT has stored it", () =>
  world((pen) =>
    Effect.gen(function* () {
      const first = yield* attach(1);
      yield* reissue(first.attachId, "re-1");
      const joined = yield* attach(2);
      pen.control.join(joined.attachId + ".1", true);
      yield* reconcile;
      expect(pen.control.acked.sort()).toEqual(
        [first.attachId + ".1", joined.attachId + ".1"].sort(),
      );
      expect([...pen.book.keys()]).toEqual([first.attachId + ".2"]);
    }),
  ),
);

it.effect(
  "an attach stopped after Pen minted, before it committed, holds its slot only until Pen settles",
  () =>
    world((pen, _home, grant) =>
      Effect.gen(function* () {
        yield* switchTo({ cap: 1 });
        grant.gate = yield* Deferred.make<void>();
        grant.reached = yield* Deferred.make<void>();
        grant.gateOnCall = 2;
        const stopped = yield* attach(1).pipe(Effect.forkChild);
        yield* Deferred.await(grant.reached);
        yield* Fiber.interrupt(stopped);
        grant.gate = undefined;
        yield* reconcile;
        expect(yield* reason(attach(2))).toBe("cap_reached");
        yield* TestClock.adjust(INVITE_MS + 1);
        yield* reconcile;
        expect((yield* attach(2)).state).toBe("invited");
      }),
    ),
);

it.effect("a withdrawal fences a mint Pen has not seen, so its late arrival makes nothing", () =>
  world((pen) =>
    Effect.gen(function* () {
      pen.control.mintGate = yield* Deferred.make<void>();
      pen.control.mintStarted = yield* Deferred.make<void>();
      const stopped = yield* attach(1).pipe(Effect.forkChild);
      yield* Deferred.await(pen.control.mintStarted);
      yield* Fiber.interrupt(stopped);
      pen.control.mintGate = undefined;
      const attachId = yield* attachIdOf;
      yield* switchTo({ enabled: false });
      yield* reconcile;
      expect(yield* listed(attachId)).toMatchObject({ state: "failed" });
      const late = yield* pen.service
        .mint({
          subject: { signPub: key(1), noisePub: key(101), name: "cc-1" },
          mintId: attachId + ".1",
          expiresAtMs: INVITE_MS,
        })
        .pipe(Effect.flip);
      expect(late._tag).toBe("PenInviteUnknown");
      expect(liveMints(pen.book)).toEqual([]);
      // The fence is acknowledged only once the mint's own expiry refuses a late create.
      expect(pen.control.acked).toEqual([]);
      yield* TestClock.adjust(INVITE_MS + 1);
      yield* reconcile;
      expect(pen.control.acked).toEqual([attachId + ".1"]);
    }),
  ),
);

it.effect("concurrent reissues of one invite run one after the other, each with its own mint", () =>
  world((pen) =>
    Effect.gen(function* () {
      const first = yield* attach(1);
      pen.control.mintGate = yield* Deferred.make<void>();
      pen.control.mintStarted = yield* Deferred.make<void>();
      const one = yield* reissue(first.attachId, "a").pipe(Effect.forkChild);
      const two = yield* reissue(first.attachId, "b").pipe(Effect.forkChild);
      yield* Deferred.await(pen.control.mintStarted);
      yield* Deferred.succeed(pen.control.mintGate, undefined);
      const a = yield* Fiber.join(one);
      const b = yield* Fiber.join(two);
      expect(new Set([a.invite?.token, b.invite?.token])).toEqual(
        new Set(["pen1_TOKEN_" + first.attachId + ".2", "pen1_TOKEN_" + first.attachId + ".3"]),
      );
      expect(liveMints(pen.book)).toEqual([first.attachId + ".3"]);
    }),
  ),
);

it.effect("a reissue that finds the invite burned mints nothing, and its key replays that", () =>
  world((pen) =>
    Effect.gen(function* () {
      const first = yield* attach(1);
      pen.control.join(first.attachId + ".1", true);
      const settled = yield* reissue(first.attachId, "re-1");
      expect(settled).toMatchObject({ state: "admitted", penMember: true });
      expect(settled).not.toHaveProperty("invite");
      expect(yield* reissue(first.attachId, "re-1")).toMatchObject({ state: "admitted" });
      expect(pen.control.tokensSeen).toHaveLength(1);
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT outcome FROM disposable_machine_requests`).toEqual([
        { outcome: "settled" },
      ]);
      expect(yield* reason(reissue(first.attachId, "re-2"))).toBe("conflict");
      expect(input(1).signPub).toBe(key(1));
    }),
  ),
);

it.effect("a settings read that fails withdraws nothing; the invite stays live", () =>
  world((pen, home) =>
    Effect.gen(function* () {
      const first = yield* attach(1);
      home.settingsUnreadable = true;
      yield* reconcile;
      home.settingsUnreadable = false;
      expect(pen.book.get(first.attachId + ".1")?.state).toBe("live");
      expect((yield* listed(first.attachId))?.state).toBe("invited");
    }),
  ),
);

it.effect(
  "a mint GOAT cannot record is cancelled by its invite id and answers unknown_outcome",
  () =>
    world((pen) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TRIGGER refuse_invited BEFORE UPDATE OF state ON disposable_machines
        WHEN NEW.state = 'invited' BEGIN SELECT RAISE(ABORT, 'disk full'); END`;
        expect(yield* reason(attach(1))).toBe("unknown_outcome");
        expect(pen.control.tokensSeen).toHaveLength(1);
        expect(liveMints(pen.book)).toEqual([]);
      }),
    ),
);

it.effect("a settlement whose fence moved stores nothing and acks nothing", () =>
  world((pen) =>
    Effect.gen(function* () {
      yield* attach(1);
      yield* TestClock.adjust(INVITE_MS + 1);
      pen.control.statusGate = yield* Deferred.make<void>();
      pen.control.statusStarted = yield* Deferred.make<void>();
      const settling = yield* reconcile.pipe(Effect.forkChild);
      yield* Deferred.await(pen.control.statusStarted);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE disposable_machines SET fence = fence + 1`;
      yield* Deferred.succeed(pen.control.statusGate, undefined);
      yield* Fiber.join(settling);
      expect(pen.control.acked).toEqual([]);
      expect((yield* rows)[0]?.state).toBe("invited");
    }),
  ),
);

// The grant is resolved from the goatclaw policy outside the settings lock; under it, that policy
// must still be the one the grant came from, for the first mint as for a reissue.
it.effect("a goatclaw policy change while the grant resolves refuses the first mint", () =>
  world((pen, _home, grant) =>
    Effect.gen(function* () {
      grant.gate = yield* Deferred.make<void>();
      grant.reached = yield* Deferred.make<void>();
      grant.gateOnCall = 1;
      const attaching = yield* attach(1).pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(grant.reached);
      const settings = yield* Settings.ServerSettingsService;
      yield* withPersonConsent(settings.updateSettings({ goatclaw: { enabled: true } }));
      yield* Deferred.succeed(grant.gate, undefined);
      const outcome = yield* Fiber.join(attaching);
      expect(outcome._tag === "Failure" && outcome.failure.reason).toBe("delegation_lost");
      expect(pen.book.size).toBe(0);
      expect(yield* rows).toEqual([]);
    }),
  ),
);

it.effect("one pass reads Pen's member list once, however many machines it admitted", () =>
  world((pen) =>
    Effect.gen(function* () {
      const first = yield* attach(1);
      const second = yield* attach(2);
      pen.control.join(first.attachId + ".1", true);
      pen.control.join(second.attachId + ".1", true);
      yield* reconcile;
      pen.control.membersAsked = 0;
      yield* reconcile;
      expect(pen.control.membersAsked).toBe(1);
    }),
  ),
);

// A pass reads Pen's member list once; a machine that joined after that read is missing from it.
it.effect(
  "a key missing only from the pass's member view is read again before it counts as removed",
  () =>
    world((pen) =>
      Effect.gen(function* () {
        const first = yield* attach(1);
        const second = yield* attach(2);
        pen.control.join(first.attachId + ".1", true);
        pen.control.join(second.attachId + ".1", true);
        yield* reconcile;
        pen.control.staleMembersOnce = new Set([key(1)]);
        yield* reconcile;
        expect(yield* listed(second.attachId)).toMatchObject({
          state: "admitted",
          penMember: true,
        });
      }),
    ),
);

it.effect("a withdrawal Pen has not confirmed reads as pending, never as a join", () =>
  world((pen) =>
    Effect.gen(function* () {
      const first = yield* attach(1);
      pen.control.loseCancel = true;
      yield* switchTo({ enabled: false });
      yield* reconcile;
      const machine = yield* listed(first.attachId);
      expect(machine?.state).toBe("paused");
      expect(machine?.message).not.toContain("joined");
    }),
  ),
);

// Every settings writer waits while a reservation holds the settings lock, so the transaction is
// bounded: one that cannot start or finish within 15 s gives the lock back.
it.effect("a reservation whose transaction stalls gives up the settings lock at 15 s", () =>
  world((pen, _home, grant) =>
    Effect.gen(function* () {
      grant.gate = yield* Deferred.make<void>();
      grant.reached = yield* Deferred.make<void>();
      grant.gateOnCall = 1;
      const attaching = yield* attach(1).pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(grant.reached);
      const sql = yield* SqlClient.SqlClient;
      const holding = yield* Deferred.make<void>();
      const held = yield* Deferred.make<void>();
      const holder = yield* sql
        .withTransaction(
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(holding))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);
      yield* Deferred.succeed(grant.gate, undefined);
      yield* TestClock.adjust(15_000);
      expect((yield* Fiber.join(attaching)).reason).toBe("storage_failed");
      expect(pen.book.size).toBe(0);
      yield* Deferred.succeed(holding, undefined);
      yield* Fiber.join(holder);
      // The settings lock was given back.
      yield* switchTo({ cap: 3 });
    }),
  ),
);
