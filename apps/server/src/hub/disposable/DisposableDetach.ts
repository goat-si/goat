import {
  type HubMachineDetachInput,
  type HubMachineReleaseInput,
  HubMachinesError,
  type HubMachineStatus,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { OcxOutput } from "../HubOcx.ts";
import { makeAuthority } from "./attachAuthority.ts";
import { conflictCount } from "./attachModel.ts";
import {
  type Columns,
  digest,
  fail,
  provisionerOf,
  type Row,
  sameProvisioner,
  status,
  storageFailed,
} from "./attachRow.ts";
import type { AttachCaller } from "./DisposableAttach.ts";
import {
  CHECK_EVERY_MS,
  CHILD_REFUSALS,
  type Detach,
  type Health,
  linkKeyState,
  readRevoke,
  recoverAnswer,
  retires,
  REVOKE_SENDS,
  revokeOperationId,
} from "./detachModel.ts";
import { EnrollHost } from "./EnrollHost.ts";
import {
  decodeEnroll,
  decodeRoute,
  type Enroll,
  encodeEnroll,
  OPERATION_REPLAY_MS,
  readOperation,
} from "./enrollModel.ts";
import { MachineKey } from "./machineKey.ts";
import { disposableKnownHosts } from "./routeContract.ts";

// A revoke reaches the Child over ssh like an enrollment; the margin lets ocx report first.
const REVOKE_TIMEOUT_MS = 400_000;
const READ_TIMEOUT_MS = 30_000;
const DETACH_LIMIT = 100;
const DETACH_CONCURRENCY = 4;
const encodeConflicts = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const RELEASABLE = new Set(["unknown", "paused"]);
/** Answers that leave the revoke's own id to be sent again, as OpenCodex asks. */
const REPEAT = new Set(["open", "unsettled", "not_found", "unreadable"]);
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
 * Design section 3: a journalled purge removes the link and Child; 24 silent hours or a person's
 * force remove the link without the machine (a tombstone) and recover cleans it once it answers.
 * No lock is held across ssh or ocx; the machine key is never removed, as links and tombstones
 * name its path.
 */
export const makeDetach = Effect.fn("DisposableDetach.make")(function* (
  exclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
) {
  const sql = yield* SqlClient.SqlClient;
  const host = yield* EnrollHost;
  const machineKey = yield* MachineKey;
  const { unnamed, settingsNow } = yield* makeAuthority;
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const running = yield* Ref.make<ReadonlySet<string>>(new Set());

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
  /** Stores what GOAT observed under the record's fence; false when another step moved it. */
  const note = Effect.fn("DisposableDetach.note")(function* (
    row: Row,
    enroll: Enroll,
    columns: Columns = {},
  ) {
    return yield* exclusive(
      Effect.gen(function* () {
        const now = yield* nowIso;
        const state = typeof columns.state === "string" ? columns.state : row.state;
        const saved = yield* sql`UPDATE disposable_machines SET ${sql.update({
          ...columns,
          enroll_json: encodeEnroll(enroll),
          ...(state === row.state ? {} : { state_since: now }),
          updated_at: now,
        })} WHERE attach_id = ${row.attach_id} AND fence = ${row.fence} RETURNING attach_id`;
        return saved.length === 1;
      }),
    );
  });
  const withDetach = (enroll: Enroll, detach: Detach): Enroll => ({ ...enroll, detach });

  /** The link and Child are gone: GOAT's files for the machine go, and the record ends purged. */
  const finish = Effect.fn("DisposableDetach.finish")(function* (
    row: Row,
    enroll: Enroll,
    outcome: "purged" | "forgotten",
  ) {
    yield* host.forgetKnownHosts(row.attach_id);
    const detach = { ...(enroll.detach ?? { step: "done", attempt: 0 }), step: "done", outcome };
    if (
      yield* note(row, withDetach(enroll, detach), {
        state: "purged",
        step: "purged",
        final_at: yield* nowIso,
        link_id: null,
        link_operation_id: null,
      })
    )
      yield* audit(row.attach_id, "hub.machine_detach", outcome);
  });

  /** Counts one failed handshake; the run starts at the first failure after an answer. */
  const failed = (health: Health | undefined, nowMs: number): Health => ({
    failures: (health?.failures ?? 0) + 1,
    firstFailureAtMs: health?.firstFailureAtMs ?? nowMs,
    checkedAtMs: nowMs,
  });

  /**
   * Removes the link without the machine (ocx link revoke --force under its own operation id): a
   * tombstone keeps what recover needs, and the record waits on step recover.
   */
  const forceStep = Effect.fn("DisposableDetach.force")(function* (row: Row, enroll: Enroll) {
    const linkId = row.link_id;
    const before = enroll.detach ?? { step: "revoke", attempt: 0 };
    if (linkId === null)
      return yield* note(row, withDetach(enroll, { ...before, step: "recover" }));
    const repeat =
      before.force === true &&
      before.operationId?.includes(".force.") === true &&
      REPEAT.has(before.outcome ?? "");
    if (repeat && (before.sends ?? 1) >= REVOKE_SENDS)
      return yield* note(row, withDetach(enroll, { ...before, stop: "revoke_unsettled" }));
    const attempt = repeat ? before.attempt : before.attempt + 1;
    const operationId =
      repeat && before.operationId !== undefined
        ? before.operationId
        : revokeOperationId(row.attach_id, "force", attempt);
    const admitted: Detach = {
      step: "revoke",
      attempt,
      operationId,
      sends: repeat ? (before.sends ?? 1) + 1 : 1,
      force: true,
      triedAtMs: yield* Clock.currentTimeMillis,
    };
    const retire = row.state === "linked";
    // The id is stored before ocx starts, so a lost answer is read back, never sent anew.
    if (!(yield* note(row, withDetach(enroll, admitted)))) return;
    const sent = yield* host.ocx(
      [
        "link",
        "revoke",
        "--link-id",
        linkId,
        "--force",
        "--yes",
        "--operation-id",
        operationId,
        "--json",
      ],
      REVOKE_TIMEOUT_MS,
    );
    const outcome =
      sent?.refusal?.code === "link_not_found"
        ? ({ kind: "clean" } as const)
        : readRevoke(
            yield* host.ocx(
              ["link", "operations", "--operation-id", operationId, "--json"],
              READ_TIMEOUT_MS,
            ),
            { operationId, linkId, force: true },
          );
    const columns: Columns = retire ? { state: "retired", step: "recover" } : {};
    if (outcome.kind === "clean") {
      if (yield* note(row, withDetach(enroll, { ...admitted, step: "recover" }), columns))
        yield* audit(row.attach_id, "hub.machine_detach", retire ? "retired" : "forced");
      return;
    }
    if (outcome.kind === "failed_clean" || sent?.refusal?.code === "tombstone_limit") {
      const code =
        sent?.refusal?.code ?? (outcome.kind === "failed_clean" ? outcome.code : "failed");
      return yield* note(
        row,
        withDetach(enroll, {
          ...admitted,
          outcome: code,
          stop: code === "tombstone_limit" ? "tombstone_limit" : "revoke_refused",
        }),
      );
    }
    yield* note(row, withDetach(enroll, { ...admitted, outcome: outcome.kind }));
  });

  /** A journalled purge revoke; clean only with the Child's purged receipt for this link id. */
  const revokeStep = Effect.fn("DisposableDetach.revoke")(function* (row: Row, enroll: Enroll) {
    const before = enroll.detach ?? { step: "revoke", attempt: 0 };
    const linkId = row.link_id;
    if (linkId === null) return yield* note(row, withDetach(enroll, { ...before, step: "done" }));
    if (before.force === true) return yield* forceStep(row, enroll);
    const nowMs = yield* Clock.currentTimeMillis;
    if (
      before.outcome === "unreachable" &&
      before.triedAtMs !== undefined &&
      nowMs - before.triedAtMs < CHECK_EVERY_MS
    )
      return;
    const repeat = REPEAT.has(before.outcome ?? "") && before.operationId !== undefined;
    if (repeat && (before.sends ?? 1) >= REVOKE_SENDS)
      return yield* note(row, withDetach(enroll, { ...before, stop: "revoke_unsettled" }));
    const attempt = repeat ? before.attempt : before.attempt + 1;
    const operationId =
      repeat && before.operationId !== undefined
        ? before.operationId
        : revokeOperationId(row.attach_id, "purge", attempt);
    const admitted: Detach = {
      step: "revoke",
      attempt,
      operationId,
      sends: repeat ? (before.sends ?? 1) + 1 : 1,
      triedAtMs: nowMs,
    };
    if (!(yield* note(row, withDetach(enroll, admitted)))) return;
    const sent = yield* host.ocx(
      ["link", "revoke", "--link-id", linkId, "--purge", "--operation-id", operationId, "--json"],
      REVOKE_TIMEOUT_MS,
    );
    // Removed without a purge receipt: someone else revoked it, so recover proves the Child clean.
    if (sent?.refusal?.code === "link_not_found")
      return yield* note(
        row,
        withDetach(enroll, { ...admitted, step: "recover", outcome: "link_not_found" }),
      );
    const outcome = readRevoke(
      yield* host.ocx(
        ["link", "operations", "--operation-id", operationId, "--json"],
        READ_TIMEOUT_MS,
      ),
      { operationId, linkId, force: false },
    );
    switch (outcome.kind) {
      case "clean":
        return yield* finish(row, withDetach(enroll, admitted), "purged");
      case "failed_clean": {
        if (outcome.code !== "remote_disconnect_failed")
          return yield* note(
            row,
            withDetach(enroll, { ...admitted, outcome: outcome.code, stop: "revoke_refused" }),
          );
        const hint = sent?.refusal?.hint;
        if (hint !== undefined && CHILD_REFUSALS.has(hint))
          return yield* note(
            row,
            withDetach(enroll, { ...admitted, outcome: outcome.code, stop: "revoke_" + hint }),
          );
        // No answer from the machine: the next try waits 30 minutes, and 24 silent hours force.
        const health = failed(enroll.health, nowMs);
        const waiting = { ...enroll, health };
        if (retires(health, nowMs))
          return yield* forceStep(
            row,
            withDetach(waiting, { ...admitted, outcome: "unreachable" }),
          );
        return yield* note(row, withDetach(waiting, { ...admitted, outcome: "unreachable" }));
      }
      default:
        return yield* note(row, withDetach(enroll, { ...admitted, outcome: outcome.kind }));
    }
  });

  /** Reads what the record's last link operation left before a link it cannot name is removed. */
  const settleStep = Effect.fn("DisposableDetach.settle")(function* (row: Row, enroll: Enroll) {
    const before = enroll.detach ?? { step: "settle", attempt: 0 };
    const operationId = row.link_operation_id;
    if (operationId === null)
      return yield* note(row, withDetach(enroll, { ...before, step: "done" }));
    const answer = yield* host.ocx(
      ["link", "operations", "--operation-id", operationId, "--json"],
      READ_TIMEOUT_MS,
    );
    const outcome =
      answer === undefined
        ? ({ kind: "unreadable" } as const)
        : readOperation(answer, { operationId, alias: `pen-${row.node_id}` });
    const fresh =
      (yield* Clock.currentTimeMillis) - (enroll.link?.intentAtMs ?? 0) < OPERATION_REPLAY_MS;
    switch (outcome.kind) {
      case "committed":
        return yield* note(row, withDetach(enroll, { ...before, step: "revoke" }), {
          link_id: outcome.linkId,
        });
      case "failed_clean":
        return yield* note(row, withDetach(enroll, { ...before, step: "done" }), {
          link_operation_id: null,
        });
      case "not_found":
        if (fresh && (yield* host.journalServed))
          return yield* note(row, withDetach(enroll, { ...before, step: "done" }), {
            link_operation_id: null,
          });
        return yield* note(row, withDetach(enroll, { ...before, stop: "link_unsettled" }));
      case "unsettled":
        return yield* note(row, withDetach(enroll, { ...before, stop: "link_unsettled" }));
      default:
        return;
    }
  });

  /** ocx link recover every 30 minutes until the tombstone settles; refusals are waits with a text. */
  const recoverStep = Effect.fn("DisposableDetach.recover")(function* (row: Row, enroll: Enroll) {
    const before = enroll.detach ?? { step: "recover", attempt: 0 };
    const linkId = row.link_id;
    if (linkId === null) return yield* finish(row, enroll, "purged");
    const nowMs = yield* Clock.currentTimeMillis;
    if (before.triedAtMs !== undefined && nowMs - before.triedAtMs < CHECK_EVERY_MS) return;
    const answer = recoverAnswer(
      yield* host.ocx(["link", "recover", "--link-id", linkId, "--json"], REVOKE_TIMEOUT_MS),
      linkId,
    );
    const tried: Detach = { ...before, triedAtMs: nowMs, outcome: answer };
    if (answer === "clean" || answer === "tombstone_not_found") {
      const outcome = answer === "clean" ? "purged" : "forgotten";
      if (row.state === "retired" && answer === "clean") {
        if (
          yield* note(row, withDetach(enroll, { ...tried, step: "done" }), {
            state: "returned",
            step: "returned",
            link_id: null,
            link_operation_id: null,
          })
        )
          yield* audit(row.attach_id, "hub.machine_detach", "returned");
        return;
      }
      return yield* finish(row, withDetach(enroll, tried), outcome);
    }
    if (answer === "link_present")
      return yield* note(row, withDetach(enroll, { ...tried, step: "revoke" }));
    if (answer === "link_retirement_pending")
      return yield* note(
        row,
        withDetach(enroll, { ...tried, step: "revoke", force: true, outcome: "unsettled" }),
      );
    if (answer === "host_key_changed")
      return yield* note(
        row,
        { ...withDetach(enroll, tried), stop: "host_key_changed" },
        {
          conflicts_json: encodeConflicts(["host_key_changed"]),
        },
      );
    yield* note(row, withDetach(enroll, tried));
  });

  /**
   * A linked machine's handshake every 30 minutes (design section 3, Retirement): an answer resets
   * the count, 48 failures over 24 hours retire it, and the link's key path is checked against the
   * current one, which a moved GOAT home leaves behind.
   */
  const healthStep = Effect.fn("DisposableDetach.health")(function* (
    row: Row,
    enroll: Enroll,
    status: Effect.Effect<OcxOutput | undefined>,
  ) {
    const nowMs = yield* Clock.currentTimeMillis;
    if (enroll.health !== undefined && nowMs - enroll.health.checkedAtMs < CHECK_EVERY_MS) return;
    const route = decodeRoute(row.route_json);
    const line = route === undefined ? undefined : disposableKnownHosts(row.node_id, route.hostKey);
    const key = yield* machineKey.identity.pipe(Effect.option);
    if (route === undefined || line === undefined || key._tag === "None") return;
    const pinned = yield* host.knownHosts(row.attach_id, line).pipe(Effect.option);
    if (pinned._tag === "None") return;
    const reached = yield* host.reach({
      nodeId: row.node_id,
      noisePub: row.expected_noise_pub,
      proxyCommand: route.proxyCommand,
      user: route.user,
      knownHostsFile: pinned.value,
      identityFile: key.value.privateKeyFile,
    });
    if (reached === "host_key_changed")
      return yield* note(
        row,
        { ...enroll, stop: "host_key_changed" },
        {
          conflicts_json: encodeConflicts(["host_key_changed"]),
        },
      );
    if (reached !== "ok") {
      const health = failed(enroll.health, nowMs);
      if (retires(health, nowMs)) return yield* forceStep(row, { ...enroll, health });
      return yield* note(row, { ...enroll, health });
    }
    const keyState =
      row.link_id === null
        ? "unknown"
        : linkKeyState(yield* status, row.link_id, key.value.privateKeyFile);
    const { linkKeyMoved: _moved, ...rest } = enroll;
    yield* note(row, {
      ...rest,
      ...(keyState === "moved" ? { linkKeyMoved: true as const } : {}),
      health: { failures: 0, checkedAtMs: nowMs },
    });
  });

  const step = Effect.fn("DisposableDetach.step")(function* (
    row: Row,
    status: Effect.Effect<OcxOutput | undefined>,
  ) {
    if (row.final_at !== null || conflictCount(row.conflicts_json) > 0) return;
    const enroll = decodeEnroll(row.enroll_json);
    if (row.state === "linked") return yield* healthStep(row, enroll, status);
    const detach = enroll.detach;
    if (detach?.stop !== undefined && detach.force !== true) return;
    if (row.state === "retired") return yield* recoverStep(row, enroll);
    if (row.state !== "detaching") return;
    switch (detach?.step) {
      case "settle":
        return yield* settleStep(row, enroll);
      case "recover":
        return yield* recoverStep(row, enroll);
      case "done":
        return yield* finish(row, enroll, "purged");
      default:
        return yield* revokeStep(row, enroll);
    }
  });

  const advance = Effect.fn("DisposableDetach.advance")(function* (
    attachId: string,
    status: Effect.Effect<OcxOutput | undefined>,
  ) {
    const claimed = yield* Ref.modify(running, (set) =>
      set.has(attachId) ? [false, set] : [true, new Set([...set, attachId])],
    );
    if (!claimed) return;
    yield* Effect.flatMap(read(attachId), (row) =>
      row === undefined ? Effect.void : step(row, status),
    ).pipe(
      Effect.ensuring(
        Ref.update(running, (set) => new Set([...set].filter((id) => id !== attachId))),
      ),
    );
  });

  /** One pass over linked, detaching and retired records; one record's failure never stops the rest. */
  const pass = Effect.gen(function* () {
    const due = yield* sql<{ readonly attach_id: string }>`SELECT attach_id FROM disposable_machines
      WHERE final_at IS NULL AND state IN ('linked', 'detaching', 'retired')
      ORDER BY created_at LIMIT ${DETACH_LIMIT}`;
    // One read of the Home's links serves every linked record's key check in the pass.
    const status = yield* Effect.cached(host.ocx(["link", "status", "--json"], READ_TIMEOUT_MS));
    yield* Effect.forEach(
      due,
      ({ attach_id }) =>
        advance(attach_id, status).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Disposable machine detach step failed", Cause.squash(cause)),
          ),
        ),
      { concurrency: DETACH_CONCURRENCY, discard: true },
    );
  }).pipe(Effect.withSpan("DisposableDetach.pass"));

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
    const requestKey = digest(principal + "\n" + input.clientRequestId);
    const person = caller.provisioner.kind === "person";
    const current = person ? undefined : yield* settingsNow;
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
        if (
          !person &&
          (!sameProvisioner(provisionerOf(row), caller.provisioner) ||
            current === undefined ||
            unnamed(row, current))
        )
          return yield* fail(
            "provisioner_refused",
            "Only the thread that attached this machine, while the switch names it, or a person may detach it.",
          );
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
        if (conflictCount(row.conflicts_json) > 0)
          return yield* fail(
            "conflict",
            "A conflict blocks the detach; a person resolves it first.",
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
        const { stop: _stop, ...kept } = known ?? { step: stepFor, attempt: 0 };
        const next: Detach =
          row.state === "detaching" || row.state === "retired"
            ? { ...kept, ...(input.force === true ? { force: true as const } : {}) }
            : {
                step: stepFor,
                attempt: known?.attempt ?? 0,
                ...(input.force === true ? { force: true as const } : {}),
              };
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
   * (state unknown, or paused with no admit). The machine may have joined anyway; the text says so.
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
    const requestKey = digest(principal + "\n" + input.clientRequestId);
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
        const enroll = decodeEnroll(row.enroll_json);
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

  return { detach, release, pass, advance } satisfies {
    readonly detach: (
      caller: AttachCaller,
      principal: string,
      input: HubMachineDetachInput,
    ) => Effect.Effect<HubMachineStatus, HubMachinesError>;
    readonly release: (
      caller: AttachCaller,
      principal: string,
      input: HubMachineReleaseInput,
    ) => Effect.Effect<HubMachineStatus, HubMachinesError>;
    readonly pass: Effect.Effect<void, unknown>;
    readonly advance: (
      attachId: string,
      status: Effect.Effect<OcxOutput | undefined>,
    ) => Effect.Effect<void, unknown>;
  };
});
