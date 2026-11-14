import type { ServerSettings } from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { makeAuthority } from "./attachAuthority.ts";
import { conflictCount } from "./attachModel.ts";
import { type Columns, IN_PEN, type Row, samePolicy } from "./attachRow.ts";
import * as Store from "./DisposableMachineStore.ts";
import { EnrollHost, identityHintOf } from "./EnrollHost.ts";
import {
  decodeEnroll,
  decodeRoute,
  type Enroll,
  encodeEnroll,
  encodeRoute,
  FINAL_LINK_CODES,
  LINK_ATTEMPTS,
  LINK_CONTRACTS,
  LINK_IDENTITY_CONTRACT,
  LINK_SENDS,
  STALE_OPEN_MS,
  type LinkOutcome,
  linkAddArgs,
  linkIdentityArgs,
  linkOperationId,
  OPERATION_REPLAY_MS,
  readOperation,
  type StoredRoute,
  verifyLink,
} from "./enrollModel.ts";
import { declares, HomeContracts } from "./features.ts";
import type { KeyPathAnswer } from "./keyPath.ts";
import { MachineKey } from "./machineKey.ts";
import { disposableKnownHosts } from "./routeContract.ts";

// ocx link add gives up at 360 s; the margin lets it report before GOAT stops waiting.
const LINK_ADD_TIMEOUT_MS = 400_000;
const LINK_READ_TIMEOUT_MS = 30_000;
type Contracts = Effect.Effect<ReadonlySet<string> | undefined>;
// Bounded: the cap allows few admitted machines, and each step runs at most one ssh or ocx.
const ENROLL_LIMIT = 100;
const ENROLL_CONCURRENCY = 4;
const encodeConflicts = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const WAITING_ROUTE = new Set(["no_exact_block", "no_user", "no_key"]);

class ForwardRefused extends Data.TaggedError("ForwardRefused")<{
  readonly reason: "provisioner_refused" | "delegation_lost" | "not_due" | "sshd_pin_shared";
}> {}
const DUE_STATES = new Set(["admitted", "attaching"]);

/**
 * Design section 2, steps 3 to 5: route, reach with the hub key, link as an exclusive ephemeral Child.
 * Steps commit only while the provisioner's authority holds. A link's operation id is stored before
 * ocx starts and read back from OpenCodex's journal before anything is sent again. No lock is held
 * across SSH or ocx.
 */
export const makeEnroll = Effect.fn("DisposableEnroll.make")(function* (
  exclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
) {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* Store.DisposableMachineStore;
  const host = yield* EnrollHost;
  const home = yield* HomeContracts;
  const machineKey = yield* MachineKey;
  const { unnamed, authorityEnded, settingsNow } = yield* makeAuthority;
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  // One advance per record at a time, so two passes never race one record's steps.
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

  /**
   * Stores what GOAT observed, under the record's fence and with no switch needed: these are facts
   * (a step's outcome, a stop, a link OpenCodex committed). False when another step moved the fence.
   */
  const note = Effect.fn("DisposableEnroll.note")(function* (
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
  // The audit row follows only a stop the record kept; a moved fence means another step decided.
  const stop = Effect.fn("DisposableEnroll.stop")(function* (
    row: Row,
    enroll: Enroll,
    code: string,
    columns: Columns = {},
  ) {
    if (yield* note(row, { ...enroll, stop: code }, { state: "paused", ...columns }))
      yield* audit(row.attach_id, "hub.machine_enroll", "stopped:" + code);
  });
  /** Lost authority stops the record before any further effect; a person resumes it. */
  const pause = Effect.fn("DisposableEnroll.pause")(function* (row: Row, reason: string) {
    const paused = yield* sql`UPDATE disposable_machines SET state = 'paused',
          state_since = ${yield* nowIso} WHERE attach_id = ${row.attach_id}
          AND fence = ${row.fence} AND state != 'paused' RETURNING attach_id`;
    if (paused.length === 1) yield* audit(row.attach_id, "hub.machine_enroll", "paused:" + reason);
  });
  /** Whether the record is an admitted attach still moving on: no conflict, stop or final state. */
  const due = (row: Row) =>
    row.final_at === null &&
    row.pen_admitted_at !== null &&
    row.pen_removed_at === null &&
    DUE_STATES.has(row.state) &&
    conflictCount(row.conflicts_json) === 0;
  const conflict = Effect.fn("DisposableEnroll.conflict")(function* (
    row: Row,
    enroll: Enroll,
    code: string,
  ) {
    yield* stop(row, enroll, code, { conflicts_json: encodeConflicts([code]) });
  });

  /**
   * A forward commit (design section 2, Ordering and fences): under the settings write lock, only
   * while the switch holds the record's grant, the provisioner is still named, the goatclaw policy
   * its grant came from is unchanged and the record is still due; advances the fence. Lost
   * authority pauses the record. A pin is checked unique in the same transaction that stores it.
   */
  const forward = Effect.fn("DisposableEnroll.forward")(function* (
    row: Row,
    before: ServerSettings,
    enroll: Enroll,
    columns: Columns,
    pin?: string,
  ) {
    return yield* exclusive(
      Effect.gen(function* () {
        const committed = yield* store
          .commitForward({ attachId: row.attach_id, fence: row.fence }, (current) =>
            Effect.gen(function* () {
              if (unnamed(row, current))
                return yield* new ForwardRefused({ reason: "provisioner_refused" });
              if (!samePolicy(current, before))
                return yield* new ForwardRefused({ reason: "delegation_lost" });
              const [latest] = yield* sql<Row>`SELECT * FROM disposable_machines
                WHERE attach_id = ${row.attach_id}`;
              if (latest === undefined || !due(latest))
                return yield* new ForwardRefused({ reason: "not_due" });
              if (pin !== undefined) {
                const [shared] = yield* sql<{ readonly attach_id: string }>`SELECT attach_id
                  FROM disposable_machines WHERE final_at IS NULL AND sshd_pin = ${pin}
                    AND attach_id != ${row.attach_id} LIMIT 1`;
                if (shared !== undefined)
                  return yield* new ForwardRefused({ reason: "sshd_pin_shared" });
              }
              const now = yield* nowIso;
              const state = typeof columns.state === "string" ? columns.state : row.state;
              yield* sql`UPDATE disposable_machines SET ${sql.update({
                ...columns,
                enroll_json: encodeEnroll(enroll),
                ...(state === row.state ? {} : { state_since: now }),
                updated_at: now,
              })} WHERE attach_id = ${row.attach_id}`;
            }),
          )
          .pipe(
            Effect.catchTags({
              ForwardRefused: (refused) =>
                Effect.succeed({ committed: false, reason: refused.reason } as const),
            }),
          );
        if (committed.committed) return "committed" as const;
        if (committed.reason === "sshd_pin_shared") return "sshd_pin_shared" as const;
        // Another step owns the record, or it is no longer due; anything else ended the authority.
        if (
          committed.reason !== "fence_moved" &&
          committed.reason !== "not_found" &&
          committed.reason !== "not_due"
        )
          yield* pause(row, committed.reason);
        return "refused" as const;
      }),
    );
  });

  const routeStep = Effect.fn("DisposableEnroll.route")(function* (
    row: Row,
    before: ServerSettings,
    enroll: Enroll,
  ) {
    const now = yield* nowIso;
    const pen = yield* host.route({ nodeId: row.node_id, noisePub: row.expected_noise_pub });
    if (pen === undefined || pen.kind === "refused") {
      const reason = pen === undefined ? "no_pen" : pen.reason;
      if (!WAITING_ROUTE.has(reason) && reason !== "no_pen")
        return yield* conflict(row, enroll, "route_" + reason);
      if (enroll.route?.outcome !== reason)
        yield* note(row, { ...enroll, route: { outcome: reason, at: now } });
      return;
    }
    const line = disposableKnownHosts(row.node_id, pen.hostKey);
    if (line === undefined) return yield* conflict(row, enroll, "route_several_keys");
    const knownHostsFile = yield* host.knownHosts(row.attach_id, line).pipe(Effect.result);
    if (knownHostsFile._tag === "Failure") {
      // Only a different key already pinned is a conflict; a failed write waits for the next pass.
      if (knownHostsFile.failure.reason === "changed")
        return yield* conflict(row, enroll, "pin_changed");
      if (enroll.route?.outcome !== "known_hosts_unwritable")
        yield* note(row, { ...enroll, route: { outcome: "known_hosts_unwritable", at: now } });
      return;
    }
    const route: StoredRoute = {
      proxyCommand: pen.proxyCommand,
      user: pen.user,
      hostKey: pen.hostKey,
      fingerprint: pen.fingerprint,
      knownHostsFile: knownHostsFile.success,
    };
    const stored = yield* forward(
      row,
      before,
      { ...enroll, route: { outcome: "ok", at: now } },
      {
        route_json: encodeRoute(route),
        sshd_pin: pen.fingerprint,
        state: "attaching",
        step: "reach",
      },
      pen.fingerprint,
    );
    if (stored === "sshd_pin_shared") yield* conflict(row, enroll, "sshd_pin_shared");
  });

  const reachStep = Effect.fn("DisposableEnroll.reach")(function* (
    row: Row,
    before: ServerSettings,
    enroll: Enroll,
    route: StoredRoute,
  ) {
    // The design's pin check: a key Pen changed since the route step is a conflict before any ssh.
    if ((yield* pinHolds(row, route)) === "changed")
      return yield* conflict(row, enroll, "pin_changed");
    // The private known_hosts holds the pinned line, written again if it went missing.
    const line = disposableKnownHosts(row.node_id, route.hostKey);
    const pinned =
      line === undefined
        ? undefined
        : yield* host.knownHosts(row.attach_id, line).pipe(Effect.result);
    // Pen still advertises the pin, so a mismatch is GOAT's own file edited or damaged.
    if (pinned?._tag === "Failure" && pinned.failure.reason === "changed")
      return yield* stop(row, enroll, "known_hosts_edited");
    const key = yield* machineKey.identity.pipe(Effect.option);
    const reached =
      key._tag === "None"
        ? "machine_key_unusable"
        : yield* host.reach({
            nodeId: row.node_id,
            noisePub: row.expected_noise_pub,
            proxyCommand: route.proxyCommand,
            user: route.user,
            // The file just written at the current state path: a stored one outlives a home move.
            knownHostsFile: pinned?._tag === "Success" ? pinned.success : route.knownHostsFile,
            identityFile: key.value.privateKeyFile,
          });
    const at = yield* nowIso;
    if (reached === "host_key_changed") return yield* conflict(row, enroll, "host_key_changed");
    if (reached !== "ok") {
      if (enroll.reach?.outcome !== reached)
        yield* note(row, { ...enroll, reach: { outcome: reached, at } });
      return;
    }
    yield* forward(row, before, { ...enroll, reach: { outcome: "ok", at } }, { step: "link" });
  });

  /** Pen's advertised key must still be the pinned one before an effect (design section 2). */
  const pinHolds = Effect.fn("DisposableEnroll.pinHolds")(function* (row: Row, route: StoredRoute) {
    const pen = yield* host.route({ nodeId: row.node_id, noisePub: row.expected_noise_pub });
    if (pen === undefined || pen.kind === "refused") return "unknown" as const;
    return pen.hostKey === route.hostKey ? ("same" as const) : ("changed" as const);
  });

  /**
   * What OpenCodex's journal says of the operation; never sends anything. ocx exits 4 for any 404,
   * so "not found" counts only when the same Home serves its journal list.
   */
  const readBack = Effect.fn("DisposableEnroll.readBack")(function* (
    row: Row,
    operationId: string,
  ) {
    const answer = yield* host.ocx(
      ["link", "operations", "--operation-id", operationId, "--json"],
      LINK_READ_TIMEOUT_MS,
    );
    const outcome: LinkOutcome =
      answer === undefined
        ? { kind: "unreadable" }
        : readOperation(answer, { operationId, alias: `pen-${row.node_id}` });
    if (outcome.kind !== "not_found") return outcome;
    return (yield* host.journalServed) ? outcome : ({ kind: "unreadable" } as const);
  });

  /**
   * Stores what the journal said. "resend" only for an id OpenCodex never journalled, read within
   * the 2 hours it keeps every entry it wrote, from a pass that has not sent it yet.
   */
  const record = Effect.fn("DisposableEnroll.record")(function* (
    row: Row,
    enroll: Enroll,
    outcome: LinkOutcome,
    sent: boolean,
  ) {
    const { unreadableSinceMs, ...answered } = enroll.link ?? { attempt: 1, intentAtMs: 0 };
    // Any answer the journal gave ends a run of unreadable reads.
    const link =
      outcome.kind === "unreadable" && unreadableSinceMs !== undefined
        ? { ...answered, unreadableSinceMs }
        : answered;
    const as = (result: string): Enroll => ({ ...enroll, link: { ...link, outcome: result } });
    // Branches below may write nothing, so the end of a failed-read run is stored here.
    if (outcome.kind !== "unreadable" && unreadableSinceMs !== undefined)
      yield* note(row, { ...enroll, link });
    switch (outcome.kind) {
      case "committed":
        if (yield* note(row, as("committed"), { link_id: outcome.linkId, step: "verify" }))
          yield* audit(row.attach_id, "hub.machine_link", "committed");
        // The link exists whoever moved the fence; its id is a fact the record must not lose.
        else
          yield* sql`UPDATE disposable_machines SET link_id = ${outcome.linkId}
            WHERE attach_id = ${row.attach_id} AND link_id IS NULL`;
        return "done" as const;
      case "failed_clean":
        if (FINAL_LINK_CODES.has(outcome.code)) yield* stop(row, as(outcome.code), outcome.code);
        else if (link.attempt >= LINK_ATTEMPTS)
          yield* stop(row, as(outcome.code), "link_attempts_used");
        // Nothing this operation made remains; the next pass starts the next one.
        else yield* note(row, as(outcome.code), { link_operation_id: null });
        return "done" as const;
      case "unsettled":
        yield* stop(row, as(outcome.state), "link_" + outcome.state, { state: "unknown" });
        return "done" as const;
      case "open": {
        const nowMs = yield* Clock.currentTimeMillis;
        if (link.openSinceMs === undefined) {
          yield* note(row, { ...enroll, link: { ...link, outcome: "open", openSinceMs: nowMs } });
          return "done" as const;
        }
        if (sent || nowMs - link.openSinceMs < STALE_OPEN_MS) return "done" as const;
        // Nothing runs it any more; only a repeat of the same id lets OpenCodex settle it.
        if ((link.sends ?? 1) >= LINK_SENDS) {
          yield* stop(row, as("open"), "link_stuck_open", { state: "unknown" });
          return "done" as const;
        }
        return "resend" as const;
      }
      case "unreadable": {
        // A person reads the journal once it has failed for 2 hours and the id is 2 hours old.
        const nowMs = yield* Clock.currentTimeMillis;
        if (unreadableSinceMs === undefined) {
          yield* note(row, {
            ...enroll,
            link: { ...link, outcome: "journal_unreadable", unreadableSinceMs: nowMs },
          });
          return "done" as const;
        }
        if (
          nowMs - unreadableSinceMs >= OPERATION_REPLAY_MS &&
          nowMs - link.intentAtMs >= OPERATION_REPLAY_MS
        )
          yield* stop(row, as("journal_unreadable"), "journal_unreadable", { state: "unknown" });
        return "done" as const;
      }
      case "not_found": {
        const age = (yield* Clock.currentTimeMillis) - link.intentAtMs;
        // After 2 hours the journal may have dropped a settled entry, so the id says nothing.
        if (age >= OPERATION_REPLAY_MS) {
          yield* stop(row, as("not_found"), "operation_lost", { state: "unknown" });
          return "done" as const;
        }
        if (sent) {
          if (link.outcome !== "not_started") yield* note(row, as("not_started"));
          return "done" as const;
        }
        // An id OpenCodex keeps refusing before its journal opens is not resent without end.
        if ((link.sends ?? 1) >= LINK_SENDS) {
          yield* stop(row, as("not_started"), "link_not_started");
          return "done" as const;
        }
        return "resend" as const;
      }
    }
  });

  /** Starts ocx link add under the stored id; whatever it prints, the journal is read after. */
  const dispatch = Effect.fn("DisposableEnroll.dispatch")(function* (
    row: Row,
    enroll: Enroll,
    route: StoredRoute,
    operationId: string,
  ) {
    const key = yield* machineKey.identity.pipe(Effect.option);
    if (key._tag === "None") return;
    const added = yield* host.ocx(
      linkAddArgs({
        alias: `pen-${row.node_id}`,
        route,
        operationId,
        identityArgs: linkIdentityArgs(key.value.privateKeyFile),
      }),
      LINK_ADD_TIMEOUT_MS,
    );
    // OpenCodex refuses a key file it cannot use before its journal opens and names why; the
    // journal is read first, so an operation an earlier send recorded is never stopped over.
    const outcome = yield* readBack(row, operationId);
    const refused = added === undefined ? undefined : identityHintOf(added);
    if (outcome.kind === "not_found" && refused !== undefined)
      return yield* stop(row, enroll, refused);
    yield* record(row, enroll, outcome, true);
  });

  /**
   * Whether OpenCodex can use the machine key's path, checked with its own rule before an id is
   * stored or sent (keyPath.ts). A folder others can write holds the link until it is fixed; a path
   * OpenCodex can never take stops it.
   */
  const keyUsable = Effect.fn("DisposableEnroll.keyUsable")(function* (row: Row, enroll: Enroll) {
    const key = yield* machineKey.identity.pipe(Effect.option);
    const answer: KeyPathAnswer =
      key._tag === "None"
        ? { kind: "key", problem: "missing" }
        : yield* host.keyPath(key.value.privateKeyFile);
    if (answer.kind === "ok") return true;
    if (answer.kind === "form") {
      yield* stop(row, enroll, "machine_key_path");
      return false;
    }
    // A run of failed reads belongs to the journal reads; record() ends it.
    const { unreadableSinceMs: _run, ...link } = { attempt: 0, intentAtMs: 0, ...enroll.link };
    const outcome =
      answer.kind === "directory"
        ? answer.chmod
          ? "key_dir_unsafe"
          : answer.problem === "writable"
            ? "key_dir_shared"
            : "key_dir_foreign"
        : answer.kind === "unreadable"
          ? "key_dir_unreadable"
          : answer.kind === "symlink"
            ? "key_symlink_foreign"
            : "machine_key_unusable";
    const keyDir =
      answer.kind === "directory"
        ? answer.directory
        : answer.kind === "symlink"
          ? answer.path
          : undefined;
    // A folder an earlier answer named is dropped, or the record would differ and write every pass.
    const { keyDir: _named, ...rest } = enroll;
    if (link.outcome !== outcome || enroll.keyDir !== keyDir)
      yield* note(row, {
        ...rest,
        ...(keyDir === undefined ? {} : { keyDir }),
        link: { ...link, outcome },
      });
    return false;
  });

  const linkStep = Effect.fn("DisposableEnroll.link")(function* (
    row: Row,
    before: ServerSettings,
    enroll: Enroll,
    route: StoredRoute,
    pass: Contracts | undefined,
  ) {
    const contracts = yield* pass ?? home.contracts;
    // Either contract arrives with an OpenCodex update; the key with the route came in 2.100.3.
    const missing = !declares(contracts, LINK_CONTRACTS)
      ? "opencodex_unsupported"
      : !declares(contracts, [LINK_IDENTITY_CONTRACT])
        ? "identity_unsupported"
        : undefined;
    if (missing !== undefined) {
      if (enroll.link?.outcome !== missing)
        // Sends and the open entry's first sight belong to the stored id; a contract miss keeps them.
        yield* note(row, {
          ...enroll,
          link: { attempt: 0, intentAtMs: 0, ...enroll.link, outcome: missing },
        });
      return;
    }
    const pin = yield* pinHolds(row, route);
    if (pin === "changed") return yield* conflict(row, enroll, "pin_changed");
    if (pin === "unknown") return;
    const stored = row.link_operation_id;
    if (stored !== null) {
      // A stored id is read back first; it is sent again only when OpenCodex never journalled it.
      const settled = yield* record(row, enroll, yield* readBack(row, stored), false);
      if (settled !== "resend" || !(yield* keyUsable(row, enroll))) return;
      // A resend is a new effect: admitted again, with the authority as it is now.
      const current = yield* settingsNow;
      if (current === undefined) return;
      const ended = yield* authorityEnded(row, current);
      if (ended !== undefined) return yield* exclusive(pause(row, ended));
      const link = enroll.link ?? { attempt: 1, intentAtMs: 0 };
      // The 2-hour window counts from the id's first store, whatever was resent since; the answer
      // that led here ended any run of failed reads.
      const { openSinceMs: _seen, unreadableSinceMs: _run, ...rest } = link;
      const resent = { ...enroll, link: { ...rest, sends: (link.sends ?? 1) + 1 } };
      if ((yield* forward(row, current, resent, {})) !== "committed") return;
      const again = yield* read(row.attach_id);
      if (again !== undefined && due(again)) yield* dispatch(again, resent, route, stored);
      return;
    }
    if (!(yield* keyUsable(row, enroll))) return;
    // Effect admission: the operation id is stored under the settings lock before ocx starts.
    const attempt = (enroll.link?.attempt ?? 0) + 1;
    const operationId = linkOperationId(row.attach_id, attempt);
    const admitted = { ...enroll, link: { attempt, intentAtMs: yield* Clock.currentTimeMillis } };
    if ((yield* forward(row, before, admitted, { link_operation_id: operationId })) !== "committed")
      return;
    const fresh = yield* read(row.attach_id);
    if (fresh !== undefined && due(fresh)) yield* dispatch(fresh, admitted, route, operationId);
  });

  const verifyStep = Effect.fn("DisposableEnroll.verify")(function* (
    row: Row,
    before: ServerSettings,
    enroll: Enroll,
    route: StoredRoute,
    linkId: string,
  ) {
    const output = yield* host.ocx(["link", "status", "--json"], LINK_READ_TIMEOUT_MS);
    const verdict =
      output === undefined || output.code !== 0
        ? "unreadable"
        : verifyLink(output.stdout, { linkId, alias: `pen-${row.node_id}`, route });
    if (verdict === "unreadable") {
      if (enroll.link?.outcome !== "verify_unreadable" && enroll.link !== undefined)
        yield* note(row, { ...enroll, link: { ...enroll.link, outcome: "verify_unreadable" } });
      return;
    }
    if (verdict !== "verified") return yield* conflict(row, enroll, "link_" + verdict);
    const linked =
      enroll.link === undefined ? enroll : { ...enroll, link: { ...enroll.link, outcome: "ok" } };
    if ((yield* forward(row, before, linked, { state: "linked", step: "linked" })) === "committed")
      yield* audit(row.attach_id, "hub.machine_link", "linked");
  });

  const step = Effect.fn("DisposableEnroll.step")(function* (
    row: Row,
    contracts: Contracts | undefined,
  ) {
    const enroll = decodeEnroll(row.enroll_json);
    if (enroll.stop !== undefined) return;
    // Unreadable settings prove nothing ended, so they pause nothing; the next pass reads again.
    const before = yield* settingsNow;
    if (before === undefined) return;
    const ended = yield* authorityEnded(row, before);
    if (ended !== undefined) return yield* exclusive(pause(row, ended));
    const route = decodeRoute(row.route_json);
    if (route === undefined) return yield* routeStep(row, before, enroll);
    if (enroll.reach?.outcome !== "ok") return yield* reachStep(row, before, enroll, route);
    if (row.link_id === null) return yield* linkStep(row, before, enroll, route, contracts);
    return yield* verifyStep(row, before, enroll, route, row.link_id);
  });

  /**
   * A record that left Pen while it held or started a link: the journal is read once for a link
   * the record does not name yet, then the record is final and its status names the link.
   */
  const settleLeft = Effect.fn("DisposableEnroll.settleLeft")(function* (row: Row) {
    const operationId = row.link_operation_id;
    const outcome =
      row.link_id === null && operationId !== null ? yield* readBack(row, operationId) : undefined;
    const linkId = outcome?.kind === "committed" ? outcome.linkId : row.link_id;
    // An operation that left nothing (failed_clean, or never journalled while the journal still keeps
    // every entry, 2 hours from the id's store) is not named afterwards.
    const storedAtMs = decodeEnroll(row.enroll_json).link?.intentAtMs ?? 0;
    const fresh = (yield* Clock.currentTimeMillis) - storedAtMs < OPERATION_REPLAY_MS;
    const leftNothing =
      linkId === null &&
      (outcome?.kind === "failed_clean" || (outcome?.kind === "not_found" && fresh));
    const now = yield* nowIso;
    const settled = yield* exclusive(
      sql`UPDATE disposable_machines SET state = 'failed', final_at = ${now}, state_since = ${now},
        link_id = ${linkId}, link_operation_id = ${leftNothing ? null : operationId},
        updated_at = ${now}
        WHERE attach_id = ${row.attach_id} AND fence = ${row.fence} AND state = 'left_pen'
        RETURNING attach_id`,
    );
    if (settled.length === 1) yield* audit(row.attach_id, "hub.machine_left_pen", "link_named");
  });

  /**
   * One step for one record, if it is due; its failures are the caller's pass to log. `contracts`
   * is the pass's own read of the Home's contracts, shared by its records.
   */
  const advance = Effect.fn("DisposableEnroll.advance")(function* (
    attachId: string,
    contracts?: Contracts,
  ) {
    const claimed = yield* Ref.modify(running, (set) =>
      set.has(attachId) ? [false, set] : [true, new Set([...set, attachId])],
    );
    if (!claimed) return;
    yield* Effect.gen(function* () {
      const row = yield* read(attachId);
      if (row?.state === "left_pen" && row.final_at === null) yield* settleLeft(row);
      else if (row !== undefined && due(row)) yield* step(row, contracts);
    }).pipe(
      Effect.ensuring(
        Ref.update(running, (set) => new Set([...set].filter((id) => id !== attachId))),
      ),
    );
  });

  /** One pass over every record enrollment moves on; one record's failure never stops the others. */
  const pass = Effect.gen(function* () {
    const due = yield* sql<{ readonly attach_id: string }>`SELECT attach_id FROM disposable_machines
      WHERE final_at IS NULL AND ((${sql.unsafe(IN_PEN)} AND state IN ('admitted', 'attaching'))
        OR state = 'left_pen')
      ORDER BY created_at LIMIT ${ENROLL_LIMIT}`;
    // One read of the Home's contracts serves every record in the pass.
    const contracts = yield* Effect.cached(home.contracts);
    yield* Effect.forEach(
      due,
      ({ attach_id }) =>
        advance(attach_id, contracts).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Disposable machine enrollment step failed", Cause.squash(cause)),
          ),
        ),
      { concurrency: ENROLL_CONCURRENCY, discard: true },
    );
  }).pipe(Effect.withSpan("DisposableEnroll.pass"));

  return { advance, pass };
});
