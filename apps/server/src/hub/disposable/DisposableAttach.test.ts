import { expect, it } from "@effect/vitest";
import { HubMachineStatus } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { penNodeId } from "./attachModel.ts";
import * as Attach from "./DisposableAttach.ts";
import {
  attach,
  GRANT,
  INVITE_MS,
  key,
  listed,
  reason,
  reconcile,
  reissue,
  rows,
  switchTo,
  world,
} from "./DisposableAttach.testkit.ts";
import { PEN_ATTACH_FEATURES } from "./PenInvites.ts";

const encodeStatus = Schema.encodeUnknownExit(HubMachineStatus);

// pen-protocol vectors/identity.json: this signPub's node id is gr2q7gf5lh6pzfdnurnkvputhm.
const VECTOR_SIGN = Buffer.from(
  "8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c",
  "hex",
).toString("base64url");

it("derives Pen's node id from the signing key", () => {
  expect(penNodeId(VECTOR_SIGN)).toBe("gr2q7gf5lh6pzfdnurnkvputhm");
  expect(penNodeId(key(1).slice(0, 40))).toBeUndefined();
});

it.effect(
  "attach is refused, with nothing reserved, until Pen and OpenCodex declare what it uses",
  () =>
    world((pen, home) =>
      Effect.gen(function* () {
        pen.control.features = new Set(["invite.subject/1"]);
        expect(yield* reason(attach(1))).toBe("pen_unsupported");
        pen.control.features = new Set(PEN_ATTACH_FEATURES);
        home.contracts = new Set(["link.route/1"]);
        expect(yield* reason(attach(1))).toBe("opencodex_unsupported");
        expect(yield* rows).toEqual([]);
        expect(pen.book.size).toBe(0);
      }),
    ),
);

it.effect(
  "the first answer carries the token; a repeat answers without it and no record holds it",
  () =>
    world((pen) =>
      Effect.gen(function* () {
        const first = yield* attach(1);
        expect(first).toMatchObject({
          state: "invited",
          step: "invite",
          class: "disposable",
          penMember: false,
        });
        expect(first.invite?.token).toBe(pen.control.tokensSeen[0]);
        const repeat = yield* attach(1);
        expect(repeat.attachId).toBe(first.attachId);
        expect(repeat).not.toHaveProperty("invite");
        expect(JSON.stringify(yield* rows)).not.toContain("pen1_TOKEN");
        expect(yield* reason(attach(1, { name: "cc-other" }))).toBe("invalid_request");
      }),
    ),
);

it.effect(
  "a name outside the rule, a key already in Pen, or keys another attach holds are refused",
  () =>
    world((pen) =>
      Effect.gen(function* () {
        expect(yield* reason(attach(1, { name: "1cc" }))).toBe("name_rule");
        pen.members.add(key(2));
        expect(yield* reason(attach(2))).toBe("key_in_use");
        yield* attach(3);
        expect(yield* reason(attach(4, { signPub: key(3) }))).toBe("key_in_use");
      }),
    ),
);

it.effect("with the switch off or the thread unnamed, attach asks neither Pen nor OpenCodex", () =>
  world((pen) =>
    Effect.gen(function* () {
      yield* switchTo({ provisioners: [] });
      expect(yield* reason(attach(1))).toBe("provisioner_refused");
      yield* switchTo({ enabled: false });
      expect(yield* reason(attach(2))).toBe("switch_off");
      expect(pen.control.featuresAsked).toBe(0);
    }),
  ),
);

it.effect("a record that holds more than 32 invites still lists within the wire's 32 steps", () =>
  world(() =>
    Effect.gen(function* () {
      const first = yield* attach(1);
      const sql = yield* SqlClient.SqlClient;
      const many = Array.from({ length: 40 }, (_, n) => ({
        id: first.attachId + "." + (n + 1),
        kind: "mint",
        state: "done",
        expiresAtMs: INVITE_MS,
        settled: "cancelled",
        acked: true,
      }));
      yield* sql`UPDATE disposable_machines SET effects_json = ${JSON.stringify(many)}`;
      const machine = yield* listed(first.attachId);
      expect(machine?.steps).toHaveLength(32);
      expect(encodeStatus(machine)._tag).toBe("Success");
    }),
  ),
);

it.effect(
  "reissue answers a missing attach or a closed switch before it asks Pen or OpenCodex",
  () =>
    world((pen) =>
      Effect.gen(function* () {
        const first = yield* attach(1);
        pen.control.features = new Set();
        pen.control.featuresAsked = 0;
        expect(yield* reason(reissue("no-such-attach", "re-1"))).toBe("not_found");
        yield* switchTo({ enabled: false });
        expect(yield* reason(reissue(first.attachId, "re-2"))).toBe("switch_off");
        expect(pen.control.featuresAsked).toBe(0);
      }),
    ),
);

it.effect("a consent change that leaves the switch on refuses a reissue before it asks Pen", () =>
  world((pen) =>
    Effect.gen(function* () {
      const first = yield* attach(1);
      yield* switchTo({ cap: 5 });
      pen.control.featuresAsked = 0;
      expect(yield* reason(reissue(first.attachId, "re-1"))).toBe("switch_off");
      expect(pen.control.featuresAsked).toBe(0);
    }),
  ),
);

it.effect("a name Pen would refuse is refused before anything is reserved or minted", () =>
  world((pen) =>
    Effect.gen(function* () {
      yield* switchTo({ nameRule: "^[a-z0-9-]{1,60}$" });
      expect(yield* reason(attach(1, { name: "c".repeat(33) }))).toBe("invalid_request");
      expect(yield* rows).toEqual([]);
      expect(pen.book.size).toBe(0);
    }),
  ),
);

it.effect("with a cap of one, two concurrent attaches admit exactly one", () =>
  world(() =>
    Effect.gen(function* () {
      yield* switchTo({ cap: 1 });
      const outcomes = yield* Effect.all(
        [attach(1).pipe(Effect.result), attach(2).pipe(Effect.result)],
        { concurrency: 2 },
      );
      expect(outcomes.filter((outcome) => outcome._tag === "Success")).toHaveLength(1);
      expect(
        outcomes.flatMap((outcome) => (outcome._tag === "Failure" ? [outcome.failure.reason] : [])),
      ).toEqual(["cap_reached"]);
    }),
  ),
);

it.effect(
  "a switch-off cancels the open invite, and an invite burned first shows as joined after",
  () =>
    world((pen) =>
      Effect.gen(function* () {
        const open = yield* attach(1);
        const joined = yield* attach(2);
        pen.control.join(joined.attachId + ".1", true);
        yield* switchTo({ enabled: false });
        yield* reconcile;
        // Cancelled, stored, then forgotten by Pen.
        expect(pen.control.acked).toContain(open.attachId + ".1");
        expect(yield* listed(open.attachId)).toMatchObject({
          state: "failed",
          class: "kept",
          penMember: false,
        });
        expect(yield* listed(joined.attachId)).toMatchObject({ state: "paused", penMember: true });
      }),
    ),
);

it.effect(
  "a switch-off while the invite is being made lets the mint finish, then cancels it unseen",
  () =>
    world((pen) =>
      Effect.gen(function* () {
        pen.control.mintGate = yield* Deferred.make<void>();
        pen.control.mintStarted = yield* Deferred.make<void>();
        const pending = yield* attach(1).pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(pen.control.mintStarted);
        yield* switchTo({ enabled: false });
        yield* Deferred.succeed(pen.control.mintGate, undefined);
        const outcome = yield* Fiber.join(pending);
        expect(outcome._tag === "Failure" && outcome.failure.reason).toBe("switch_off");
        const [entry] = pen.book.values();
        expect(entry?.state).toBe("cancelled");
        expect(pen.control.tokensSeen).toHaveLength(1);
        expect(JSON.stringify(outcome)).not.toContain("pen1_TOKEN");
        expect(yield* rows).toMatchObject([{ state: "failed", invite_id: entry?.inviteId }]);
      }),
    ),
);

// The token never left GOAT, so cancelling by mintId at once makes the outcome certain.
it.effect("a lost mint answer is cancelled by its mintId at once, freeing the slot", () =>
  world((pen) =>
    Effect.gen(function* () {
      yield* switchTo({ cap: 1 });
      pen.control.loseMint = true;
      const lost = yield* attach(1);
      pen.control.loseMint = false;
      expect(lost).toMatchObject({ state: "failed" });
      expect(lost).not.toHaveProperty("invite");
      expect([...pen.book.values()].map((entry) => entry.state)).toEqual(["cancelled"]);
      expect((yield* attach(2)).state).toBe("invited");
    }),
  ),
);

it.effect("a lost mint answer whose cancel is lost too holds the slot until Pen settles it", () =>
  world((pen) =>
    Effect.gen(function* () {
      yield* switchTo({ cap: 1 });
      pen.control.loseMint = true;
      pen.control.loseCancel = true;
      expect(yield* reason(attach(1))).toBe("unknown_outcome");
      pen.control.loseMint = false;
      pen.control.loseCancel = false;
      expect(yield* reason(attach(2))).toBe("cap_reached");
      // Pen made the invite; it expires without a join, so the slot is freed.
      yield* TestClock.adjust(INVITE_MS + 1);
      yield* reconcile;
      expect((yield* attach(2)).state).toBe("invited");
    }),
  ),
);

it.effect("a mint Pen never saw is final only after its absolute expiry", () =>
  world((pen) =>
    Effect.gen(function* () {
      pen.control.loseMint = true;
      pen.control.loseCancel = true;
      yield* reason(attach(1));
      pen.control.loseCancel = false;
      pen.book.clear();
      yield* reconcile;
      expect(yield* rows).toMatchObject([{ state: "unknown" }]);
      yield* TestClock.adjust(INVITE_MS + 1);
      yield* reconcile;
      expect(yield* rows).toMatchObject([{ state: "failed" }]);
    }),
  ),
);

it.effect("burned without a saved admit holds the slot as unknown", () =>
  world((pen) =>
    Effect.gen(function* () {
      const first = yield* attach(1);
      pen.control.join(first.attachId + ".1", false);
      yield* reconcile;
      expect(yield* listed(first.attachId)).toMatchObject({ state: "unknown", penMember: false });
      expect(pen.control.acked).toEqual([]);
    }),
  ),
);

// Pen holds the admit in memory until it saves its record set; a restart then could lose it.
it.effect("a burn whose admit Pen has not saved holds the slot until Pen saves it", () =>
  world((pen) =>
    Effect.gen(function* () {
      const first = yield* attach(1);
      pen.control.join(first.attachId + ".1", true);
      pen.control.unsaved.add(first.attachId + ".1");
      yield* reconcile;
      expect(yield* listed(first.attachId)).toMatchObject({ state: "unknown", penMember: false });
      expect(pen.control.acked).toEqual([]);
      pen.control.unsaved.clear();
      yield* reconcile;
      expect(yield* listed(first.attachId)).toMatchObject({ state: "admitted", penMember: true });
      expect(pen.control.acked).toEqual([first.attachId + ".1"]);
    }),
  ),
);

it.effect("a reissue cancels the open invite and mints a new token for the same keys", () =>
  world((pen) =>
    Effect.gen(function* () {
      const first = yield* attach(1);
      const again = yield* reissue(first.attachId, "re-1");
      expect(pen.book.get(first.attachId + ".1")?.state).toBe("cancelled");
      expect(again.invite?.token).toBe("pen1_TOKEN_" + first.attachId + ".2");
      const replay = yield* reissue(first.attachId, "re-1");
      expect(replay).not.toHaveProperty("invite");
      expect(pen.control.tokensSeen).toHaveLength(2);
    }),
  ),
);

it.effect("reissues stop at the wire's 32 steps, leaving the live invite and the list intact", () =>
  world((pen) =>
    Effect.gen(function* () {
      const first = yield* attach(1);
      for (let n = 1; n <= 31; n++) yield* reissue(first.attachId, "re-" + n);
      expect(yield* reason(reissue(first.attachId, "re-32"))).toBe("conflict");
      expect(pen.book.get(first.attachId + ".32")?.state).toBe("live");
      const machine = yield* listed(first.attachId);
      expect(encodeStatus(machine)._tag).toBe("Success");
    }),
  ),
);

it.effect(
  "a provisioner removed from the switch, or one whose grant narrowed, cannot mint again",
  () =>
    world((pen, _home, grant) =>
      Effect.gen(function* () {
        const first = yield* attach(1);
        grant.value = { ...GRANT, goatclaw: { ...GRANT.goatclaw, hosts: ["pen-other"] } };
        expect(yield* reason(reissue(first.attachId, "re-1"))).toBe("delegation_lost");
        grant.value = GRANT;
        yield* switchTo({ provisioners: [] });
        expect(yield* reason(attach(2))).toBe("provisioner_refused");
        expect(pen.book.size).toBe(1);
      }),
    ),
);

it.effect("only the provisioner or a person reissues another thread's invite", () =>
  world(() =>
    Effect.gen(function* () {
      const first = yield* attach(1);
      const service = yield* Attach.DisposableAttach;
      expect(
        yield* reason(
          service.reissue({ provisioner: { kind: "thread", threadId: "other" } }, "thread:other", {
            attachId: first.attachId,
            clientRequestId: "x",
          }),
        ),
      ).toBe("provisioner_refused");
    }),
  ),
);
