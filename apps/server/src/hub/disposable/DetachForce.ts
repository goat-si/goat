import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";

import type { OcxOutput } from "../HubOcx.ts";
import type { Columns, Row } from "./attachRow.ts";
import { type Detach, REVOKE_SENDS, type RevokeOutcome, revokeOperationId } from "./detachModel.ts";
import type { Enroll } from "./enrollModel.ts";

// A revoke reaches the Child over ssh like an enrollment; the margin lets ocx report first.
export const REVOKE_TIMEOUT_MS = 400_000;

export const withDetach = (enroll: Enroll, detach: Detach): Enroll => ({ ...enroll, detach });
export const withoutTry = ({ triedAtMs: _tried, ...rest }: Detach): Detach => rest;
/** A send OpenCodex may never have recorded keeps the code it was refused with, for its text. */
export const refusalOf = (sent: OcxOutput | undefined) =>
  sent?.refusal?.code === undefined ? {} : { refusal: sent.refusal.code };

/** What the detach pass shares with its force step. */
export interface DetachOps {
  /** Stores what GOAT observed under the record's fence; false when another step moved it. */
  readonly note: (row: Row, enroll: Enroll, columns?: Columns) => Effect.Effect<boolean, SqlError>;
  /** A detach that waits for a person. */
  readonly halt: (
    row: Row,
    enroll: Enroll,
    detach: Detach,
    stop: string,
  ) => Effect.Effect<void, SqlError>;
  readonly audit: (
    attachId: string,
    action: string,
    outcome: string,
  ) => Effect.Effect<unknown, SqlError>;
  /** The link and Child are gone: the record ends. */
  readonly finish: (row: Row, enroll: Enroll, outcome: "purged") => Effect.Effect<void, SqlError>;
  readonly readEntry: (
    operationId: string,
    linkId: string,
    force: boolean,
  ) => Effect.Effect<RevokeOutcome>;
  /** Marks a purge id GOAT gave up on resolved; false when that waits for the next pass. */
  readonly resolveSuperseded: (operationId: string) => Effect.Effect<boolean>;
  readonly ocx: (
    args: ReadonlyArray<string>,
    timeoutMs: number,
  ) => Effect.Effect<OcxOutput | undefined>;
}

/**
 * Removes the link without the machine under its own operation id, leaving a tombstone recover
 * settles. A stored forced id is read first: committed goes on, a settled refusal or a resolved
 * entry gets a new id (tombstone_limit: the same id, then a new one in the same step), anything
 * else is resumed under its id.
 */
export const makeForceStep = (ops: DetachOps) =>
  Effect.fn("DisposableDetach.force")(function* (row: Row, enroll: Enroll) {
    const { note, halt, audit, finish, readEntry, resolveSuperseded } = ops;
    const linkId = row.link_id;
    const before = enroll.detach ?? { step: "revoke", attempt: 0 };
    const retire = row.state === "linked";
    const recovering: Columns = retire ? { state: "retired", step: "recover" } : {};
    if (linkId === null)
      return yield* note(row, withDetach(enroll, { ...before, step: "recover" }), recovering);
    const stored =
      before.operationId?.includes(".force.") === true ? before.operationId : undefined;
    // The purge this force replaces is read once: one that committed finishes the detach; one that
    // is open is repeated (OpenCodex refuses any other revoke meanwhile); a silent machine's stays
    // unknown and keeps the link suspended until resolved, which waits for the force to commit.
    let supersedes = before.supersedes;
    const purgeId =
      before.operationId?.includes(".purge.") === true ? before.operationId : undefined;
    if (purgeId !== undefined) {
      const purge = yield* readEntry(purgeId, linkId, false);
      if (purge.kind === "unreadable") return;
      if (purge.kind === "clean") return yield* finish(row, enroll, "purged");
      if (purge.kind === "open")
        return yield* note(row, withDetach(enroll, { ...before, outcome: "open" }));
      // Any unknown purge the force replaces is resolved once the force commits, so no purge entry
      // of this record stays unsettled on the Home.
      if (purge.kind === "unsettled" && purge.state === "unknown" && !purge.resolved)
        supersedes = purgeId;
    }
    // OpenCodex asks for one more send of a committed id whose removal recover found pending.
    const pending = before.outcome === "retirement_pending";
    let reuse = false;
    if (stored !== undefined) {
      const known = yield* readEntry(stored, linkId, true);
      if (known.kind === "clean" && !pending) {
        if (yield* note(row, withDetach(enroll, { ...before, step: "recover" }), recovering))
          yield* audit(row.attach_id, "hub.machine_detach", retire ? "retired" : "forced");
        return;
      }
      reuse =
        known.kind === "clean"
          ? true
          : known.kind === "failed_clean"
            ? known.code === "tombstone_limit" && (before.sends ?? 0) < 2
            : known.kind === "unsettled"
              ? !known.resolved
              : true;
      if (reuse && !pending && (before.sends ?? 0) >= REVOKE_SENDS)
        return yield* halt(row, enroll, before, "revoke_unsettled");
    }
    const triedAtMs = yield* Clock.currentTimeMillis;
    // The id is stored before ocx starts, so a lost answer is read back, never sent anew.
    const send = Effect.fn("DisposableDetach.sendForce")(function* (
      operationId: string,
      attempt: number,
      sends: number,
    ) {
      const admitted: Detach = {
        step: "revoke",
        attempt,
        operationId,
        sends,
        force: true,
        triedAtMs,
        ...(supersedes === undefined ? {} : { supersedes }),
      };
      if (!(yield* note(row, withDetach(enroll, admitted)))) return undefined;
      const sent = yield* ops.ocx(
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
      // Gone without a tombstone of GOAT's: someone else removed it, as on the purge path.
      const elsewhere = sent?.refusal?.code === "link_not_found";
      const outcome = elsewhere
        ? ({ kind: "clean" } as const)
        : yield* readEntry(operationId, linkId, true);
      return { admitted, sent, elsewhere, outcome };
    });
    const limited = (answer: {
      readonly outcome: { readonly kind: string; readonly code?: string };
    }) => answer.outcome.kind === "failed_clean" && answer.outcome.code === "tombstone_limit";
    const attempt = reuse ? before.attempt : before.attempt + 1;
    let result = yield* send(
      reuse && stored !== undefined ? stored : revokeOperationId(row.attach_id, "force", attempt),
      attempt,
      reuse ? (before.sends ?? 0) + 1 : 1,
    );
    if (result === undefined) return;
    // OpenCodex's order for tombstone_limit (cli/link.ts): the same id first, which resumes a removal
    // it still owns and otherwise only replays; then a new id; one refused link_retirement_owned goes
    // back to the id that owns the removal.
    if (reuse && stored !== undefined && limited(result)) {
      const next = before.attempt + 1;
      const fresh = yield* send(revokeOperationId(row.attach_id, "force", next), next, 1);
      if (fresh === undefined) return;
      result =
        fresh.sent?.refusal?.code === "link_retirement_owned"
          ? yield* send(stored, before.attempt, 1)
          : fresh;
      if (result === undefined) return;
    }
    const { admitted, sent, elsewhere, outcome } = result;
    if (outcome.kind === "clean") {
      // After the one resend recover asked for, the next recover keeps its 30-minute wait.
      const settled = pending
        ? { ...admitted, pendingResent: true as const }
        : withoutTry(admitted);
      const { supersedes: _resolving, ...committed } = settled;
      const resolved = supersedes === undefined || (yield* resolveSuperseded(supersedes));
      const saved = yield* note(
        row,
        withDetach(enroll, {
          ...(resolved ? committed : settled),
          step: "recover",
          ...(elsewhere ? { elsewhere: true as const, outcome: "link_not_found" } : {}),
        }),
        recovering,
      );
      if (saved && !pending)
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
    yield* note(
      row,
      withDetach(enroll, { ...admitted, outcome: outcome.kind, ...refusalOf(sent) }),
    );
  });
