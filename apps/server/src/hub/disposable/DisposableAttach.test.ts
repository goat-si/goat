import { expect, it } from "@effect/vitest";
import type { HubMachineAttachInput } from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { runMigrations } from "../../persistence/Migrations.ts";
import * as Settings from "../../serverSettings.ts";
import { penNodeId } from "./attachModel.ts";
import * as Attach from "./DisposableAttach.ts";
import * as Store from "./DisposableMachineStore.ts";
import { HOME_ATTACH_CONTRACTS, HomeContracts } from "./features.ts";
import {
  PEN_ATTACH_FEATURES,
  type PenInviteRef,
  type PenInviteState,
  PenInviteUnknown,
  PenInvites,
} from "./PenInvites.ts";

// pen-protocol vectors/identity.json: this signPub's node id is gr2q7gf5lh6pzfdnurnkvputhm.
const VECTOR_SIGN = Buffer.from(
  "8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c",
  "hex",
).toString("base64url");
const key = (byte: number) => Buffer.alloc(32, byte).toString("base64url");
const input = (
  n: number,
  overrides: Partial<HubMachineAttachInput> = {},
): HubMachineAttachInput => ({
  name: "cc-" + n,
  signPub: key(n),
  noisePub: key(100 + n),
  clientRequestId: "req-" + n,
  ...overrides,
});
const THREAD = "thread-provisioner";
const caller: Attach.AttachCaller = {
  provisioner: { kind: "thread", threadId: THREAD },
  delegation: { runtimeMode: "full-access" },
};

/** A Pen that keeps bound invites as CONTRACT "Bound invites (v1.3)" describes. */
const fakePen = () => {
  const invites = new Map<string, { inviteId: string; state: PenInviteState; token: string }>();
  const fences = new Set<string>();
  const members = new Set<string>();
  const control = {
    features: new Set<string>(PEN_ATTACH_FEATURES),
    mintGate: undefined as Deferred.Deferred<void> | undefined,
    mintStarted: undefined as Deferred.Deferred<void> | undefined,
    loseMint: false,
    tokensSeen: [] as Array<string>,
    /** A join that used the invite; saved says whether the admit reached Pen's record set. */
    join: (mintId: string, saved: boolean) => {
      const entry = invites.get(mintId);
      if (entry === undefined) throw new Error("no invite " + mintId);
      entry.state = saved
        ? { state: "burned", nonce: "n-" + mintId, admit: "h-" + mintId, member: true }
        : { state: "burned", nonce: "n-" + mintId };
    },
  };
  const find = (ref: PenInviteRef) =>
    "mintId" in ref
      ? invites.get(ref.mintId)
      : [...invites.values()].find((entry) => entry.inviteId === ref.inviteId);
  const service = PenInvites.of({
    features: Effect.sync(() => control.features),
    isMember: (signPub) => Effect.succeed(members.has(signPub)),
    mint: ({ mintId, expiresAtMs }) =>
      Effect.gen(function* () {
        if (control.mintStarted) yield* Deferred.succeed(control.mintStarted, undefined);
        if (control.mintGate) yield* Deferred.await(control.mintGate);
        if (fences.has(mintId) || invites.has(mintId))
          return yield* new PenInviteUnknown({ reason: "refused" });
        const entry = {
          inviteId: "inv-" + mintId,
          state: { state: "live", expiresAtMs } as PenInviteState,
          token: "pen1_TOKEN_" + mintId,
        };
        invites.set(mintId, entry);
        if (control.loseMint) return yield* new PenInviteUnknown({ reason: "answer lost" });
        control.tokensSeen.push(entry.token);
        return { inviteId: entry.inviteId, token: entry.token, expiresAtMs };
      }),
    cancel: (ref) =>
      Effect.sync(() => {
        const entry = find(ref);
        if (entry === undefined) {
          if ("mintId" in ref) fences.add(ref.mintId);
          return "mintId" in ref ? "cancelled" : "absent";
        }
        if (entry.state.state === "live") entry.state = { state: "cancelled" };
        return entry.state.state === "burned"
          ? "burned"
          : entry.state.state === "expired"
            ? "expired"
            : "cancelled";
      }),
    status: (ref) => Effect.sync(() => find(ref)?.state ?? { state: "absent" }),
    ack: () => Effect.succeed("acked"),
  });
  return { service, control, invites, members };
};

const world = <A, E>(
  body: (
    pen: ReturnType<typeof fakePen>,
    home: { contracts: Set<string> },
    alive: { value: boolean },
  ) => Effect.Effect<
    A,
    E,
    Attach.DisposableAttach | Settings.ServerSettingsService | SqlClient.SqlClient
  >,
) => {
  const pen = fakePen();
  const home = { contracts: new Set<string>(HOME_ATTACH_CONTRACTS) };
  const alive = { value: true };
  return Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 146 });
    const settings = yield* Settings.ServerSettingsService;
    yield* settings.updateSettings({
      hub: {
        enabled: true,
        attachDisposableMachines: { enabled: true, provisioners: [THREAD as never], cap: 2 },
      },
    });
    return yield* body(pen, home, alive);
  }).pipe(
    Effect.provideServiceEffect(Attach.DisposableAttach, Attach.make),
    Effect.provideServiceEffect(Store.DisposableMachineStore, Store.make),
    Effect.provideService(PenInvites, pen.service),
    Effect.provideService(
      HomeContracts,
      HomeContracts.of({ contracts: Effect.sync(() => home.contracts) }),
    ),
    Effect.provideService(
      Attach.Provisioners,
      Attach.Provisioners.of({ alive: () => Effect.sync(() => alive.value) }),
    ),
    Effect.provide(
      Layer.merge(
        Settings.ServerSettingsService.layerTest(),
        NodeSqliteClient.layer({ filename: ":memory:" }),
      ),
    ),
  );
};
const attach = (n: number, overrides: Partial<HubMachineAttachInput> = {}) =>
  Effect.flatMap(Attach.DisposableAttach, (service) =>
    service.attach(caller, "thread:" + THREAD, input(n, overrides)),
  );
const reason = <A, R>(effect: Effect.Effect<A, { readonly reason: string }, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );
const rows = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<Record<string, unknown>>`SELECT * FROM disposable_machines`,
);

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
        expect(pen.invites.size).toBe(0);
      }),
    ),
);

it.effect(
  "the first answer carries the token; a repeat answers without it and GOAT stores it nowhere",
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
        expect(yield* reason(attach(1, { name: "CC-1" }))).toBe("name_rule");
        pen.members.add(key(2));
        expect(yield* reason(attach(2))).toBe("key_in_use");
        yield* attach(3);
        expect(yield* reason(attach(4, { signPub: key(3) }))).toBe("key_in_use");
      }),
    ),
);

it.effect("with a cap of one, two concurrent attaches admit exactly one", () =>
  world(() =>
    Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      yield* settings.updateSettings({ hub: { attachDisposableMachines: { cap: 1 } } });
      const outcomes = yield* Effect.all(
        [attach(1).pipe(Effect.result), attach(2).pipe(Effect.result)],
        {
          concurrency: 2,
        },
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
        const service = yield* Attach.DisposableAttach;
        const open = yield* attach(1);
        const joined = yield* attach(2);
        pen.control.join(joined.attachId + ".1", true);
        const settings = yield* Settings.ServerSettingsService;
        yield* settings.updateSettings({ hub: { attachDisposableMachines: { enabled: false } } });
        yield* service.reconcile;
        expect(pen.invites.get(open.attachId + ".1")?.state).toEqual({ state: "cancelled" });
        const listed = (yield* service.list({})).machines;
        expect(listed.find((m) => m.attachId === open.attachId)).toMatchObject({
          state: "failed",
          class: "kept",
          penMember: false,
        });
        expect(listed.find((m) => m.attachId === joined.attachId)).toMatchObject({
          state: "paused",
          penMember: true,
        });
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
        const settings = yield* Settings.ServerSettingsService;
        yield* settings.updateSettings({ hub: { attachDisposableMachines: { enabled: false } } });
        yield* Deferred.succeed(pen.control.mintGate, undefined);
        const outcome = yield* Fiber.join(pending);
        expect(outcome._tag === "Failure" && outcome.failure.reason).toBe("switch_off");
        const [entry] = pen.invites.values();
        expect(entry?.state).toEqual({ state: "cancelled" });
        expect(yield* rows).toMatchObject([{ state: "paused", invite_id: entry?.inviteId }]);
      }),
    ),
);

it.effect("a lost mint answer holds the slot until Pen settles the mint id", () =>
  world((pen) =>
    Effect.gen(function* () {
      const service = yield* Attach.DisposableAttach;
      const settings = yield* Settings.ServerSettingsService;
      yield* settings.updateSettings({ hub: { attachDisposableMachines: { cap: 1 } } });
      pen.control.loseMint = true;
      expect(yield* reason(attach(1))).toBe("unknown_outcome");
      pen.control.loseMint = false;
      expect(yield* reason(attach(2))).toBe("cap_reached");
      // Pen made the invite; it expired without a join, so the slot is freed.
      const [entry] = pen.invites.values();
      if (entry) entry.state = { state: "expired" };
      yield* service.reconcile;
      expect((yield* attach(2)).state).toBe("invited");
    }),
  ),
);

it.effect("a mint Pen never saw is final only after its absolute expiry", () =>
  world((pen) =>
    Effect.gen(function* () {
      const service = yield* Attach.DisposableAttach;
      pen.control.loseMint = true;
      yield* reason(attach(1));
      pen.invites.clear();
      yield* service.reconcile;
      expect(yield* rows).toMatchObject([{ state: "unknown" }]);
      yield* TestClock.adjust(11 * 60 * 1000);
      yield* service.reconcile;
      expect(yield* rows).toMatchObject([{ state: "failed" }]);
    }),
  ),
);

it.effect("burned without a saved admit holds the slot as unknown", () =>
  world((pen) =>
    Effect.gen(function* () {
      const service = yield* Attach.DisposableAttach;
      const first = yield* attach(1);
      pen.control.join(first.attachId + ".1", false);
      yield* service.reconcile;
      expect((yield* service.list({ attachId: first.attachId })).machines).toMatchObject([
        { state: "unknown", penMember: false },
      ]);
    }),
  ),
);

it.effect("a reissue cancels the open invite and mints a new token for the same keys", () =>
  world((pen) =>
    Effect.gen(function* () {
      const service = yield* Attach.DisposableAttach;
      const first = yield* attach(1);
      const again = yield* service.reissue(caller, "thread:" + THREAD, {
        attachId: first.attachId,
        clientRequestId: "re-1",
      });
      expect(pen.invites.get(first.attachId + ".1")?.state).toEqual({ state: "cancelled" });
      expect(again.invite?.token).toBe("pen1_TOKEN_" + first.attachId + ".2");
      const replay = yield* service.reissue(caller, "thread:" + THREAD, {
        attachId: first.attachId,
        clientRequestId: "re-1",
      });
      expect(replay).not.toHaveProperty("invite");
    }),
  ),
);

it.effect(
  "a provisioner removed from the switch, or one that lost its grant, cannot mint again",
  () =>
    world((pen, _home, alive) =>
      Effect.gen(function* () {
        const service = yield* Attach.DisposableAttach;
        const first = yield* attach(1);
        alive.value = false;
        expect(
          yield* reason(
            service.reissue(caller, "thread:" + THREAD, {
              attachId: first.attachId,
              clientRequestId: "re-1",
            }),
          ),
        ).toBe("delegation_lost");
        alive.value = true;
        const settings = yield* Settings.ServerSettingsService;
        yield* settings.updateSettings({ hub: { attachDisposableMachines: { provisioners: [] } } });
        expect(yield* reason(attach(2))).toBe("provisioner_refused");
        expect(pen.invites.size).toBe(1);
      }),
    ),
);
