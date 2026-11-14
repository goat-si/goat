import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { OcxOutput } from "../HubOcx.ts";
import { conflictCount } from "./attachModel.ts";
import { type Columns, OWES_ACK, type Row } from "./attachRow.ts";
import {
  CHECK_EVERY_MS,
  CHILD_REFUSALS,
  type Detach,
  type Health,
  linkKeyState,
  linkByAlias,
  onlyHostKeyConflict,
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
  STALE_OPEN_MS,
} from "./enrollModel.ts";
import { MachineKey } from "./machineKey.ts";
import { PenInvites } from "./PenInvites.ts";
import { disposableKnownHosts } from "./routeContract.ts";

// A revoke reaches the Child over ssh like an enrollment; the margin lets ocx report first.
const REVOKE_TIMEOUT_MS = 400_000;
const READ_TIMEOUT_MS = 30_000;
const DETACH_LIMIT = 100;
const DETACH_CONCURRENCY = 4;
const RETENTION_DAYS = 30;
const PRUNE_LIMIT = 100;
const Conflicts = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeConflicts = Schema.encodeSync(Conflicts);
/** Answers that leave the revoke's own id to be sent again, as OpenCodex asks. */
const REPEAT = new Set(["open", "not_found", "unreadable"]);

/**
 * Design section 3: a journalled purge removes the link and Child; 24 silent hours or a person's
 * force remove the link without the machine (a tombstone) and recover cleans it once it answers.
 * No lock is held across ssh or ocx; the machine key is never removed, as links and tombstones
 * name its path.
 */
export const makeDetach = Effect.fn("DisposableDetach.make")(function* (
  exclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
  /** Whether an enrollment step of the record runs now (DisposableEnroll.busy). */
  enrolling: (attachId: string) => Effect.Effect<boolean>,
  limit = DETACH_LIMIT,
) {
  const sql = yield* SqlClient.SqlClient;
  const host = yield* EnrollHost;
  const machineKey = yield* MachineKey;
  const pen = yield* PenInvites;
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const running = yield* Ref.make<ReadonlySet<string>>(new Set());
  const cursor = yield* Ref.make("");

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
  const withoutTry = ({ triedAtMs: _tried, ...rest }: Detach): Detach => rest;

  /** The link and Child are gone: GOAT's files for the machine go, and the record ends purged. */
  const finish = Effect.fn("DisposableDetach.finish")(function* (
    row: Row,
    enroll: Enroll,
    outcome: "purged" | "forgotten" | "elsewhere" | "unproven",
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

  /**
   * A failed check counts only while Pen answers for the machine: a hub cut off from its Pen would
   * otherwise retire every linked machine after 24 hours. The wait between checks runs either way.
   */
  const failedCheck = Effect.fn("DisposableDetach.failedCheck")(function* (
    row: Row,
    health: Health | undefined,
    nowMs: number,
  ) {
    const penAnswers =
      (yield* host.route({ nodeId: row.node_id, noisePub: row.expected_noise_pub })) !== undefined;
    return penAnswers
      ? failed(health, nowMs)
      : { ...(health ?? { failures: 0 }), checkedAtMs: nowMs };
  });
  /** Counts one failed handshake; the run starts at the first failure after an answer. */
  const failed = (health: Health | undefined, nowMs: number): Health => ({
    failures: (health?.failures ?? 0) + 1,
    firstFailureAtMs: health?.firstFailureAtMs ?? nowMs,
    checkedAtMs: nowMs,
  });

  /** A detach that waits for a person; the audit row follows only a stop the record kept. */
  const halt = Effect.fn("DisposableDetach.halt")(function* (
    row: Row,
    enroll: Enroll,
    detach: Detach,
    stop: string,
  ) {
    if (yield* note(row, withDetach(enroll, { ...detach, stop })))
      yield* audit(row.attach_id, "hub.machine_detach", "stopped:" + stop);
  });

  /** A changed SSH host key: every step stops until a person forces the detach. */
  const hostKeyConflict = Effect.fn("DisposableDetach.hostKeyConflict")(function* (
    row: Row,
    enroll: Enroll,
  ) {
    const saved = yield* note(
      row,
      { ...enroll, stop: "host_key_changed" },
      { conflicts_json: encodeConflicts(["host_key_changed"]) },
    );
    if (saved) yield* audit(row.attach_id, "hub.machine_detach", "conflict:host_key_changed");
  });

  /**
   * Marks a purge id GOAT gave up on resolved, so the Home keeps no trail of unknown entries: it
   * holds at most 256 unsettled ones and then refuses every link operation. An entry that is not
   * unknown or residual, or is gone, needs nothing; any other failure waits for the next pass.
   */
  const resolveSuperseded = Effect.fn("DisposableDetach.resolveSuperseded")(function* (
    operationId: string,
  ) {
    const answer = yield* host.ocx(
      ["link", "operations", "resolve", "--operation-id", operationId, "--yes", "--json"],
      READ_TIMEOUT_MS,
    );
    return answer !== undefined && (answer.code === 0 || answer.code === 4 || answer.code === 5);
  });
  const readEntry = (operationId: string, linkId: string, force: boolean) =>
    Effect.map(
      host.ocx(["link", "operations", "--operation-id", operationId, "--json"], READ_TIMEOUT_MS),
      (answer) => readRevoke(answer, { operationId, linkId, force }),
    );

  /**
   * Removes the link without the machine (ocx link revoke --force under its own operation id): a
   * tombstone keeps what recover needs, and the record waits on step recover. A stored forced id is
   * read first: committed goes on, a settled refusal or a resolved entry gets a new id (tombstone_limit
   * repeats its own id once first, as OpenCodex asks), anything else is resumed under its id.
   */
  const forceStep = Effect.fn("DisposableDetach.force")(function* (row: Row, enroll: Enroll) {
    const linkId = row.link_id;
    const before = enroll.detach ?? { step: "revoke", attempt: 0 };
    const retire = row.state === "linked";
    const recovering: Columns = retire ? { state: "retired", step: "recover" } : {};
    if (linkId === null)
      return yield* note(row, withDetach(enroll, { ...before, step: "recover" }), recovering);
    const stored =
      before.operationId?.includes(".force.") === true ? before.operationId : undefined;
    let reuse = false;
    if (stored !== undefined) {
      const known = yield* readEntry(stored, linkId, true);
      if (known.kind === "clean") {
        if (yield* note(row, withDetach(enroll, { ...before, step: "recover" }), recovering))
          yield* audit(row.attach_id, "hub.machine_detach", retire ? "retired" : "forced");
        return;
      }
      reuse =
        known.kind === "failed_clean"
          ? known.code === "tombstone_limit" && (before.sends ?? 0) < 2
          : known.kind === "unsettled"
            ? !known.resolved
            : true;
      if (reuse && (before.sends ?? 0) >= REVOKE_SENDS)
        return yield* halt(row, enroll, before, "revoke_unsettled");
    } else if (before.operationId !== undefined && before.outcome === "unreachable") {
      // The purge this force supersedes stays unknown on the Home until resolved.
      if (!(yield* resolveSuperseded(before.operationId))) return;
    }
    const attempt = reuse ? before.attempt : before.attempt + 1;
    const operationId =
      reuse && stored !== undefined ? stored : revokeOperationId(row.attach_id, "force", attempt);
    const admitted: Detach = {
      step: "revoke",
      attempt,
      operationId,
      sends: reuse ? (before.sends ?? 0) + 1 : 1,
      force: true,
      triedAtMs: yield* Clock.currentTimeMillis,
    };
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
        : yield* readEntry(operationId, linkId, true);
    if (outcome.kind === "clean") {
      if (
        yield* note(
          row,
          withDetach(enroll, { ...withoutTry(admitted), step: "recover" }),
          recovering,
        )
      )
        yield* audit(row.attach_id, "hub.machine_detach", retire ? "retired" : "forced");
      return;
    }
    if (outcome.kind === "failed_clean") {
      const code = outcome.code;
      return yield* halt(
        row,
        enroll,
        { ...admitted, outcome: code },
        code === "tombstone_limit" ? "tombstone_limit" : "revoke_refused",
      );
    }
    yield* note(row, withDetach(enroll, { ...admitted, outcome: outcome.kind }));
  });

  /**
   * A journalled purge revoke; clean only with the Child's purged receipt for this link id. A silent
   * machine's purge settles unknown with remote_disconnect_failed (OpenCodex v2.100.3): that counts
   * as one failed check, the next purge waits 30 minutes under a new id once the old one is resolved,
   * and 48 failed checks over 24 hours force the removal.
   */
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
    // An id stored without an answer (GOAT stopped after storing it) is repeated, never replaced.
    const repeat =
      before.operationId !== undefined &&
      before.operationId.includes(".purge.") &&
      (before.outcome === undefined || REPEAT.has(before.outcome));
    if (repeat && (before.sends ?? 1) >= REVOKE_SENDS)
      return yield* halt(row, enroll, before, "revoke_unsettled");
    if (!repeat && before.operationId !== undefined && before.outcome === "unreachable")
      if (!(yield* resolveSuperseded(before.operationId))) return;
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
        withDetach(enroll, {
          // Recover asks at once: nothing waits for the machine here.
          ...withoutTry(admitted),
          step: "recover",
          outcome: "link_not_found",
          elsewhere: true,
        }),
      );
    const outcome = yield* readEntry(operationId, linkId, false);
    switch (outcome.kind) {
      case "clean":
        return yield* finish(row, withDetach(enroll, admitted), "purged");
      case "failed_clean": {
        if (outcome.code !== "remote_disconnect_failed")
          return yield* halt(row, enroll, { ...admitted, outcome: outcome.code }, "revoke_refused");
        const hint = sent?.refusal?.hint;
        // The Child changed nothing: a link-bound refusal names why; none is a missing ocx-child.
        return yield* halt(
          row,
          enroll,
          { ...admitted, outcome: outcome.code },
          hint !== undefined && CHILD_REFUSALS.has(hint)
            ? "revoke_" + hint
            : "revoke_child_missing",
        );
      }
      case "unsettled": {
        if (outcome.code !== "remote_disconnect_failed" || outcome.resolved)
          return yield* halt(
            row,
            enroll,
            { ...admitted, outcome: outcome.state },
            "revoke_unsettled",
          );
        // The machine did not answer the purge: one failed check.
        const health = yield* failedCheck(row, enroll.health, nowMs);
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
    // An enrollment step that passed its last check may still be sending its link add.
    if (yield* enrolling(row.attach_id)) return;
    if (row.link_id !== null)
      return yield* note(row, withDetach(enroll, { ...before, step: "revoke" }));
    const operationId = row.link_operation_id;
    if (operationId === null)
      return yield* note(row, withDetach(enroll, { ...before, step: "done" }));
    const nowMs = yield* Clock.currentTimeMillis;
    const answer = yield* host.ocx(
      ["link", "operations", "--operation-id", operationId, "--json"],
      READ_TIMEOUT_MS,
    );
    const outcome =
      answer === undefined
        ? ({ kind: "unreadable" } as const)
        : readOperation(answer, { operationId, alias: `pen-${row.node_id}` });
    const fresh = nowMs - (enroll.link?.intentAtMs ?? 0) < OPERATION_REPLAY_MS;
    // A person's force, or an entry a person resolved: the link OpenCodex lists for the machine
    // decides, since the journal no longer can.
    const byList =
      before.force === true || (outcome.kind === "unsettled" && outcome.resolved === true);
    if (byList && outcome.kind !== "committed" && outcome.kind !== "failed_clean") {
      const listed = linkByAlias(
        yield* host.ocx(["link", "status", "--json"], READ_TIMEOUT_MS),
        `pen-${row.node_id}`,
      );
      if (listed === undefined) return;
      if (listed !== null)
        return yield* note(row, withDetach(enroll, { ...before, step: "revoke" }), {
          link_id: listed,
        });
      return yield* finish(row, withDetach(enroll, { ...before, operationId }), "unproven");
    }
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
        // An add the Home received just before its CLI stopped can still be journalled: 10 quiet
        // minutes after GOAT last saw no enrollment step running, nothing can start it any more.
        if (before.idleSinceMs === undefined)
          return yield* note(row, withDetach(enroll, { ...before, idleSinceMs: nowMs }));
        if (nowMs - before.idleSinceMs < STALE_OPEN_MS) return;
        if (fresh && (yield* host.journalServed))
          return yield* note(row, withDetach(enroll, { ...before, step: "done" }), {
            link_operation_id: null,
          });
        return yield* halt(row, enroll, { ...before, operationId }, "link_unsettled");
      case "unsettled":
        return yield* halt(row, enroll, { ...before, operationId }, "link_unsettled");
      case "open":
        // Fenced, the enrollment never repeats the id that would recover a dead entry.
        if (before.idleSinceMs === undefined)
          return yield* note(row, withDetach(enroll, { ...before, idleSinceMs: nowMs }));
        if (nowMs - before.idleSinceMs < STALE_OPEN_MS) return;
        return yield* halt(row, enroll, { ...before, operationId }, "link_open");
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
      const outcome =
        answer === "clean" ? "purged" : before.elsewhere === true ? "elsewhere" : "forgotten";
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
    // Once forced, a changed host key is a wait: recover sends the machine nothing, and a person
    // forgets the tombstone of a machine that was rebuilt or is gone.
    if (answer === "host_key_changed" && before.force === true)
      return yield* note(row, withDetach(enroll, tried));
    if (answer === "host_key_changed")
      return yield* hostKeyConflict(row, withDetach(enroll, tried));
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
    if (reached === "host_key_changed") return yield* hostKeyConflict(row, enroll);
    if (reached !== "ok") {
      const health = yield* failedCheck(row, enroll.health, nowMs);
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
    if (row.final_at !== null) return;
    const enroll = decodeEnroll(row.enroll_json);
    // A conflict stops the record; only a person's force goes past a changed host key.
    if (
      conflictCount(row.conflicts_json) > 0 &&
      !(enroll.detach?.force === true && onlyHostKeyConflict(row.conflicts_json))
    )
      return;
    // A retirement force or a pending removal is finished under its stored id before anything else.
    const forcing = enroll.detach?.force === true && enroll.detach.step === "revoke";
    if (row.state === "linked")
      return forcing && enroll.detach?.stop === undefined
        ? yield* forceStep(row, enroll)
        : yield* healthStep(row, enroll, status);
    const detach = enroll.detach;
    // A person's force clears a stop at admission; a stop the force itself met waits for them.
    if (detach?.stop !== undefined) return;
    // Cleaned and out of Pen: nothing is left to detach.
    if (row.state === "returned")
      return row.pen_removed_at === null ? undefined : yield* finish(row, enroll, "purged");
    if (row.state === "retired")
      return forcing ? yield* forceStep(row, enroll) : yield* recoverStep(row, enroll);
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

  /**
   * Design section 3, Retention: a final record whose key is out of Pen, that names no link or link
   * operation and owes Pen no acknowledgement, goes with its request keys 30 days after it ended.
   */
  const prune = Effect.gen(function* () {
    const cutoff = DateTime.formatIso(
      DateTime.subtract(yield* DateTime.now, { days: RETENTION_DAYS }),
    );
    // The 30 days run from the later of ending and leaving Pen. The DELETE asks it all again, as
    // the record may change while Pen's list is read.
    const prunable = sql`final_at IS NOT NULL
      AND max(final_at, coalesce(pen_removed_at, final_at)) < ${cutoff}
      AND (pen_admitted_at IS NULL OR pen_removed_at IS NOT NULL)
      AND link_id IS NULL AND link_operation_id IS NULL AND NOT ${sql.unsafe(OWES_ACK)}`;
    const ended = yield* sql<{
      readonly attach_id: string;
      readonly step: string | null;
      readonly expected_sign_pub: string;
    }>`SELECT attach_id, step, expected_sign_pub FROM disposable_machines
      WHERE ${prunable} ORDER BY final_at LIMIT ${PRUNE_LIMIT}`;
    if (ended.length === 0) return;
    // A released record never had an admit: it goes only once Pen's view shows its key absent.
    const view = yield* Effect.cached(pen.members);
    const gone: Array<string> = [];
    for (const row of ended) {
      if (row.step === "released") {
        const members = yield* view;
        if (members === undefined || members.has(row.expected_sign_pub)) continue;
      }
      gone.push(row.attach_id);
    }
    yield* exclusive(
      sql.withTransaction(
        Effect.forEach(
          gone,
          (attachId) =>
            Effect.gen(function* () {
              const deleted =
                yield* sql`DELETE FROM disposable_machines WHERE attach_id = ${attachId}
                AND ${prunable} RETURNING attach_id`;
              if (deleted.length === 0) return;
              yield* sql`DELETE FROM disposable_machine_requests WHERE attach_id = ${attachId}`;
              yield* audit(attachId, "hub.machine_prune", "deleted");
            }),
          { discard: true },
        ),
      ),
    );
  }).pipe(Effect.withSpan("DisposableDetach.prune"));

  /** One pass over linked, detaching and retired records; one record's failure never stops the rest. */
  const pass = Effect.gen(function* () {
    // Round robin from where the last pass stopped, so a bounded pass never starves later records.
    const after = yield* Ref.get(cursor);
    const take = (from: string) =>
      sql<{ readonly attach_id: string }>`SELECT attach_id FROM disposable_machines
        WHERE final_at IS NULL AND attach_id > ${from}
          AND (state IN ('linked', 'detaching', 'retired')
            OR (state = 'returned' AND pen_removed_at IS NOT NULL))
        ORDER BY attach_id LIMIT ${limit}`;
    const tail = yield* take(after);
    const head =
      tail.length < limit && after !== ""
        ? (yield* take("")).filter((row) => row.attach_id <= after)
        : [];
    const due = [...tail, ...head].slice(0, limit);
    yield* Ref.set(cursor, due.length < limit ? "" : (due.at(-1)?.attach_id ?? ""));
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
    yield* prune;
  }).pipe(Effect.withSpan("DisposableDetach.pass"));

  return { pass, advance };
});
