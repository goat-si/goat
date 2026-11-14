import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { OcxOutput } from "../HubOcx.ts";
import { type Columns, type Row } from "./attachRow.ts";
import {
  makeForceStep,
  refusalOf,
  repeatOwner,
  REVOKE_TIMEOUT_MS,
  revokeArgs,
  withDetach,
  withoutTry,
} from "./DetachForce.ts";
import { makePrune } from "./DetachPrune.ts";
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
  detachRuns,
  type Enroll,
  encodeEnroll,
  listedLink,
  OPERATION_REPLAY_MS,
  readOperation,
  STALE_OPEN_MS,
} from "./enrollModel.ts";
import { MachineKey } from "./machineKey.ts";
import { PenInvites } from "./PenInvites.ts";
import { disposableKnownHosts } from "./routeContract.ts";

const READ_TIMEOUT_MS = 30_000;
const DETACH_LIMIT = 100;
const DETACH_CONCURRENCY = 4;
const Conflicts = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeConflicts = Schema.encodeSync(Conflicts);
/** Answers that leave the revoke's own id to be sent again, as OpenCodex asks. */
const REPEAT = new Set(["open", "not_found", "unreadable"]);
/** A purge left unsettled waits for a person until its entry reads resolved; then a new id goes. */
const OWED_STOP: Record<string, string> = {
  unknown: "revoke_unsettled",
  residual: "revoke_unsettled",
  answered: "revoke_answered",
};

/** What one pass reads once and every record shares. */
interface PassReads {
  /** ocx link status, for the key path of linked records. */
  readonly status: Effect.Effect<OcxOutput | undefined>;
  /** Whether this hub's Pen answers its member list over its control socket. */
  readonly penAnswers: Effect.Effect<boolean>;
}

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
   * A failed check counts only while this hub's Pen answers its member list, so a stopped Pen does
   * not retire every linked machine after 24 hours; a key out of that list counts, as it can never
   * answer through Pen again. A network cut with Pen's daemon up still counts. The wait between
   * checks runs either way.
   */
  const failedCheck = Effect.fn("DisposableDetach.failedCheck")(function* (
    health: Health | undefined,
    nowMs: number,
    reads: PassReads,
  ) {
    return (yield* reads.penAnswers)
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

  /** GOAT's own reach (ssh true over the stored route); undefined when it cannot run. */
  const handshake = Effect.fn("DisposableDetach.handshake")(function* (row: Row) {
    const route = decodeRoute(row.route_json);
    const line = route === undefined ? undefined : disposableKnownHosts(row.node_id, route.hostKey);
    const key = yield* machineKey.identity.pipe(Effect.option);
    if (route === undefined || line === undefined || key._tag === "None") return undefined;
    const pinned = yield* host.knownHosts(row.attach_id, line).pipe(Effect.option);
    if (pinned._tag === "None") return undefined;
    const reached = yield* host.reach({
      nodeId: row.node_id,
      noisePub: row.expected_noise_pub,
      proxyCommand: route.proxyCommand,
      user: route.user,
      knownHostsFile: pinned.value,
      identityFile: key.value.privateKeyFile,
    });
    return { reached, keyFile: key.value.privateKeyFile };
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

  const ops = { note, halt, audit, finish, readEntry, resolveSuperseded, ocx: host.ocx };
  const forceStep = makeForceStep(ops);

  /**
   * A journalled purge revoke; clean only with the Child's purged receipt for this link id. A silent
   * machine's purge settles unknown with remote_disconnect_failed (OpenCodex v2.100.3): that counts
   * as one failed check, the next purge waits 30 minutes under a new id once the old one is resolved,
   * and 48 failed checks over 24 hours force the removal.
   */
  const revokeStep = Effect.fn("DisposableDetach.revoke")(function* (
    row: Row,
    enroll: Enroll,
    reads: PassReads,
  ) {
    const before = enroll.detach ?? { step: "revoke", attempt: 0 };
    const linkId = row.link_id;
    if (linkId === null) return yield* note(row, withDetach(enroll, { ...before, step: "done" }));
    // A force waits for an open purge: OpenCodex refuses any other revoke until it is repeated.
    const openPurge = before.operationId?.includes(".purge.") === true && before.outcome === "open";
    if (before.force === true && !openPurge) return yield* forceStep(row, enroll);
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
    const owed = before.outcome === undefined ? undefined : OWED_STOP[before.outcome];
    if (!repeat && owed !== undefined && before.operationId?.includes(".purge.") === true) {
      const kept = yield* readEntry(before.operationId, linkId, false);
      if (kept.kind === "unreadable") return;
      if (kept.kind === "unsettled" && !kept.resolved)
        return yield* halt(row, enroll, before, owed);
    }
    if (!repeat && before.operationId !== undefined && before.outcome === "unreachable")
      if (!(yield* resolveSuperseded(before.operationId))) return;
    const attempt = repeat ? before.attempt : before.attempt + 1;
    const operationId =
      repeat && before.operationId !== undefined
        ? before.operationId
        : revokeOperationId(row.attach_id, "purge", attempt);
    // GOAT's previous purge goes once more if this id meets an unfinished removal it may own.
    const owner = repeat
      ? before.owner
      : before.operationId?.includes(".purge.") === true
        ? before.operationId
        : before.owner;
    const admitted: Detach = {
      step: "revoke",
      attempt,
      operationId,
      sends: repeat ? (before.sends ?? 1) + 1 : 1,
      triedAtMs: nowMs,
      // A person's force that repeats an open purge stays a force once the purge settles.
      ...(before.force === true ? { force: true as const } : {}),
      ...(owner === undefined ? {} : { owner }),
    };
    if (!(yield* note(row, withDetach(enroll, admitted)))) return;
    const sent = yield* host.ocx([...revokeArgs(linkId, operationId), "--json"], REVOKE_TIMEOUT_MS);
    if (sent?.refusal?.code === "link_retirement_owned") {
      const resumed = yield* repeatOwner(ops, linkId, owner);
      if (resumed.kind === "clean")
        return yield* finish(row, withDetach(enroll, admitted), "purged");
      return yield* halt(
        row,
        enroll,
        { ...admitted, outcome: "retirement_owned", refusal: "link_retirement_owned" },
        "link_retirement_owned",
      );
    }
    // Removed without a purge receipt: someone else revoked it; recover asks whether a cleanup of
    // the machine waits.
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
        // A person forced while this purge was open: now that it settled, the force goes on.
        if (before.force === true)
          return yield* forceStep(row, withDetach(enroll, { ...admitted, outcome: outcome.code }));
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
        // Resolved meanwhile: the next pass sends a new id.
        if (outcome.resolved)
          return yield* note(row, withDetach(enroll, { ...admitted, outcome: "resolved" }));
        if (before.force === true)
          return yield* forceStep(row, withDetach(enroll, { ...admitted, outcome: outcome.state }));
        if (outcome.code !== "remote_disconnect_failed") {
          // OpenCodex's order for an unknown revoke: the same id once more, which resumes a removal
          // it claimed before failing (a silent machine's purge never claims one).
          yield* host.ocx([...revokeArgs(linkId, operationId), "--json"], REVOKE_TIMEOUT_MS);
          const again = yield* readEntry(operationId, linkId, false);
          if (again.kind === "clean")
            return yield* finish(row, withDetach(enroll, admitted), "purged");
          return yield* halt(
            row,
            enroll,
            { ...admitted, outcome: outcome.state },
            "revoke_unsettled",
          );
        }
        // The CLI prints no hint for a Child that answered but kept its binary: GOAT's own
        // handshake tells a machine that answers from a silent one.
        const shaken = yield* handshake(row);
        if (shaken?.reached === "ok")
          return yield* halt(row, enroll, { ...admitted, outcome: "answered" }, "revoke_answered");
        if (shaken?.reached === "host_key_changed")
          return yield* hostKeyConflict(
            row,
            withDetach(enroll, { ...admitted, outcome: "answered" }),
          );
        // The machine did not answer the purge: one failed check.
        const health = yield* failedCheck(enroll.health, nowMs, reads);
        const waiting = { ...enroll, health };
        if (retires(health, nowMs))
          return yield* forceStep(
            row,
            withDetach(waiting, { ...admitted, outcome: "unreachable" }),
          );
        return yield* note(row, withDetach(waiting, { ...admitted, outcome: "unreachable" }));
      }
      default:
        return yield* note(
          row,
          withDetach(enroll, { ...admitted, outcome: outcome.kind, ...refusalOf(sent) }),
        );
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
    // GOAT's own add may still run until 10 quiet minutes pass; only then can the list decide.
    const quiet = before.idleSinceMs !== undefined && nowMs - before.idleSinceMs >= STALE_OPEN_MS;
    // A person's force, or an entry a person resolved: the link OpenCodex lists for this attach
    // decides, since the journal no longer can.
    const byList =
      outcome.kind === "unsettled"
        ? before.force === true || outcome.resolved === true
        : before.force === true &&
          quiet &&
          (outcome.kind === "open" || outcome.kind === "not_found");
    if (byList) {
      const listed = listedLink(yield* host.ocx(["link", "status", "--json"], READ_TIMEOUT_MS), {
        alias: `pen-${row.node_id}`,
        reservedLinkId:
          outcome.kind === "unsettled" || outcome.kind === "open"
            ? outcome.reservedLinkId
            : undefined,
        route: decodeRoute(row.route_json),
      });
      switch (listed.kind) {
        case "unreadable":
          return;
        case "ours":
          return yield* note(row, withDetach(enroll, { ...before, step: "revoke" }), {
            link_id: listed.linkId,
          });
        case "foreign":
          // GOAT never takes it; a person's force ends this record and leaves that link alone.
          return before.force === true
            ? yield* finish(
                row,
                withDetach(enroll, { ...before, operationId, foreignLinkId: listed.linkId }),
                "unproven",
              )
            : yield* halt(
                row,
                enroll,
                { ...before, operationId, foreignLinkId: listed.linkId },
                "link_foreign",
              );
        case "none":
          return yield* finish(
            row,
            withDetach(enroll, {
              ...before,
              operationId,
              ...(listed.aliasLinkId === undefined ? {} : { foreignLinkId: listed.aliasLinkId }),
            }),
            "unproven",
          );
      }
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
        return yield* halt(row, enroll, { ...before, operationId }, "link_lost");
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
    const stored = enroll.detach ?? { step: "recover", attempt: 0 };
    const linkId = row.link_id;
    const nowMs = yield* Clock.currentTimeMillis;
    if (stored.triedAtMs !== undefined && nowMs - stored.triedAtMs < CHECK_EVERY_MS) return;
    // A replaced purge whose resolve failed after the force committed is resolved first; the
    // record never ends while it is owed.
    const { supersedes, ...before } = stored;
    if (supersedes !== undefined && !(yield* resolveSuperseded(supersedes)))
      return yield* note(
        row,
        withDetach(enroll, { ...stored, triedAtMs: nowMs, outcome: "resolve_owed" }),
      );
    if (linkId === null) return yield* finish(row, withDetach(enroll, before), "purged");
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
      // The forced id is sent once more, as OpenCodex asks; a pending answer after that waits.
      return yield* note(
        row,
        withDetach(
          enroll,
          before.pendingResent === true
            ? tried
            : { ...tried, step: "revoke", force: true, outcome: "retirement_pending" },
        ),
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
    reads: PassReads,
  ) {
    const nowMs = yield* Clock.currentTimeMillis;
    if (enroll.health !== undefined && nowMs - enroll.health.checkedAtMs < CHECK_EVERY_MS) return;
    const shaken = yield* handshake(row);
    if (shaken === undefined) return;
    const { reached, keyFile } = shaken;
    if (reached === "host_key_changed") return yield* hostKeyConflict(row, enroll);
    if (reached !== "ok") {
      const health = yield* failedCheck(enroll.health, nowMs, reads);
      // A retirement force that stopped waits for a person; it is not sent again every 30 minutes.
      if (retires(health, nowMs) && enroll.detach?.stop === undefined)
        return yield* forceStep(row, { ...enroll, health });
      return yield* note(row, { ...enroll, health });
    }
    const keyState =
      row.link_id === null ? "unknown" : linkKeyState(yield* reads.status, row.link_id, keyFile);
    const { linkKeyMoved: _moved, detach, ...rest } = enroll;
    const moved = keyState === "moved" ? { linkKeyMoved: true as const } : {};
    // A retirement force that stopped is read once the machine answers: committed goes on to
    // recover, still open or unsettled waits for a person, anything else is dropped so a later
    // silence retires it again under a new id.
    const retirement = detach?.force === true && detach.stop !== undefined ? detach : undefined;
    let kept = detach;
    if (retirement !== undefined && row.link_id !== null) {
      // Refused for an unfinished removal: GOAT's own earlier revoke is what may still be owed.
      const { owner, ...unowned } = retirement;
      const owned = retirement.stop === "link_retirement_owned" ? owner : undefined;
      const readId = owned ?? retirement.operationId;
      const entry =
        readId === undefined
          ? ({ kind: "not_found" } as const)
          : yield* readEntry(readId, row.link_id, readId.includes(".force."));
      // The journal cannot be read now: the check is recorded, and the read-back waits 30 minutes.
      if (entry.kind === "unreadable")
        return yield* note(row, {
          ...rest,
          detach: retirement,
          ...moved,
          health: { failures: 0, checkedAtMs: nowMs },
        });
      // GOAT's own purge finished the removal meanwhile, with the Child's receipt.
      if (entry.kind === "clean" && readId?.includes(".purge.") === true)
        return yield* finish(row, enroll, "purged");
      if (entry.kind === "clean") {
        const { stop: _stop, ...going } =
          owned === undefined ? retirement : { ...unowned, operationId: owned };
        const retired = yield* note(
          row,
          {
            ...rest,
            detach: { ...going, step: "recover" },
            health: { failures: 0, checkedAtMs: nowMs },
          },
          { state: "retired", step: "recover" },
        );
        if (retired) yield* audit(row.attach_id, "hub.machine_detach", "retired");
        return;
      }
      const owed = entry.kind === "open" || (entry.kind === "unsettled" && !entry.resolved);
      // The live kind decides the text and what a person's detach does.
      kept = owed
        ? {
            ...(owned === undefined ? retirement : { ...unowned, operationId: owned }),
            outcome: entry.kind === "open" ? "open" : "unsettled",
          }
        : { step: "none", attempt: retirement.attempt };
    }
    yield* note(row, {
      ...rest,
      ...(kept === undefined ? {} : { detach: kept }),
      ...moved,
      health: { failures: 0, checkedAtMs: nowMs },
    });
  });

  const step = Effect.fn("DisposableDetach.step")(function* (row: Row, reads: PassReads) {
    if (row.final_at !== null) return;
    const enroll = decodeEnroll(row.enroll_json);
    // A conflict stops the record; only a person's force goes past a changed host key.
    if (!detachRuns(row)) return;
    // A retirement force or a pending removal is finished under its stored id before anything else.
    const forcing = enroll.detach?.force === true && enroll.detach.step === "revoke";
    if (row.state === "linked")
      return forcing && enroll.detach?.stop === undefined
        ? yield* forceStep(row, enroll)
        : yield* healthStep(row, enroll, reads);
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
        return yield* revokeStep(row, enroll, reads);
    }
  });

  const advance = Effect.fn("DisposableDetach.advance")(function* (
    attachId: string,
    reads: PassReads,
  ) {
    const claimed = yield* Ref.modify(running, (set) =>
      set.has(attachId) ? [false, set] : [true, new Set([...set, attachId])],
    );
    if (!claimed) return;
    yield* Effect.flatMap(read(attachId), (row) =>
      row === undefined ? Effect.void : step(row, reads),
    ).pipe(
      Effect.ensuring(
        Ref.update(running, (set) => new Set([...set].filter((id) => id !== attachId))),
      ),
    );
  });

  const prune = yield* makePrune(exclusive);
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
    const reads: PassReads = {
      status: yield* Effect.cached(host.ocx(["link", "status", "--json"], READ_TIMEOUT_MS)),
      penAnswers: yield* Effect.cached(Effect.map(pen.members, (members) => members !== undefined)),
    };
    yield* Effect.forEach(
      due,
      ({ attach_id }) =>
        advance(attach_id, reads).pipe(
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
