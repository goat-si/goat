import { type HubMachineAttachInput, ServerSettingsError } from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../../persistence/Migrations.ts";
import * as Settings from "../../serverSettings.ts";
import type { Delegation } from "./attachModel.ts";
import * as Attach from "./DisposableAttach.ts";
import * as Store from "./DisposableMachineStore.ts";
import { fakeEnrollHost } from "./DisposableEnroll.testkit.ts";
import { EnrollHost } from "./EnrollHost.ts";
import { MachineKey } from "./machineKey.ts";
import { withPersonConsent } from "./disposableSwitch.ts";
import { HOME_ATTACH_CONTRACTS, HomeContracts } from "./features.ts";
import {
  PEN_ATTACH_FEATURES,
  type PenInviteRef,
  type PenInviteState,
  type PenInviteStatus,
  PenInviteUnknown,
  PenInvites,
} from "./PenInvites.ts";

export const key = (byte: number) => Buffer.alloc(32, byte).toString("base64url");
export const input = (
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
const caller: Attach.AttachCaller = { provisioner: { kind: "thread", threadId: THREAD } };
export const GRANT = {
  kind: "thread" as const,
  runtimeMode: "full-access",
  interactionMode: "default",
  goatclaw: { capabilities: ["hub.manage"], runtimeMode: "full-access", hosts: null },
} satisfies Delegation;
export const INVITE_MS = 10 * 60 * 1000;

interface Entry {
  readonly mintId: string;
  readonly inviteId: string | undefined;
  readonly signPub: string;
  readonly expiresAtMs: number;
  state: "live" | "cancelled" | "burned" | "expired";
  nonce?: string;
  admit?: string;
}

/**
 * A Pen that keeps bound invites as CONTRACT "Bound invites (v1.3)" says: a mintId makes at most
 * one invite, a cancel of an unseen mintId leaves a fence, a create at or after its expiresAt or
 * past a fence makes nothing, expiry is read from the clock, terminal entries and fences stay until
 * acknowledged, and past 256 entries (512 with fences) a create is refused.
 */
export const fakePen = () => {
  const book = new Map<string, Entry>();
  const members = new Set<string>();
  const control = {
    features: new Set<string>(PEN_ATTACH_FEATURES),
    /** How many times GOAT asked Pen for its features. */
    featuresAsked: 0,
    /** How many times GOAT read Pen's member list. */
    membersAsked: 0,
    /** The next member-list read answers this instead, as a view taken before a join would. */
    staleMembersOnce: undefined as Set<string> | undefined,
    /** Awaited before the mint touches the book, so a test can hold or interrupt it. */
    mintGate: undefined as Deferred.Deferred<void> | undefined,
    mintStarted: undefined as Deferred.Deferred<void> | undefined,
    /** Awaited by invite.status, so a test can hold a settlement between read and write. */
    statusGate: undefined as Deferred.Deferred<void> | undefined,
    statusStarted: undefined as Deferred.Deferred<void> | undefined,
    /** Every invite.status asked, by the ref it named. */
    statusAsked: [] as Array<string>,
    loseMint: false,
    /** The cancel's answer is lost before Pen applies it. */
    loseCancel: false,
    tokensSeen: [] as Array<string>,
    acked: [] as Array<string>,
    /** Mints whose admit Pen holds in memory only, so status answers burned-unsaved. */
    unsaved: new Set<string>(),
    /** A join that used the invite; saved says whether the admit reached Pen's record set. */
    join: (mintId: string, saved: boolean) => {
      const entry = book.get(mintId);
      if (entry === undefined || entry.state !== "live")
        throw new Error("no live invite " + mintId);
      entry.state = "burned";
      entry.nonce = "n-" + mintId;
      if (saved) {
        entry.admit = "h-" + mintId;
        members.add(entry.signPub);
      }
    },
  };
  const now = Clock.currentTimeMillis;
  const refOf = (ref: PenInviteRef) =>
    "mintId" in ref
      ? book.get(ref.mintId)
      : [...book.values()].find((e) => e.inviteId === ref.inviteId);
  const expire = (entry: Entry, nowMs: number) => {
    if (entry.state === "live" && nowMs >= entry.expiresAtMs) entry.state = "expired";
  };
  const fences = () => [...book.values()].filter((entry) => entry.inviteId === undefined).length;
  const service = PenInvites.of({
    features: Effect.sync(() => {
      control.featuresAsked += 1;
      return control.features;
    }),
    members: Effect.sync(() => {
      control.membersAsked += 1;
      const stale = control.staleMembersOnce;
      control.staleMembersOnce = undefined;
      if (stale !== undefined) return stale;
      return new Set(members);
    }),
    mint: ({ subject, mintId, expiresAtMs }) =>
      Effect.gen(function* () {
        if (control.mintStarted) yield* Deferred.succeed(control.mintStarted, undefined);
        if (control.mintGate) yield* Deferred.await(control.mintGate);
        if (book.has(mintId) || (yield* now) >= expiresAtMs || book.size - fences() >= 256)
          return yield* new PenInviteUnknown({ reason: "refused" });
        const entry: Entry = {
          mintId,
          inviteId: "inv-" + mintId,
          signPub: subject.signPub,
          expiresAtMs,
          state: "live",
        };
        book.set(mintId, entry);
        if (control.loseMint) return yield* new PenInviteUnknown({ reason: "answer lost" });
        const token = "pen1_TOKEN_" + mintId;
        control.tokensSeen.push(token);
        return { inviteId: entry.inviteId ?? "", token, expiresAtMs };
      }),
    cancel: (ref) =>
      Effect.gen(function* () {
        if (control.loseCancel) return yield* new PenInviteUnknown({ reason: "answer lost" });
        const entry = refOf(ref);
        if (entry === undefined) {
          if (!("mintId" in ref)) return "absent" as const;
          if (book.size >= 512) return yield* new PenInviteUnknown({ reason: "refused" });
          book.set(ref.mintId, {
            mintId: ref.mintId,
            inviteId: undefined,
            signPub: "",
            expiresAtMs: 0,
            state: "cancelled",
          });
          return "cancelled" as const;
        }
        expire(entry, yield* now);
        if (entry.state === "live") entry.state = "cancelled";
        return entry.state;
      }),
    status: (ref) =>
      Effect.gen(function* () {
        control.statusAsked.push("mintId" in ref ? ref.mintId : ref.inviteId);
        if (control.statusStarted) yield* Deferred.succeed(control.statusStarted, undefined);
        if (control.statusGate) yield* Deferred.await(control.statusGate);
        const entry = refOf(ref);
        if (entry === undefined) return { state: "absent" } satisfies PenInviteState;
        expire(entry, yield* now);
        const named = entry.inviteId === undefined ? {} : { inviteId: entry.inviteId };
        switch (entry.state) {
          case "live":
            return {
              ...named,
              state: "live",
              expiresAtMs: entry.expiresAtMs,
            } satisfies PenInviteStatus;
          case "burned":
            return entry.admit !== undefined && control.unsaved.has(entry.mintId)
              ? ({
                  ...named,
                  state: "burned-unsaved",
                  nonce: entry.nonce ?? "",
                } satisfies PenInviteStatus)
              : ({
                  ...named,
                  state: "burned",
                  nonce: entry.nonce ?? "",
                  ...(entry.admit === undefined
                    ? {}
                    : { admit: entry.admit, member: members.has(entry.signPub) }),
                } satisfies PenInviteStatus);
          default:
            return { ...named, state: entry.state } satisfies PenInviteStatus;
        }
      }),
    ack: (ref) =>
      Effect.gen(function* () {
        const entry = refOf(ref);
        if (entry === undefined) return "absent" as const;
        expire(entry, yield* now);
        if (entry.state === "live") return yield* new PenInviteUnknown({ reason: "live" });
        book.delete(entry.mintId);
        control.acked.push(entry.mintId);
        return "acked" as const;
      }),
  });
  return { service, control, book, members };
};

export type World = Attach.DisposableAttach | Settings.ServerSettingsService | SqlClient.SqlClient;

/** The provisioner's grant as the fake reports it; the call numbered gateOnCall waits on gate. */
export interface Grant {
  value: Delegation | undefined;
  calls: number;
  gateOnCall?: number;
  gate?: Deferred.Deferred<void> | undefined;
  /** Completed when the gated call starts waiting. */
  reached?: Deferred.Deferred<void>;
}

export const world = <A, E>(
  body: (
    pen: ReturnType<typeof fakePen>,
    home: { contracts: Set<string>; settingsUnreadable: boolean; contractsAsked: number },
    grant: Grant,
    host: ReturnType<typeof fakeEnrollHost>,
  ) => Effect.Effect<A, E, World>,
) => {
  const pen = fakePen();
  const host = fakeEnrollHost();
  const home = {
    contracts: new Set<string>(HOME_ATTACH_CONTRACTS),
    settingsUnreadable: false,
    contractsAsked: 0,
  };
  const grant: Grant = { value: GRANT, calls: 0 };
  return Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 147 });
    const settings = yield* Settings.ServerSettingsService;
    yield* withPersonConsent(
      settings.updateSettings({
        hub: {
          enabled: true,
          attachDisposableMachines: { enabled: true, provisioners: [THREAD as never], cap: 2 },
        },
      }),
    );
    return yield* body(pen, home, grant, host);
  }).pipe(
    Effect.provideServiceEffect(Attach.DisposableAttach, Attach.make),
    Effect.provideServiceEffect(Store.DisposableMachineStore, Store.make),
    Effect.provideService(PenInvites, pen.service),
    Effect.provideService(EnrollHost, host.service),
    Effect.provideService(MachineKey, host.machineKey),
    Effect.provideService(
      HomeContracts,
      HomeContracts.of({
        contracts: Effect.sync(() => {
          home.contractsAsked += 1;
          return home.contracts;
        }),
      }),
    ),
    Effect.provideService(
      Attach.Provisioners,
      Attach.Provisioners.of({
        grantOf: () =>
          Effect.gen(function* () {
            grant.calls += 1;
            if (grant.gate !== undefined && grant.calls === grant.gateOnCall) {
              if (grant.reached !== undefined) yield* Deferred.succeed(grant.reached, undefined);
              yield* Deferred.await(grant.gate);
            }
            return grant.value;
          }),
      }),
    ),
    // A settings read fails while home.settingsUnreadable is set.
    Effect.provideServiceEffect(
      Settings.ServerSettingsService,
      Effect.map(Settings.ServerSettingsService, (inner) =>
        Settings.ServerSettingsService.of({
          ...inner,
          getSettings: Effect.suspend(() =>
            home.settingsUnreadable
              ? Effect.fail(
                  new ServerSettingsError({ settingsPath: "<memory>", operation: "read-file" }),
                )
              : inner.getSettings,
          ),
        }),
      ),
    ),
    Effect.provide(
      Layer.merge(
        Settings.ServerSettingsService.layerTest(),
        NodeSqliteClient.layer({ filename: ":memory:" }),
      ),
    ),
  );
};

export const attach = (n: number, overrides: Partial<HubMachineAttachInput> = {}) =>
  Effect.flatMap(Attach.DisposableAttach, (service) =>
    service.attach(caller, "thread:" + THREAD, input(n, overrides)),
  );
export const reissue = (attachId: string, clientRequestId: string) =>
  Effect.flatMap(Attach.DisposableAttach, (service) =>
    service.reissue(caller, "thread:" + THREAD, { attachId, clientRequestId }),
  );
export const reason = <A, R>(effect: Effect.Effect<A, { readonly reason: string }, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );
export const rows = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<Record<string, unknown>>`SELECT * FROM disposable_machines ORDER BY created_at`,
);
// A person changes the switch in Settings.
export const switchTo = (patch: Record<string, unknown>) =>
  Effect.flatMap(Settings.ServerSettingsService, (settings) =>
    withPersonConsent(settings.updateSettings({ hub: { attachDisposableMachines: patch } })),
  );
export const reconcile = Effect.flatMap(Attach.DisposableAttach, (service) => service.reconcile);
export const listed = (attachId: string) =>
  Effect.flatMap(Attach.DisposableAttach, (service) =>
    service.list({ attachId }).pipe(Effect.map((list) => list.machines[0])),
  );
