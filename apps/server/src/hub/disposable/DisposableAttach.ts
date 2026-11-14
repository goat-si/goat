// @effect-diagnostics-next-line nodeBuiltinImport:off -- attach ids and request keys.
import * as NodeCrypto from "node:crypto";

import {
  type HubMachineAttachInput,
  type HubMachineList,
  type HubMachineListInput,
  type HubMachineReissueInput,
  HubMachinesError,
  type HubMachineStatus,
  isPenNodeName,
  matchesDisposableNameRule,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as Settings from "../../serverSettings.ts";
import {
  type AttachEffect,
  ackable,
  encodeDelegation,
  encodeEffects,
  encodeProvisioner,
  observe,
  openEffects,
  penNodeId,
  stateFromEffects,
  type StoredProvisioner,
} from "./attachModel.ts";
import * as Store from "./DisposableMachineStore.ts";
import { disposableSwitch } from "./disposableSwitch.ts";
import { HOME_ATTACH_CONTRACTS, HomeContracts, declares } from "./features.ts";
import { PEN_ATTACH_FEATURES, type PenInviteState, PenInvites } from "./PenInvites.ts";
import { makeSharedPasses } from "./sharedPasses.ts";
import { makeAuthority, Provisioners } from "./attachAuthority.ts";
import { makeEnroll } from "./DisposableEnroll.ts";
import { MachineKey } from "./machineKey.ts";
import {
  afterCancel,
  type Columns,
  digest,
  effectsOf,
  fail,
  IN_PEN,
  isCanonicalKey,
  lockBound,
  NotNamed,
  OPEN,
  OWES_ACK,
  provisionerOf,
  refOf,
  refusalOf,
  refusalText,
  type Refusal,
  replace,
  type Row,
  samePolicy,
  sameProvisioner,
  status,
  storageFailed,
} from "./attachRow.ts";

export type { StoredProvisioner };
export { Provisioners };

export interface AttachCaller {
  readonly provisioner: StoredProvisioner;
}

const INVITE_LIFETIME_MS = 10 * 60 * 1000;
/** How long a list waits for Pen's answers before it reads what GOAT has stored. */
export const LIST_WAIT = "3 seconds";
// HubMachineStatus.steps carries at most 32 entries, one per invite, and the record keeps them all.
const MAX_INVITES_PER_ATTACH = 32;
const INVITES_USED =
  "This attach has used all its invites. Its last invite holds these keys until GOAT records its expiry, on the next 30-second pass or the next list, later if Pen cannot be reached; then attach the machine again with a new request.";

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
    /** The stored record's Pen node id, read without asking Pen; for a caller's host check. */
    readonly nodeOf: (attachId: string) => Effect.Effect<string | undefined, HubMachinesError>;
    /**
     * One pass over open records and admitted keys: withdraws the open mints of records whose
     * provisioner's authority ended, settles each mint from what Pen saved, lets Pen forget what
     * GOAT has stored, and confirms admitted keys are still members. A pass already running is
     * joined; its failures are logged, never returned.
     */
    readonly reconcile: Effect.Effect<void>;
    /**
     * One pass that moves admitted attaches on (route, reach, link); joined if running. Reconcile
     * starts it without waiting, so a slow link never holds back invites and withdrawals.
     */
    readonly enroll: Effect.Effect<void>;
  }
>()("goat/hub/disposable/DisposableAttach") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* Settings.ServerSettingsService;
  const store = yield* Store.DisposableMachineStore;
  const pen = yield* PenInvites;
  const home = yield* HomeContracts;
  const provisioners = yield* Provisioners;
  const machineKey = yield* MachineKey;
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  // One attach mutation at a time, each rereading its record: mint, reissue, settlement and
  // withdrawal never interleave. Lock order: this, the settings write lock, the SQL transaction.
  const exclusive = (yield* Semaphore.make(1)).withPermits(1);
  // Passes outlive the caller that started them, so an interrupted list never cuts one short.
  const shared = makeSharedPasses(yield* Effect.scope, 64);

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

  /**
   * Stores a record's mints with the state they give it, under its fence and with no switch
   * needed: these are facts Pen reported. An admitted record keeps its state unless told.
   */
  const save = Effect.fn("DisposableAttach.save")(
    function* (row: Row, effects: ReadonlyArray<AttachEffect>, extra: Columns = {}) {
      const now = yield* nowIso;
      const state =
        typeof extra.state === "string"
          ? extra.state
          : row.pen_admitted_at === null
            ? stateFromEffects(effects)
            : row.state;
      const saved = yield* sql`UPDATE disposable_machines SET ${sql.update({
        ...extra,
        effects_json: encodeEffects(effects),
        state,
        ...(state === row.state
          ? {}
          : { state_since: typeof extra.state_since === "string" ? extra.state_since : now }),
        ...(state === "failed" && row.final_at === null ? { final_at: now } : {}),
        updated_at: now,
      })} WHERE attach_id = ${row.attach_id} AND fence = ${row.fence} RETURNING attach_id`;
      // A moved fence means another step owns the record now; nothing may follow from this save.
      if (saved.length !== 1) return yield* fail("conflict", refusalText.conflict);
      const fresh = yield* read(row.attach_id);
      return fresh ?? row;
    },
    Effect.catchTags({ SqlError: () => Effect.fail(storageFailed()) }),
  );

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

  const { unnamed, authorityEnded, settingsNow, lockedEnded, finalCheck } = yield* makeAuthority;
  const enrollment = yield* makeEnroll(exclusive);
  /** The public line a machine must trust; attach makes the key, a read never does. */
  const knownKey = Effect.map(machineKey.known, (identity) => identity?.publicLine);

  /**
   * Admits the next mint (design section 2, Effect admission): the provisioner's grant is checked
   * first, then inside the settings write lock the switch, its grant, the named thread and the
   * record as read. Only the mints are written; no lock is held across the dispatch.
   */
  const admitMint = Effect.fn("DisposableAttach.admitMint")(function* (
    row: Row,
    effects: ReadonlyArray<AttachEffect>,
  ) {
    const before = yield* settingsNow;
    const ended = yield* authorityEnded(row, before);
    if (ended !== undefined || before === undefined) return ended ?? ("switch_off" as const);
    return yield* settings
      .withSettingsSnapshot((current) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const locked = lockedEnded(row, before, current, yield* Clock.currentTimeMillis);
              if (locked !== undefined) return locked;
              const [now] =
                yield* sql<Row>`SELECT * FROM disposable_machines WHERE attach_id = ${row.attach_id}`;
              if (
                now === undefined ||
                now.fence !== row.fence ||
                now.effects_json !== row.effects_json
              )
                return "conflict" as const;
              yield* sql`UPDATE disposable_machines SET effects_json = ${encodeEffects(effects)},
                updated_at = ${yield* nowIso} WHERE attach_id = ${row.attach_id}`;
              return "admitted" as const;
            }),
          )
          .pipe(lockBound),
      )
      .pipe(Effect.mapError(storageFailed));
  });

  /** Cancels a minted invite by its id before its token is seen, and stores the outcome. */
  const withdrawMinted = Effect.fn("DisposableAttach.withdrawMinted")(function* (
    row: Row,
    effect: AttachEffect,
    inviteId: string,
    reason: Refusal,
  ) {
    const withdrawn: AttachEffect = { ...effect, inviteId, withdrawn: true };
    const cancelled = yield* pen.cancel({ inviteId }).pipe(Effect.option);
    yield* save(
      row,
      replace(
        effectsOf(row),
        cancelled._tag === "Some" ? afterCancel(withdrawn, cancelled.value) : withdrawn,
      ),
      { invite_id: inviteId, mint_id: effect.id },
    );
    yield* audit(row.attach_id, "hub.machine_mint", "withdrawn");
    return yield* fail(reason, refusalText[reason] + " The new invite was cancelled.");
  });

  /**
   * Dispatches an admitted mint and returns its token once; no record holds it. The token leaves
   * only after the forward commit and one more check of the provisioner's grant; when either
   * refuses, that exact invite is cancelled before anyone sees the token.
   */
  const dispatchMint = Effect.fn("DisposableAttach.dispatchMint")(function* (
    row: Row,
    intent: AttachEffect,
  ) {
    const effects = effectsOf(row);
    const minted = yield* pen
      .mint({
        subject: {
          signPub: row.expected_sign_pub,
          noisePub: row.expected_noise_pub,
          name: row.name,
        },
        mintId: intent.id,
        expiresAtMs: intent.expiresAtMs,
      })
      .pipe(Effect.result);
    if (minted._tag === "Failure") {
      // The token never left GOAT, so a cancel by mintId makes the outcome certain: it cancels the
      // invite, or leaves a fence that refuses a late create (Pen CONTRACT "Bound invites").
      const lost: AttachEffect = { ...intent, state: "unknown" };
      const cancelled = yield* pen.cancel({ mintId: intent.id }).pipe(Effect.option);
      const settled = yield* save(
        row,
        replace(effects, cancelled._tag === "Some" ? afterCancel(lost, cancelled.value) : lost),
      );
      if (settled.state === "failed") {
        yield* audit(row.attach_id, "hub.machine_mint", "lost_answer_cancelled");
        return status(settled);
      }
      yield* audit(row.attach_id, "hub.machine_mint", "unknown");
      return yield* fail(
        "unknown_outcome",
        "Pen's answer to the invite was lost. Refresh the machine list; GOAT settles it with Pen.",
      );
    }
    const invite = minted.success;
    const expiresAt = DateTime.formatIso(DateTime.makeUnsafe(invite.expiresAtMs));
    const done = replace(effects, { ...intent, state: "done", inviteId: invite.inviteId });
    const committed = yield* store
      .commitForward({ attachId: row.attach_id, fence: row.fence }, (current) =>
        Effect.gen(function* () {
          if (unnamed(row, current)) return yield* new NotNamed();
          const now = yield* nowIso;
          yield* sql`UPDATE disposable_machines SET invite_id = ${invite.inviteId}, mint_id = ${intent.id},
              invite_expires_at = ${expiresAt}, state = 'invited', step = 'invite',
              effects_json = ${encodeEffects(done)}, state_since = ${now}, updated_at = ${now}
              WHERE attach_id = ${row.attach_id}`;
          yield* audit(row.attach_id, "hub.machine_mint", "invited");
        }),
      )
      .pipe(
        Effect.catchTags({
          NotNamed: () =>
            Effect.succeed({ committed: false, reason: "provisioner_refused" } as const),
        }),
        // The commit may or may not have landed, so the token is withheld and its invite cancelled.
        Effect.catch(() => unrecorded(invite.inviteId)),
      );
    if (!committed.committed)
      return yield* withdrawMinted(
        row,
        { ...intent, state: "late" },
        invite.inviteId,
        refusalOf(committed.reason),
      );
    const fresh = yield* read(row.attach_id);
    if (fresh === undefined) return yield* storageFailed();
    // A thread's modes, profile or a session can change without the settings lock; any change
    // that landed before this check withdraws the invite, any later one is reconcile's withdrawal.
    const lost = yield* finalCheck(fresh);
    if (lost !== undefined)
      return yield* withdrawMinted(fresh, { ...intent, state: "done" }, invite.inviteId, lost);
    return status(fresh, { token: invite.token, expiresAt }, yield* knownKey);
  });

  const unrecorded = Effect.fn("DisposableAttach.unrecorded")(function* (inviteId: string) {
    const cancelled = yield* pen.cancel({ inviteId }).pipe(Effect.option);
    return yield* fail(
      "unknown_outcome",
      cancelled._tag === "Some" && cancelled.value === "cancelled"
        ? "GOAT could not record the new invite, so it cancelled it. Attach again with a new request."
        : "GOAT could not record the new invite and could not confirm its cancel; it expires within 10 minutes.",
    );
  });

  const byRequest = (requestKey: string) =>
    sql<Row>`SELECT * FROM disposable_machines WHERE request_key = ${requestKey}`.pipe(
      Effect.map((rows) => rows[0]),
      Effect.mapError(storageFailed),
    );
  const replayAttach = (earlier: Row, input: HubMachineAttachInput) =>
    earlier.expected_sign_pub !== input.signPub ||
    earlier.expected_noise_pub !== input.noisePub ||
    earlier.name !== input.name
      ? fail("invalid_request", "This clientRequestId was used for another machine.")
      : Effect.map(knownKey, (key) => status(earlier, undefined, key));

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
    if (!isPenNodeName(input.name))
      return yield* fail(
        "invalid_request",
        "Pen names are 1 to 32 of a-z, 0-9, - _ and ., starting with a letter or digit.",
      );
    const requestKey = digest(principal + "\n" + input.clientRequestId);
    const earlier = yield* byRequest(requestKey);
    if (earlier !== undefined) return yield* replayAttach(earlier, input);
    // Cheap refusals first: a closed switch or an unnamed thread asks neither Pen nor OpenCodex.
    // The settings lock checks both again before anything is reserved.
    const before = yield* settingsNow;
    if (before === undefined) return yield* storageFailed();
    const gate = disposableSwitch(before.hub, yield* Clock.currentTimeMillis);
    if (!gate.open) return yield* fail(gate.reason, refusalText[gate.reason]);
    const thread = caller.provisioner.kind === "thread" ? caller.provisioner.threadId : undefined;
    if (
      thread !== undefined &&
      !before.hub.attachDisposableMachines.provisioners.some((id) => id === thread)
    )
      return yield* fail("provisioner_refused", refusalText.provisioner_refused);
    yield* requireFeatures;
    // The machine trusts this key alone, so it exists before any invite does.
    if ((yield* machineKey.identity.pipe(Effect.option))._tag === "None")
      return yield* fail("storage_failed", "GOAT could not make this hub's machine key.");
    const members = yield* pen.members;
    if (members === undefined)
      return yield* fail("pen_unsupported", "This hub's Pen member list could not be read.");
    if (members.has(input.signPub))
      return yield* fail(
        "key_in_use",
        "That key is already a Pen member; remove it from Pen first.",
      );
    return yield* exclusive(
      Effect.gen(function* () {
        const again = yield* byRequest(requestKey);
        if (again !== undefined) return yield* replayAttach(again, input);
        const attachId = NodeCrypto.randomUUID();
        // The first mint's intent is written with the reservation, so no crash leaves a slot held
        // by a record with nothing to settle.
        const intent: AttachEffect = {
          id: attachId + ".1",
          kind: "mint",
          state: "intent",
          expiresAtMs: (yield* Clock.currentTimeMillis) + INVITE_LIFETIME_MS,
        };
        // The grant is read before the settings lock: resolving it goes through the settings service.
        // Under the lock, the goatclaw policy it was resolved from must be unchanged.
        const atGrant = yield* settingsNow;
        if (atGrant === undefined) return yield* storageFailed();
        const delegation = yield* provisioners.grantOf(caller.provisioner, nodeId);
        if (delegation === undefined)
          return yield* fail(
            "provisioner_refused",
            "This caller is not named in Attach disposable machines or lacks hub.manage for this machine.",
          );
        const reserved = yield* settings
          .withSettingsSnapshot((current) =>
            Effect.gen(function* () {
              const value = current.hub.attachDisposableMachines;
              if (thread !== undefined && !value.provisioners.some((id) => id === thread))
                return "provisioner_refused" as const;
              if (!samePolicy(current, atGrant)) return "delegation_lost" as const;
              if (!matchesDisposableNameRule(value.nameRule, input.name))
                return "name_rule" as const;
              return yield* sql
                .withTransaction(
                  Effect.gen(function* () {
                    const gate = disposableSwitch(current.hub, yield* Clock.currentTimeMillis);
                    if (!gate.open) return gate.reason;
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
                    WHERE (${sql.unsafe(OPEN)}) OR (${sql.unsafe(IN_PEN)})`;
                    if ((held?.n ?? 0) >= value.cap) return "cap_reached" as const;
                    const now = yield* nowIso;
                    yield* sql`INSERT INTO disposable_machines ${sql.insert({
                      attach_id: attachId,
                      provisioner_json: encodeProvisioner(caller.provisioner),
                      delegation_json: encodeDelegation(delegation),
                      name: input.name,
                      label: input.label ?? null,
                      expected_sign_pub: input.signPub,
                      expected_noise_pub: input.noisePub,
                      node_id: nodeId,
                      grant_id: gate.grant,
                      state: "reserved",
                      step: "reserve",
                      effects_json: encodeEffects([intent]),
                      request_key: requestKey,
                      created_at: now,
                      state_since: now,
                      updated_at: now,
                    })}`;
                    return "reserved" as const;
                  }),
                )
                .pipe(lockBound);
            }),
          )
          .pipe(Effect.mapError(storageFailed));
        if (reserved !== "reserved")
          return yield* fail(
            reserved,
            {
              switch_off: "Attach disposable machines is off on this hub.",
              switch_expired: "Attach disposable machines has expired on this hub.",
              provisioner_refused:
                "This caller is not named in Attach disposable machines or lacks hub.manage for this machine.",
              delegation_lost: refusalText.delegation_lost,
              name_rule: "The name does not match the switch's name rule.",
              key_in_use: "Another attach already holds these keys.",
              cap_reached: "The switch's cap of disposable machines is reached.",
            }[reserved],
          );
        yield* audit(attachId, "hub.machine_attach", "reserved");
        const row = yield* read(attachId);
        if (row === undefined) return yield* storageFailed();
        return yield* dispatchMint(row, intent);
      }),
    );
  });

  /**
   * Settles one record from what Pen saved; the caller holds the attach lock. A withdrawal is
   * stored before any cancel is sent, a terminal state before Pen is told to forget it, and an
   * admitted key is released only when Pen's view no longer has it.
   */
  const settleRecord = Effect.fn("DisposableAttach.settleRecord")(function* (
    start: Row,
    members: Effect.Effect<ReadonlySet<string> | undefined> = pen.members,
  ) {
    let row = start;
    let effects = effectsOf(row);
    if (row.pen_admitted_at !== null && row.pen_removed_at === null) {
      // A pass's view can predate a join that settled since, so a miss there is only a suspicion:
      // Pen is asked again before the removal is stored.
      const missing = (view: ReadonlySet<string> | undefined) =>
        view !== undefined && !view.has(row.expected_sign_pub);
      if (missing(yield* members) && missing(yield* pen.members)) {
        // The fence moves with the removal, so an enrollment step in flight commits nothing after it.
        // A record that holds or started a link stays open until enrollment reads what it left.
        const linking = row.link_id !== null || row.link_operation_id !== null;
        row = yield* save(row, effects, {
          fence: row.fence + 1,
          pen_removed_at: yield* nowIso,
          ...(row.final_at === null ? { state: linking ? "left_pen" : "failed" } : {}),
        });
        yield* audit(row.attach_id, "hub.machine_left_pen", "removed");
      }
    }
    if (openEffects(effects).length > 0) {
      // Unreadable settings prove nothing ended: withdrawing then would cancel every open invite.
      const current = yield* settingsNow;
      const ended = current === undefined ? undefined : yield* authorityEnded(row, current);
      if (ended !== undefined && openEffects(effects).some((effect) => effect.withdrawn !== true)) {
        effects = effects.map((effect) =>
          effect.settled === undefined ? { ...effect, withdrawn: true } : effect,
        );
        row = yield* save(row, effects);
        yield* audit(row.attach_id, "hub.machine_withdraw", ended);
      }
      let admitted: Extract<PenInviteState, { state: "burned" }> | undefined;
      for (const effect of openEffects(effects)) {
        let next = effect;
        if (next.withdrawn === true) {
          // An unseen mint is cancelled by mintId, which fences a late create; a known one by its id.
          const cancelled = yield* pen.cancel(refOf(next)).pipe(Effect.option);
          if (cancelled._tag === "Some") next = afterCancel(next, cancelled.value);
        }
        if (next.settled === undefined) {
          const answer = yield* pen.status(refOf(next)).pipe(Effect.option);
          if (answer._tag === "Some") {
            next = observe(next, answer.value, yield* Clock.currentTimeMillis);
            if (answer.value.state === "burned" && answer.value.admit !== undefined)
              admitted = answer.value;
          }
        }
        effects = replace(effects, next);
      }
      const withdrawn = effects.some((effect) => effect.withdrawn === true);
      const now = yield* nowIso;
      row = yield* save(
        row,
        effects,
        admitted === undefined
          ? {}
          : {
              state: admitted.member === false ? "failed" : withdrawn ? "paused" : "admitted",
              step: "admitted",
              offer_nonce: admitted.nonce,
              admit_hash: admitted.admit ?? null,
              // One time for both: the paused text compares them to tell which came first.
              pen_admitted_at: row.pen_admitted_at ?? now,
              state_since: now,
              pen_removed_at: admitted.member === false ? now : null,
            },
      );
      if (admitted !== undefined)
        yield* audit(
          row.attach_id,
          "hub.machine_admitted",
          withdrawn ? "joined_after_withdrawal" : "admitted",
        );
    }
    const nowMs = yield* Clock.currentTimeMillis;
    if (!effects.some((effect) => ackable(effect, nowMs))) return row;
    for (const effect of effects.filter((entry) => ackable(entry, nowMs))) {
      const acked = yield* pen.ack(refOf(effect)).pipe(Effect.option);
      if (acked._tag === "Some") effects = replace(effects, { ...effect, acked: true });
    }
    return yield* save(row, effects);
  });

  const fullPass = Effect.gen(function* () {
    const due = yield* sql<{ readonly attach_id: string }>`SELECT attach_id FROM disposable_machines
      WHERE (${sql.unsafe(OPEN)}) OR (${sql.unsafe(IN_PEN)}) OR ${sql.unsafe(OWES_ACK)}
      ORDER BY created_at LIMIT 1000`.pipe(Effect.mapError(storageFailed));
    // One read of Pen's member list serves every admitted record in the pass.
    const members = yield* Effect.cached(pen.members);
    for (const { attach_id } of due) yield* settleOne(attach_id, members);
  }).pipe(Effect.withSpan("DisposableAttach.reconcile"));
  const settleOne = (attachId: string, members?: Effect.Effect<ReadonlySet<string> | undefined>) =>
    exclusive(
      Effect.flatMap(read(attachId), (row) =>
        row === undefined ? Effect.void : Effect.asVoid(settleRecord(row, members)),
      ),
    );
  const enrollPass = enrollment.pass.pipe(Effect.mapError(storageFailed));
  const enroll = Effect.flatMap(shared("enroll", enrollPass), Deferred.await);
  const reconcile = Effect.flatMap(shared("all", fullPass), Deferred.await).pipe(
    Effect.andThen(shared("enroll", enrollPass)),
    Effect.asVoid,
  );

  const recordRequest = (requestKey: string, outcome: string, detail: string | null) =>
    Effect.flatMap(
      nowIso,
      (now) =>
        sql`UPDATE disposable_machine_requests SET outcome = ${outcome}, detail = ${detail},
          updated_at = ${now} WHERE request_key = ${requestKey}`,
    ).pipe(Effect.mapError(storageFailed));

  /**
   * Cancels the record's open mint by its mintId: cancelled mints the next invite for the same keys;
   * burned, expired or absent gives no token, and Pen's status settles the record.
   */
  const reissueOpen = Effect.fn("DisposableAttach.reissueOpen")(function* (
    row: Row,
    open: AttachEffect,
  ) {
    const cancelled = yield* pen
      .cancel(refOf(open))
      .pipe(
        Effect.catch(() =>
          fail(
            "unknown_outcome",
            "Pen's answer to the cancel was lost. Refresh the machine list, then reissue as a new request.",
          ),
        ),
      );
    const effects = replace(effectsOf(row), afterCancel(open, cancelled));
    if (cancelled !== "cancelled") {
      const settled = yield* settleRecord(yield* save(row, effects));
      return { outcome: "settled", status: status(settled, undefined, yield* knownKey) } as const;
    }
    const intent: AttachEffect = {
      id: row.attach_id + "." + (effects.length + 1),
      kind: "mint",
      state: "intent",
      expiresAtMs: (yield* Clock.currentTimeMillis) + INVITE_LIFETIME_MS,
    };
    const admitted = yield* admitMint(row, [...effects, intent]);
    if (admitted !== "admitted") {
      yield* save(row, effects);
      return yield* fail(admitted, refusalText[admitted]);
    }
    const fresh = yield* read(row.attach_id);
    if (fresh === undefined) return yield* storageFailed();
    return { outcome: "ok", status: yield* dispatchMint(fresh, intent) } as const;
  });

  /**
   * Reissue's checks that need neither Pen nor OpenCodex: the record, its provisioner, a replay of
   * this request, an open invite, and the invite limit. Run before the probes and again under the
   * attach lock; a replay answers the stored outcome.
   */
  const reissueGate = Effect.fn("DisposableAttach.reissueGate")(function* (
    attachId: string,
    caller: AttachCaller,
    requestKey: string,
  ) {
    const row = yield* read(attachId);
    if (row === undefined) return yield* fail("not_found", "No attach has that id.");
    if (
      !sameProvisioner(provisionerOf(row), caller.provisioner) &&
      caller.provisioner.kind !== "person"
    )
      return yield* fail(
        "provisioner_refused",
        "Only the provisioner or a person may reissue this invite.",
      );
    const [earlier] = yield* sql<{
      readonly attach_id: string;
      readonly outcome: string;
      readonly detail: string | null;
    }>`SELECT attach_id, outcome, detail FROM disposable_machine_requests
        WHERE request_key = ${requestKey}`.pipe(Effect.mapError(storageFailed));
    if (earlier !== undefined) {
      if (earlier.attach_id !== row.attach_id)
        return yield* fail("invalid_request", "This clientRequestId was used for another attach.");
      if (earlier.outcome === "ok" || earlier.outcome === "settled")
        return { replay: status(row, undefined, yield* knownKey) } as const;
      if (earlier.outcome === "running")
        return yield* fail(
          "unknown_outcome",
          "An earlier reissue with this request did not finish. Refresh the machine list, then reissue as a new request.",
        );
      return yield* new HubMachinesError({ reason: earlier.outcome, detail: earlier.detail ?? "" });
    }
    const open = openEffects(effectsOf(row));
    const latest = open.at(-1);
    if (
      row.pen_admitted_at !== null ||
      latest === undefined ||
      open.some((effect) => effect.withdrawn === true || effect.seen === "burned-without-admit")
    )
      return yield* fail("conflict", "Only an open invite can be reissued.");
    if (effectsOf(row).length >= MAX_INVITES_PER_ATTACH)
      return yield* fail("conflict", INVITES_USED);
    return { row, latest } as const;
  });

  const reissue = Effect.fn("DisposableAttach.reissue")(function* (
    caller: AttachCaller,
    principal: string,
    input: HubMachineReissueInput,
  ) {
    const requestKey = digest(principal + "\n" + input.clientRequestId);
    const before = yield* reissueGate(input.attachId, caller, requestKey);
    if ("replay" in before) return before.replay;
    // A closed switch or a new grant is refused before the probes, and both again under the lock.
    const current = yield* settingsNow;
    if (current === undefined) return yield* storageFailed();
    const gate = disposableSwitch(current.hub, yield* Clock.currentTimeMillis);
    if (!gate.open) return yield* fail(gate.reason, refusalText[gate.reason]);
    if (gate.grant !== before.row.grant_id)
      return yield* fail("switch_off", refusalText.switch_off);
    // Probed before the lock, which a slow ocx spawn would hold.
    yield* requireFeatures;
    return yield* exclusive(
      Effect.gen(function* () {
        const checked = yield* reissueGate(input.attachId, caller, requestKey);
        if ("replay" in checked) return checked.replay;
        const { row, latest } = checked;
        const ended = yield* authorityEnded(row, yield* settingsNow);
        if (ended !== undefined) return yield* fail(ended, refusalText[ended]);
        const now = yield* nowIso;
        yield* sql`INSERT INTO disposable_machine_requests ${sql.insert({
          request_key: requestKey,
          attach_id: row.attach_id,
          outcome: "running",
          detail: null,
          created_at: now,
          updated_at: now,
        })}`.pipe(Effect.mapError(storageFailed));
        const done = yield* reissueOpen(row, latest).pipe(
          Effect.tapError((error) => recordRequest(requestKey, error.reason, error.detail)),
        );
        yield* recordRequest(requestKey, done.outcome, null);
        return done.status;
      }),
    );
  });

  const list = Effect.fn("DisposableAttach.list")(function* (input: HubMachineListInput) {
    // A slow or wedged Pen delays the answer by LIST_WAIT at most; the pass goes on behind it.
    const pass =
      input.attachId === undefined
        ? shared("all", fullPass)
        : shared("one:" + input.attachId, settleOne(input.attachId));
    yield* Effect.flatMap(pass, Deferred.await).pipe(Effect.timeoutOption(LIST_WAIT));
    const rows =
      input.attachId === undefined
        ? yield* sql<Row>`SELECT * FROM disposable_machines ORDER BY created_at DESC LIMIT 200`.pipe(
            Effect.mapError(storageFailed),
          )
        : [yield* read(input.attachId)].filter((row) => row !== undefined);
    const key = yield* knownKey;
    return { machines: rows.map((row) => status(row, undefined, key)) };
  });

  const nodeOf = (attachId: string) => Effect.map(read(attachId), (row) => row?.node_id);

  return DisposableAttach.of({ attach, reissue, list, nodeOf, reconcile, enroll });
});

// Settles invites and withdraws ones whose authority ended, also when no client is reading.
const RECONCILE_EVERY = "30 seconds";

export const layer = Layer.effect(
  DisposableAttach,
  Effect.gen(function* () {
    const service = yield* make;
    yield* service.reconcile.pipe(
      Effect.repeat(Schedule.spaced(RECONCILE_EVERY)),
      Effect.forkScoped,
    );
    return service;
  }),
);
