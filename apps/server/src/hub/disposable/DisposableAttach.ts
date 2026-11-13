// @effect-diagnostics-next-line nodeBuiltinImport:off -- attach ids, mint ids and request keys.
import * as NodeCrypto from "node:crypto";

import {
  type HubMachineAttachInput,
  type HubMachineList,
  type HubMachineListInput,
  type HubMachineReissueInput,
  HubMachinesError,
  type HubMachinesErrorReason,
  type HubMachineStatus,
  matchesDisposableNameRule,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";

import * as Settings from "../../serverSettings.ts";
import {
  type AttachEffect,
  conflictCount,
  decodeEffects,
  decodeProvisioner,
  decodeUnknown,
  encodeEffects,
  encodeProvisioner,
  encodeUnknown,
  mintSteps,
  penNodeId,
  type StoredProvisioner,
  stateMessage,
} from "./attachModel.ts";
import * as Store from "./DisposableMachineStore.ts";
import { disposableSwitch } from "./disposableSwitch.ts";
import { HOME_ATTACH_CONTRACTS, HomeContracts, declares } from "./features.ts";
import { PEN_ATTACH_FEATURES, type PenInviteRef, PenInvites } from "./PenInvites.ts";

export type { StoredProvisioner };

export interface AttachCaller {
  readonly provisioner: StoredProvisioner;
  /** The caller's grant as recorded at attach start; re-checked before every effect. */
  readonly delegation: unknown;
}

/** Whether a provisioner still holds at least the grant recorded with it (design section 4). */
export class Provisioners extends Context.Service<
  Provisioners,
  {
    readonly alive: (provisioner: StoredProvisioner, delegation: unknown) => Effect.Effect<boolean>;
  }
>()("goat/hub/disposable/DisposableAttach/Provisioners") {}

const INVITE_LIFETIME_MS = 10 * 60 * 1000;
const OPEN = "final_at IS NULL AND state NOT IN ('failed', 'purged', 'destroyed', 'kept')";

interface Row {
  readonly attach_id: string;
  readonly name: string;
  readonly node_id: string;
  readonly expected_sign_pub: string;
  readonly expected_noise_pub: string;
  readonly provisioner_json: string;
  readonly delegation_json: string;
  readonly grant_id: string;
  readonly invite_expires_at: string | null;
  readonly state: string;
  readonly step: string | null;
  readonly fence: number;
  readonly effects_json: string;
  readonly conflicts_json: string;
  readonly request_key: string | null;
  readonly state_since: string;
  readonly pen_admitted_at: string | null;
  readonly pen_removed_at: string | null;
  readonly final_at: string | null;
}

const fail = (reason: HubMachinesErrorReason, detail: string) =>
  Effect.fail(new HubMachinesError({ reason, detail }));
const storageFailed = () =>
  new HubMachinesError({
    reason: "storage_failed",
    detail: "The hub's disposable machine records are unavailable.",
  });
const digest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const effectsOf = (row: Row) => decodeEffects(row.effects_json);
const provisionerOf = (row: Row) => decodeProvisioner(row.provisioner_json);
const sameProvisioner = (a: StoredProvisioner | undefined, b: StoredProvisioner) =>
  a !== undefined &&
  (a.kind === "thread" ? b.kind === "thread" && a.threadId === b.threadId : b.kind === "person");
const isCanonicalKey = (key: string) => {
  const bytes = Buffer.from(key, "base64url");
  return bytes.length === 32 && bytes.toString("base64url") === key;
};
const refusalReason = (reason: Store.ForwardRefusal): HubMachinesErrorReason =>
  reason === "switch_off" || reason === "switch_expired"
    ? reason
    : reason === "fence_moved"
      ? "conflict"
      : reason === "not_found"
        ? "not_found"
        : "switch_off";

export class DisposableAttach extends Context.Service<
  DisposableAttach,
  {
    readonly attach: (
      caller: AttachCaller,
      principal: string,
      input: HubMachineAttachInput,
    ) => Effect.Effect<HubMachineStatus, HubMachinesError>;
    readonly reissue: (
      caller: AttachCaller,
      principal: string,
      input: HubMachineReissueInput,
    ) => Effect.Effect<HubMachineStatus, HubMachinesError>;
    readonly list: (input: HubMachineListInput) => Effect.Effect<HubMachineList, HubMachinesError>;
    /**
     * One pass over open records: settles each invite from what Pen saved, and cancels the open
     * invites of records whose grant is no longer the switch's.
     */
    readonly reconcile: Effect.Effect<void, HubMachinesError>;
  }
>()("goat/hub/disposable/DisposableAttach") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* Settings.ServerSettingsService;
  const store = yield* Store.DisposableMachineStore;
  const pen = yield* PenInvites;
  const home = yield* HomeContracts;
  const provisioners = yield* Provisioners;
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const read = (attachId: string) =>
    sql<Row>`SELECT * FROM disposable_machines WHERE attach_id = ${attachId}`.pipe(
      Effect.map((rows) => rows[0]),
      Effect.mapError(storageFailed),
    );
  const audit = Effect.fn("DisposableAttach.audit")(function* (
    attachId: string,
    action: string,
    outcome: string,
  ) {
    yield* sql`INSERT INTO audit_events (time, actor, profile, action, target, outcome, decision_id)
        VALUES (${yield* nowIso}, 'goat:disposable', 'hub', ${action}, ${attachId}, ${outcome}, NULL)`;
  }, Effect.mapError(storageFailed));

  /** A fact Pen or the machine settled: written under the record's fence, with no switch needed. */
  const writeFacts = Effect.fn("DisposableAttach.writeFacts")(function* (
    attachId: string,
    fence: number,
    facts: Record<string, string | number | null>,
  ) {
    const now = yield* nowIso;
    const columns = { ...facts, updated_at: now };
    yield* sql.withTransaction(
      sql`UPDATE disposable_machines SET ${sql.update(columns)}
          WHERE attach_id = ${attachId} AND fence = ${fence}`,
    );
  }, Effect.mapError(storageFailed));

  const status = (
    row: Row,
    invite?: { readonly token: string; readonly expiresAt: string },
  ): HubMachineStatus => {
    const effects = effectsOf(row);
    const { message, nextAction } = stateMessage(row.state, row.name, row.invite_expires_at);
    const provisioner = provisionerOf(row);
    return {
      attachId: row.attach_id,
      name: row.name,
      nodeId: row.node_id,
      state: row.state,
      step: row.step,
      steps: mintSteps(effects),
      message,
      nextAction,
      class:
        row.final_at !== null
          ? "kept"
          : conflictCount(row.conflicts_json) > 0
            ? "conflict"
            : "disposable",
      penMember: row.pen_admitted_at !== null && row.pen_removed_at === null,
      provisioner:
        provisioner?.kind === "thread"
          ? { kind: "thread", threadId: provisioner.threadId as never }
          : { kind: "person" },
      stateSince: row.state_since,
      ...(invite === undefined ? {} : { invite }),
    };
  };

  /** Both lanes must declare what attach uses before anything is reserved or dispatched. */
  const requireFeatures = Effect.gen(function* () {
    if (!declares(yield* pen.features, PEN_ATTACH_FEATURES))
      return yield* fail(
        "pen_unsupported",
        "This hub's Pen does not offer bound invites yet; update Pen on the hub.",
      );
    if (!declares(yield* home.contracts, HOME_ATTACH_CONTRACTS))
      return yield* fail(
        "opencodex_unsupported",
        "This hub's OpenCodex cannot record explicit routes and link operations yet; update OpenCodex.",
      );
  });

  /**
   * Admits one side effect inside the settings write lock: the switch still holds the record's grant,
   * the record's fence is unchanged and a thread provisioner is still named. The intent is written
   * before the effect is dispatched; no lock is held across it.
   */
  const admitEffect = Effect.fn("DisposableAttach.admitEffect")(function* (
    row: Row,
    effect: AttachEffect,
  ) {
    const effects = [...effectsOf(row), effect];
    const provisioner = provisionerOf(row);
    const admitted = yield* settings
      .withSettingsSnapshot((current) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const gate = disposableSwitch(current.hub, yield* Clock.currentTimeMillis);
            const [now] =
              yield* sql<Row>`SELECT * FROM disposable_machines WHERE attach_id = ${row.attach_id}`;
            if (now === undefined || now.fence !== row.fence) return "conflict" as const;
            if (!gate.open) return gate.reason;
            if (gate.grant !== now.grant_id) return "switch_off" as const;
            if (provisioner === undefined) return "provisioner_refused" as const;
            if (
              provisioner.kind === "thread" &&
              !current.hub.attachDisposableMachines.provisioners.includes(
                provisioner.threadId as never,
              )
            )
              return "provisioner_refused" as const;
            yield* sql`UPDATE disposable_machines SET effects_json = ${encodeEffects(effects)},
                updated_at = ${yield* nowIso} WHERE attach_id = ${row.attach_id}`;
            return "admitted" as const;
          }),
        ),
      )
      .pipe(Effect.mapError(storageFailed));
    return admitted;
  });

  const setEffect = (
    effects: ReadonlyArray<AttachEffect>,
    id: string,
    patch: Partial<AttachEffect>,
  ) => effects.map((effect) => (effect.id === id ? { ...effect, ...patch } : effect));

  /** Mints the next bound invite for a record and returns the token once; never stores it. */
  const mint = Effect.fn("DisposableAttach.mint")(function* (
    row: Row,
    seq: number,
    requestKey: string | undefined,
  ) {
    const nowMs = yield* Clock.currentTimeMillis;
    const mintId = row.attach_id + "." + seq;
    const expiresAtMs = nowMs + INVITE_LIFETIME_MS;
    const intent: AttachEffect = {
      id: mintId,
      kind: "mint",
      state: "intent",
      expiresAtMs,
      ...(requestKey === undefined ? {} : { requestKey }),
    };
    const provisioner = provisionerOf(row);
    if (
      provisioner === undefined ||
      !(yield* provisioners.alive(provisioner, decodeUnknown(row.delegation_json)))
    ) {
      yield* writeFacts(row.attach_id, row.fence, {
        state: "paused",
        state_since: yield* nowIso,
      });
      return yield* fail(
        "delegation_lost",
        "The provisioner no longer holds the grant this attach started with.",
      );
    }
    const admitted = yield* admitEffect(row, intent);
    if (admitted !== "admitted") {
      if (
        admitted === "provisioner_refused" ||
        admitted === "switch_off" ||
        admitted === "switch_expired"
      )
        yield* writeFacts(row.attach_id, row.fence, {
          state: "paused",
          state_since: yield* nowIso,
        });
      return yield* fail(
        admitted,
        admitted === "conflict"
          ? "The record changed while the invite was being made."
          : "The switch no longer allows this attach.",
      );
    }
    const effects = [...effectsOf(row), intent];
    const minted = yield* pen
      .mint({
        subject: {
          signPub: row.expected_sign_pub,
          noisePub: row.expected_noise_pub,
          name: row.name,
        },
        mintId,
        expiresAtMs,
      })
      .pipe(Effect.result);
    if (minted._tag === "Failure") {
      yield* writeFacts(row.attach_id, row.fence, {
        effects_json: encodeEffects(setEffect(effects, mintId, { state: "unknown" })),
        state: "unknown",
        state_since: yield* nowIso,
      });
      yield* audit(row.attach_id, "hub.machine_mint", "unknown");
      return yield* fail(
        "unknown_outcome",
        "Pen's answer to the invite was lost; goat_hub_machine_list settles it by its mint id.",
      );
    }
    const invite = minted.success;
    const expiresAt = DateTime.formatIso(DateTime.makeUnsafe(invite.expiresAtMs));
    const done = setEffect(effects, mintId, { state: "done", inviteId: invite.inviteId });
    const committed = yield* store
      .commitForward(
        { attachId: row.attach_id, fence: row.fence },
        Effect.gen(function* () {
          const now = yield* nowIso;
          yield* sql`UPDATE disposable_machines SET invite_id = ${invite.inviteId}, mint_id = ${mintId},
              invite_expires_at = ${expiresAt}, state = 'invited', step = 'invite',
              effects_json = ${encodeEffects(done)}, state_since = ${now}, updated_at = ${now}
              WHERE attach_id = ${row.attach_id}`;
        }),
      )
      .pipe(Effect.mapError(storageFailed));
    if (!committed.committed) {
      // The switch changed after admission: this exact invite is cancelled before its token is seen.
      const cancelled = yield* pen.cancel({ inviteId: invite.inviteId }).pipe(Effect.result);
      yield* writeFacts(row.attach_id, row.fence, {
        effects_json: encodeEffects(
          setEffect(effects, mintId, { state: "late", inviteId: invite.inviteId }),
        ),
        invite_id: invite.inviteId,
        mint_id: mintId,
        state:
          cancelled._tag === "Success" && cancelled.success !== "burned" ? "paused" : "unknown",
        state_since: yield* nowIso,
      });
      yield* audit(row.attach_id, "hub.machine_mint", "withdrawn");
      return yield* fail(
        refusalReason(committed.reason),
        "The switch changed while the invite was being made; it was cancelled.",
      );
    }
    yield* audit(row.attach_id, "hub.machine_mint", "invited");
    const fresh = yield* read(row.attach_id);
    if (fresh === undefined) return yield* storageFailed();
    return status(fresh, { token: invite.token, expiresAt });
  });

  const byRequest = (requestKey: string) =>
    sql<Row>`SELECT * FROM disposable_machines WHERE request_key = ${requestKey}`.pipe(
      Effect.map((rows) => rows[0]),
      Effect.mapError(storageFailed),
    );

  const attach = Effect.fn("DisposableAttach.attach")(function* (
    caller: AttachCaller,
    principal: string,
    input: HubMachineAttachInput,
  ) {
    const nodeId = penNodeId(input.signPub);
    if (nodeId === undefined || !isCanonicalKey(input.noisePub))
      return yield* fail(
        "invalid_request",
        "signPub and noisePub must be canonical 32-byte Pen keys.",
      );
    const requestKey = digest(principal + "\n" + input.clientRequestId);
    const earlier = yield* byRequest(requestKey);
    if (earlier !== undefined) {
      if (
        earlier.expected_sign_pub !== input.signPub ||
        earlier.expected_noise_pub !== input.noisePub ||
        earlier.name !== input.name
      )
        return yield* fail("invalid_request", "This clientRequestId was used for another machine.");
      return status(earlier);
    }
    yield* requireFeatures;
    const member = yield* pen.isMember(input.signPub);
    if (member === undefined)
      return yield* fail("pen_unsupported", "This hub's Pen member list could not be read.");
    if (member)
      return yield* fail(
        "key_in_use",
        "That key is already a Pen member; remove it from Pen first.",
      );
    if (!(yield* provisioners.alive(caller.provisioner, caller.delegation)))
      return yield* fail("provisioner_refused", "This caller may not attach machines.");
    const attachId = NodeCrypto.randomUUID();
    const reserved = yield* settings
      .withSettingsSnapshot((current) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const gate = disposableSwitch(current.hub, yield* Clock.currentTimeMillis);
            if (!gate.open) return gate.reason;
            const value = current.hub.attachDisposableMachines;
            if (
              caller.provisioner.kind === "thread" &&
              !value.provisioners.includes(caller.provisioner.threadId as never)
            )
              return "provisioner_refused" as const;
            if (!matchesDisposableNameRule(value.nameRule, input.name)) return "name_rule" as const;
            const [taken] = yield* sql<{
              readonly n: number;
            }>`SELECT COUNT(*) AS n FROM disposable_machines
              WHERE ${sql.unsafe(OPEN)} AND (node_id = ${nodeId} OR expected_sign_pub = ${input.signPub}
                OR expected_noise_pub = ${input.noisePub})`;
            if ((taken?.n ?? 0) > 0) return "key_in_use" as const;
            // A slot is held by every open record and by every admitted key still in Pen.
            const [held] = yield* sql<{
              readonly n: number;
            }>`SELECT COUNT(*) AS n FROM disposable_machines
              WHERE (${sql.unsafe(OPEN)}) OR (pen_admitted_at IS NOT NULL AND pen_removed_at IS NULL)`;
            if ((held?.n ?? 0) >= value.cap) return "cap_reached" as const;
            const now = yield* nowIso;
            yield* sql`INSERT INTO disposable_machines ${sql.insert({
              attach_id: attachId,
              provisioner_json: encodeProvisioner(caller.provisioner),
              delegation_json: encodeUnknown(caller.delegation ?? null),
              name: input.name,
              label: input.label ?? null,
              expected_sign_pub: input.signPub,
              expected_noise_pub: input.noisePub,
              node_id: nodeId,
              grant_id: gate.grant,
              state: "reserved",
              step: "reserve",
              request_key: requestKey,
              created_at: now,
              state_since: now,
              updated_at: now,
            })}`;
            return "reserved" as const;
          }),
        ),
      )
      .pipe(Effect.mapError(storageFailed));
    if (reserved !== "reserved")
      return yield* fail(
        reserved,
        {
          switch_off: "Attach disposable machines is off on this hub.",
          switch_expired: "Attach disposable machines has expired on this hub.",
          provisioner_refused: "This thread is not named in Attach disposable machines.",
          name_rule: "The name does not match the switch's name rule.",
          key_in_use: "Another attach already holds these keys.",
          cap_reached: "The switch's cap of disposable machines is reached.",
        }[reserved],
      );
    yield* audit(attachId, "hub.machine_attach", "reserved");
    const row = yield* read(attachId);
    if (row === undefined) return yield* storageFailed();
    return yield* mint(row, 1, undefined);
  });

  const latestMint = (row: Row) =>
    effectsOf(row)
      .filter((effect) => effect.kind === "mint")
      .at(-1);
  const refOf = (effect: AttachEffect): PenInviteRef =>
    effect.inviteId === undefined ? { mintId: effect.id } : { inviteId: effect.inviteId };

  /** Settles one record's latest invite from what Pen saved. */
  const settle = Effect.fn("DisposableAttach.settle")(function* (row: Row) {
    const effect = latestMint(row);
    if (effect === undefined) return;
    const nowMs = yield* Clock.currentTimeMillis;
    const current = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => undefined));
    const gate = current === undefined ? undefined : disposableSwitch(current.hub, nowMs);
    const withdrawn = gate === undefined || !gate.open || gate.grant !== row.grant_id;
    const answer = yield* pen.status(refOf(effect)).pipe(Effect.option);
    if (answer._tag === "None") return;
    const found = answer.value;
    const now = yield* nowIso;
    const finish = (state: string) =>
      writeFacts(row.attach_id, row.fence, {
        state,
        state_since: now,
        final_at: state === "failed" ? now : null,
      });
    switch (found.state) {
      case "live": {
        if (!withdrawn) return;
        const cancelled = yield* pen.cancel(refOf(effect)).pipe(Effect.option);
        if (
          cancelled._tag === "Some" &&
          (cancelled.value === "cancelled" || cancelled.value === "expired")
        ) {
          yield* finish("failed");
          yield* audit(row.attach_id, "hub.machine_withdraw", cancelled.value);
        }
        return;
      }
      case "cancelled":
      case "expired":
        yield* finish("failed");
        yield* pen.ack(refOf(effect)).pipe(Effect.ignore);
        return;
      case "absent":
        // A mint never seen by Pen is final once its absolute expiry has passed.
        if (
          effect.inviteId === undefined &&
          effect.expiresAtMs !== undefined &&
          nowMs > effect.expiresAtMs
        )
          yield* finish("failed");
        return;
      case "burned-unsaved":
        return;
      case "burned":
        if (found.admit === undefined) {
          // Burned without a saved admit: nobody can say who joined, so the slot stays held.
          if (row.state !== "unknown")
            yield* writeFacts(row.attach_id, row.fence, { state: "unknown", state_since: now });
          return;
        }
        yield* writeFacts(row.attach_id, row.fence, {
          state: withdrawn ? "paused" : "admitted",
          step: "admitted",
          offer_nonce: found.nonce,
          admit_hash: found.admit,
          pen_admitted_at: row.pen_admitted_at ?? now,
          pen_removed_at: found.member === false ? now : null,
          state_since: now,
        });
        yield* audit(
          row.attach_id,
          "hub.machine_admitted",
          withdrawn ? "joined_after_withdrawal" : "admitted",
        );
        yield* pen.ack(refOf(effect)).pipe(Effect.ignore);
        return;
    }
  });

  const reconcile = Effect.gen(function* () {
    const rows = yield* sql<Row>`SELECT * FROM disposable_machines
      WHERE ${sql.unsafe(OPEN)} AND state IN ('reserved', 'invited', 'unknown', 'paused')
      ORDER BY created_at LIMIT 1000`.pipe(Effect.mapError(storageFailed));
    for (const row of rows) if (row.pen_admitted_at === null) yield* settle(row);
  }).pipe(Effect.withSpan("DisposableAttach.reconcile"));

  const reissue = Effect.fn("DisposableAttach.reissue")(function* (
    caller: AttachCaller,
    principal: string,
    input: HubMachineReissueInput,
  ) {
    const row = yield* read(input.attachId);
    if (row === undefined) return yield* fail("not_found", "No attach has that id.");
    if (
      !sameProvisioner(provisionerOf(row), caller.provisioner) &&
      caller.provisioner.kind !== "person"
    )
      return yield* fail(
        "provisioner_refused",
        "Only the provisioner or a person may reissue this invite.",
      );
    const requestKey = digest(principal + "\n" + input.clientRequestId);
    if (effectsOf(row).some((effect) => effect.requestKey === requestKey)) return status(row);
    const effect = latestMint(row);
    if (row.state !== "invited" || effect === undefined)
      return yield* fail("conflict", "Only an open invite can be reissued.");
    yield* requireFeatures;
    const cancelled = yield* pen
      .cancel(refOf(effect))
      .pipe(
        Effect.catch(() =>
          fail(
            "unknown_outcome",
            "Pen's answer to the cancel was lost; try again with a new clientRequestId.",
          ),
        ),
      );
    if (cancelled === "burned" || cancelled === "absent") {
      yield* settle(row);
      const settled = yield* read(row.attach_id);
      return settled === undefined ? yield* storageFailed() : status(settled);
    }
    const seq = effectsOf(row).filter((entry) => entry.kind === "mint").length + 1;
    return yield* mint(row, seq, requestKey);
  });

  const list = Effect.fn("DisposableAttach.list")(function* (input: HubMachineListInput) {
    yield* reconcile.pipe(Effect.ignore);
    const rows =
      input.attachId === undefined
        ? yield* sql<Row>`SELECT * FROM disposable_machines ORDER BY created_at DESC LIMIT 200`.pipe(
            Effect.mapError(storageFailed),
          )
        : [yield* read(input.attachId)].filter((row) => row !== undefined);
    return { machines: rows.map((row) => status(row)) };
  });

  return DisposableAttach.of({ attach, reissue, list, reconcile });
});

// Settles invites and withdraws ones whose grant ended, also when no client is reading.
const RECONCILE_EVERY = "30 seconds";

export const layer = Layer.effect(
  DisposableAttach,
  Effect.gen(function* () {
    const service = yield* make;
    yield* service.reconcile.pipe(
      Effect.catch((error) =>
        Effect.logWarning("Disposable machine reconcile failed").pipe(
          Effect.annotateLogs({ reason: error.detail }),
        ),
      ),
      Effect.repeat(Schedule.spaced(RECONCILE_EVERY)),
      Effect.forkScoped,
    );
    return service;
  }),
);
