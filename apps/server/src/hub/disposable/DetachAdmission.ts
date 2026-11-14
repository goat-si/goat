import {
  type HubMachineDetachInput,
  type HubMachineReleaseInput,
  HubMachinesError,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Settings from "../../serverSettings.ts";
import { makeAuthority } from "./attachAuthority.ts";
import { conflictCount } from "./attachModel.ts";
import {
  digest,
  fail,
  lockBound,
  provisionerOf,
  type Row,
  sameProvisioner,
  status,
  storageFailed,
} from "./attachRow.ts";
import type { AttachCaller } from "./DisposableAttach.ts";
import { type Detach, onlyHostKeyConflict, retires } from "./detachModel.ts";
import { decodeEnroll, encodeEnroll } from "./enrollModel.ts";
import { PenInvites } from "./PenInvites.ts";

const isMachinesError = Schema.is(HubMachinesError);
const NOT_PROVISIONER =
  "Only the thread that attached this machine, while the switch names it, or a person may detach it.";
// A withdrawn invite whose cancel went unanswered may still be live, so only unknown is released.
const RELEASABLE = new Set(["unknown"]);
/** Outcomes of a stopped retirement force that OpenCodex may still hold: open, unknown, or unread. */
const MAY_OWE = new Set(["open", "unsettled", "not_found", "unreadable", "retirement_owned"]);
// Pen refuses an invite, or a delayed mint, past its expiresAt: no join can follow after it.
const INVITE_LIFETIME_MS = 10 * 60 * 1000;
const DETACHABLE = new Set([
  "admitted",
  "attaching",
  "linked",
  "paused",
  "unknown",
  "retired",
  "returned",
  "detaching",
]);
/**
 * Who may start a detach or a release, and the one commit that starts it (design sections 3 and
 * 4); DisposableDetach's pass does the removal. Lock order: the attach lock, the settings lock, SQL.
 */
export const makeDetachAdmission = Effect.fn("DetachAdmission.make")(function* (
  exclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
) {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* Settings.ServerSettingsService;
  const pen = yield* PenInvites;
  const { unnamed } = yield* makeAuthority;
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const read = (attachId: string) =>
    sql<Row>`SELECT * FROM disposable_machines WHERE attach_id = ${attachId}`.pipe(
      Effect.map((rows) => rows[0]),
    );
  const audit = (attachId: string, action: string, outcome: string) =>
    Effect.flatMap(
      nowIso,
      (
        now,
      ) => sql`INSERT INTO audit_events (time, actor, profile, action, target, outcome, decision_id)
        VALUES (${now}, 'goat:disposable', 'hub', ${action}, ${attachId}, ${outcome}, NULL)`,
    );

  /**
   * Starts a detach (design section 3): the record's provisioner thread while the switch still
   * names it, or a person; force is a person's only. One commit fences the record (state
   * detaching, fence advanced), so no attach effect is admitted after it.
   */
  const detach = Effect.fn("DisposableDetach.detach")(function* (
    caller: AttachCaller,
    principal: string,
    input: HubMachineDetachInput,
  ) {
    // The operation comes first: no principal is a bare word, so no attach or reissue key, which is
    // principal, newline, id, can equal it whatever its id holds.
    const requestKey = digest("detach\n" + principal + "\n" + input.clientRequestId);
    const person = caller.provisioner.kind === "person";
    return yield* exclusive(
      Effect.gen(function* () {
        const row = yield* read(input.attachId).pipe(Effect.mapError(storageFailed));
        if (row === undefined) return yield* fail("not_found", "No attach has that id.");
        const [earlier] = yield* sql<{ readonly attach_id: string }>`SELECT attach_id
          FROM disposable_machine_requests WHERE request_key = ${requestKey}`.pipe(
          Effect.mapError(storageFailed),
        );
        if (earlier !== undefined) {
          if (earlier.attach_id !== row.attach_id)
            return yield* fail(
              "invalid_request",
              "This clientRequestId was used for another attach.",
            );
          return status(row);
        }
        if (!person && !sameProvisioner(provisionerOf(row), caller.provisioner))
          return yield* fail("provisioner_refused", NOT_PROVISIONER);
        if (input.force === true && !person)
          return yield* fail(
            "person_required",
            "Only a person forces a detach: it removes the link without the machine.",
          );
        if (row.final_at !== null || row.pen_admitted_at === null || !DETACHABLE.has(row.state))
          return yield* fail(
            "conflict",
            "Only an admitted machine whose record is open can be detached.",
          );
        // Force never contacts the machine, so a person may force past a changed host key.
        const forcePastHostKey =
          person && input.force === true && onlyHostKeyConflict(row.conflicts_json);
        if (conflictCount(row.conflicts_json) > 0 && !forcePastHostKey)
          return yield* fail(
            "conflict",
            onlyHostKeyConflict(row.conflicts_json)
              ? "The machine presents another SSH host key; only a person's force detaches it, in Settings → Hub on web or desktop."
              : "A conflict stopped this record, so detach cannot run; a person removes the machine from Pen with pen revoke.",
          );
        if (row.environment_id !== null)
          return yield* fail(
            "hold_unsupported",
            "This machine runs GOAT, and this version cannot hold its work before a detach.",
          );
        const enroll = decodeEnroll(row.enroll_json);
        const known = enroll.detach;
        const stepFor =
          row.state === "retired"
            ? "recover"
            : row.link_id !== null
              ? "revoke"
              : row.link_operation_id !== null
                ? "settle"
                : "done";
        const { stop: _stop, ...stopless } = known ?? { step: stepFor, attempt: 0 };
        // A person's detach or force buys one more resend of a revoke recover found pending.
        const { pendingResent: _pending, ...repending } = stopless;
        const kept = person ? repending : stopless;
        // A person's force starts its sends afresh and reads the stored id again before any stop;
        // an open purge stays, as OpenCodex refuses any other revoke while it is open, and so does
        // a resolve still owed.
        const { sends: _sends, outcome, ...rest } = kept;
        const fresh =
          outcome === "open" || outcome === "resolve_owed" ? { ...rest, outcome } : rest;
        // A revoke OpenCodex left open or never recorded goes again under its id after a detach, as
        // does one refused for an unfinished removal: GOAT then repeats its own earlier one again.
        const resend =
          (known?.stop === "revoke_unsettled" &&
            (outcome === "open" || outcome === "not_found" || outcome === "unreadable")) ||
          known?.stop === "link_retirement_owned";
        // A stopped retirement force goes on under its id for a person while OpenCodex may still
        // hold it or the machine fails, and for anyone once the failures would retire it. Below
        // that, an agent neither goes on with a removal without the machine nor drops its id.
        const failing = (enroll.health?.failures ?? 0) > 0;
        const retiring = retires(enroll.health, yield* Clock.currentTimeMillis);
        const stoppedForce =
          row.state === "linked" && known?.force === true && known.stop !== undefined;
        const mayOwe = outcome !== undefined && MAY_OWE.has(outcome);
        if (stoppedForce && mayOwe && !person && !retiring)
          return yield* fail(
            "person_required",
            "This machine's removal without it is unfinished in OpenCodex; only a person goes on with it, in Settings → Hub on web or desktop.",
          );
        const retirement = stoppedForce && (person ? mayOwe || failing : retiring);
        // Not read since it stopped, on a machine that answers: the force step reads it first.
        const check =
          retirement && !failing && (outcome === "not_found" || outcome === "unreadable");
        const next: Detach =
          row.state === "detaching" || row.state === "retired"
            ? input.force === true
              ? { ...fresh, force: true as const }
              : resend
                ? fresh
                : kept
            : retirement
              ? { ...fresh, force: true as const, ...(check ? { outcome: "check" } : {}) }
              : {
                  step: stepFor,
                  attempt: known?.attempt ?? 0,
                  ...(input.force === true ? { force: true as const } : {}),
                };
        const now = yield* nowIso;
        const commit = sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO disposable_machine_requests ${sql.insert({
                request_key: requestKey,
                attach_id: row.attach_id,
                outcome: "ok",
                detail: null,
                created_at: now,
                updated_at: now,
              })}`;
              return yield* sql<Row>`UPDATE disposable_machines SET ${sql.update({
                state: "detaching",
                step: "detach",
                fence: row.fence + 1,
                enroll_json: encodeEnroll({ ...enroll, detach: next }),
                ...(row.state === "detaching" ? {} : { state_since: now }),
                updated_at: now,
              })} WHERE attach_id = ${row.attach_id} AND fence = ${row.fence} RETURNING *`;
            }),
          )
          .pipe(Effect.mapError(storageFailed));
        // A thread's consent is read under the settings lock a person's change takes.
        const saved = person
          ? yield* commit
          : yield* settings
              .withSettingsSnapshot((locked) =>
                unnamed(row, locked) ? fail("provisioner_refused", NOT_PROVISIONER) : commit,
              )
              .pipe(
                lockBound,
                Effect.mapError((error) => (isMachinesError(error) ? error : storageFailed())),
              );
        const updated = saved[0];
        if (updated === undefined)
          return yield* fail("conflict", "The record changed; read it and detach again.");
        yield* audit(
          row.attach_id,
          "hub.machine_detach",
          input.force === true ? "requested:force" : "requested",
        ).pipe(Effect.mapError(storageFailed));
        return status(updated);
      }),
    );
  });

  /**
   * A person frees the slot of an attach whose invite Pen lost or used without a saved admit
   * (state unknown, no admit), once its invite expired and Pen's member list shows the key absent.
   */
  const release = Effect.fn("DisposableDetach.release")(function* (
    caller: AttachCaller,
    principal: string,
    input: HubMachineReleaseInput,
  ) {
    if (caller.provisioner.kind !== "person")
      return yield* fail(
        "person_required",
        "Only a person releases an attach whose outcome Pen cannot tell.",
      );
    const requestKey = digest("release\n" + principal + "\n" + input.clientRequestId);
    return yield* exclusive(
      Effect.gen(function* () {
        const row = yield* read(input.attachId).pipe(Effect.mapError(storageFailed));
        if (row === undefined) return yield* fail("not_found", "No attach has that id.");
        const [earlier] = yield* sql<{ readonly attach_id: string }>`SELECT attach_id
          FROM disposable_machine_requests WHERE request_key = ${requestKey}`.pipe(
          Effect.mapError(storageFailed),
        );
        if (earlier !== undefined) {
          if (earlier.attach_id !== row.attach_id)
            return yield* fail(
              "invalid_request",
              "This clientRequestId was used for another attach.",
            );
          return status(row);
        }
        if (row.final_at !== null || row.pen_admitted_at !== null || !RELEASABLE.has(row.state))
          return yield* fail(
            "conflict",
            "Only an attach Pen admitted nobody for, whose outcome it cannot tell, can be released.",
          );
        const usableUntil =
          row.invite_expires_at === null
            ? Date.parse(row.created_at) + INVITE_LIFETIME_MS
            : Date.parse(row.invite_expires_at);
        if (!(usableUntil < (yield* Clock.currentTimeMillis)))
          return yield* fail(
            "conflict",
            "Its invite can still be used; release it once the invite has expired.",
          );
        const enroll = decodeEnroll(row.enroll_json);
        // The machine may have joined before its invite expired: Pen's view is read twice, as the
        // removal settle reads it, and a key found there keeps its slot.
        const first = yield* pen.members;
        const second = yield* pen.members;
        if (first === undefined || second === undefined)
          return yield* fail(
            "pen_unavailable",
            "Pen's member list could not be read, so nothing was released; try again.",
          );
        if (first.has(row.expected_sign_pub) || second.has(row.expected_sign_pub)) {
          const joinedAt = yield* nowIso;
          yield* sql`UPDATE disposable_machines SET ${sql.update({
            pen_admitted_at: joinedAt,
            pen_removed_at: null,
            fence: row.fence + 1,
            enroll_json: encodeEnroll({ ...enroll, stop: "joined_without_admit" }),
            updated_at: joinedAt,
          })} WHERE attach_id = ${row.attach_id} AND fence = ${row.fence}`.pipe(
            Effect.mapError(storageFailed),
          );
          yield* audit(row.attach_id, "hub.machine_release", "refused:joined").pipe(
            Effect.mapError(storageFailed),
          );
          return yield* fail(
            "conflict",
            "The machine joined Pen after all, so it keeps its slot: detach it to remove what it left, and remove it from Pen with pen revoke to free the slot.",
          );
        }
        const now = yield* nowIso;
        const saved = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO disposable_machine_requests ${sql.insert({
                request_key: requestKey,
                attach_id: row.attach_id,
                outcome: "ok",
                detail: null,
                created_at: now,
                updated_at: now,
              })}`;
              return yield* sql<Row>`UPDATE disposable_machines SET ${sql.update({
                state: "failed",
                step: "released",
                final_at: now,
                fence: row.fence + 1,
                enroll_json: encodeEnroll({
                  ...enroll,
                  detach: { step: "done", attempt: 0, outcome: "released" },
                }),
                state_since: now,
                updated_at: now,
              })} WHERE attach_id = ${row.attach_id} AND fence = ${row.fence} RETURNING *`;
            }),
          )
          .pipe(Effect.mapError(storageFailed));
        const updated = saved[0];
        if (updated === undefined)
          return yield* fail("conflict", "The record changed; read it and release again.");
        yield* audit(row.attach_id, "hub.machine_release", "released").pipe(
          Effect.mapError(storageFailed),
        );
        return status(updated);
      }),
    );
  });

  return { detach, release };
});
