import type { ServerSettings } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { makeAuthority } from "./attachAuthority.ts";
import { conflictCount } from "./attachModel.ts";
import { type Columns, type Row, samePolicy } from "./attachRow.ts";
import * as Store from "./DisposableMachineStore.ts";
import { EnrollHost } from "./EnrollHost.ts";
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
import { MachineKey } from "./machineKey.ts";
import { disposableKnownHosts } from "./routeContract.ts";

// ocx link add gives up at 360 s; the margin lets it report before GOAT stops waiting.
const LINK_ADD_TIMEOUT_MS = 400_000;
const LINK_READ_TIMEOUT_MS = 30_000;
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
  const note = (row: Row, enroll: Enroll, columns: Columns = {}) =>
    exclusive(
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
  const stop = (row: Row, enroll: Enroll, code: string, columns: Columns = {}) =>
    Effect.flatMap(note(row, { ...enroll, stop: code }, { state: "paused", ...columns }), () =>
      audit(row.attach_id, "hub.machine_enroll", "stopped:" + code),
    );
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
  const conflict = (row: Row, enroll: Enroll, code: string) =>
    stop(row, enroll, code, { conflicts_json: encodeConflicts([code]) });

  /**
   * A forward commit (design section 2, Ordering and fences): under the settings write lock, only
   * while the switch holds the record's grant, the provisioner is still named, the goatclaw policy
   * its grant came from is unchanged and the record is still due; advances the fence. Lost
   * authority pauses the record. A pin is checked unique in the same transaction that stores it.
   */
  const forward = (
    row: Row,
    before: ServerSettings,
    enroll: Enroll,
    columns: Columns,
    pin?: string,
  ) =>
    exclusive(
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
    const knownHostsFile = yield* host.knownHosts(row.attach_id, line).pipe(Effect.option);
    if (knownHostsFile._tag === "None") return yield* conflict(row, enroll, "pin_changed");
    const route: StoredRoute = {
      proxyCommand: pen.proxyCommand,
      user: pen.user,
      hostKey: pen.hostKey,
      fingerprint: pen.fingerprint,
      knownHostsFile: knownHostsFile.value,
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
    const key = yield* machineKey.identity.pipe(Effect.option);
    const reached =
      key._tag === "Some" &&
      (yield* host.reach({
        nodeId: row.node_id,
        noisePub: row.expected_noise_pub,
        proxyCommand: route.proxyCommand,
        user: route.user,
        knownHostsFile: route.knownHostsFile,
        identityFile: key.value.privateKeyFile,
      }));
    const at = yield* nowIso;
    if (!reached) {
      if (enroll.reach?.outcome !== "unreachable")
        yield* note(row, { ...enroll, reach: { outcome: "unreachable", at } });
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

  /** What OpenCodex's journal says of the operation; never sends anything. */
  const readBack = (row: Row, operationId: string) =>
    Effect.map(
      host.ocx(
        ["link", "operations", "--operation-id", operationId, "--json"],
        LINK_READ_TIMEOUT_MS,
      ),
      (answer): LinkOutcome =>
        answer === undefined
          ? { kind: "unreadable" }
          : readOperation(answer, { operationId, alias: `pen-${row.node_id}` }),
    );

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
    const link = enroll.link ?? { attempt: 1, intentAtMs: 0 };
    const as = (result: string): Enroll => ({ ...enroll, link: { ...link, outcome: result } });
    switch (outcome.kind) {
      case "committed":
        yield* note(row, as("committed"), { link_id: outcome.linkId, step: "verify" });
        yield* audit(row.attach_id, "hub.machine_link", "committed");
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
      case "unreadable":
        if (link.outcome !== "journal_unreadable") yield* note(row, as("journal_unreadable"));
        return "done" as const;
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
    yield* host.ocx(
      linkAddArgs({
        alias: `pen-${row.node_id}`,
        route,
        operationId,
        identityArgs: linkIdentityArgs(key.value.privateKeyFile),
      }),
      LINK_ADD_TIMEOUT_MS,
    );
    yield* record(row, enroll, yield* readBack(row, operationId), true);
  });

  const linkStep = Effect.fn("DisposableEnroll.link")(function* (
    row: Row,
    before: ServerSettings,
    enroll: Enroll,
    route: StoredRoute,
  ) {
    if (!declares(yield* home.contracts, [...LINK_CONTRACTS, LINK_IDENTITY_CONTRACT])) {
      if (enroll.link?.outcome !== "opencodex_unsupported")
        yield* note(row, {
          ...enroll,
          link: {
            attempt: enroll.link?.attempt ?? 0,
            intentAtMs: enroll.link?.intentAtMs ?? 0,
            outcome: "opencodex_unsupported",
          },
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
      if (settled !== "resend") return;
      // A resend is a new effect: admitted again, with the authority as it is now.
      const current = yield* settingsNow;
      if (current === undefined) return;
      const ended = yield* authorityEnded(row, current);
      if (ended !== undefined) return yield* exclusive(pause(row, ended));
      const link = enroll.link ?? { attempt: 1, intentAtMs: 0 };
      // The 2-hour window counts from the id's first store, whatever was resent since.
      const { openSinceMs: _seen, ...rest } = link;
      const resent = { ...enroll, link: { ...rest, sends: (link.sends ?? 1) + 1 } };
      if ((yield* forward(row, current, resent, {})) !== "committed") return;
      const again = yield* read(row.attach_id);
      if (again !== undefined && due(again)) yield* dispatch(again, resent, route, stored);
      return;
    }
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

  const step = Effect.fn("DisposableEnroll.step")(function* (row: Row) {
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
    if (row.link_id === null) return yield* linkStep(row, before, enroll, route);
    return yield* verifyStep(row, before, enroll, route, row.link_id);
  });

  /** One step for one record, if it is due; its failures are the caller's pass to log. */
  const advance = Effect.fn("DisposableEnroll.advance")(function* (attachId: string) {
    const claimed = yield* Ref.modify(running, (set) =>
      set.has(attachId) ? [false, set] : [true, new Set([...set, attachId])],
    );
    if (!claimed) return;
    yield* Effect.gen(function* () {
      const row = yield* read(attachId);
      if (row !== undefined && due(row)) yield* step(row);
    }).pipe(
      Effect.ensuring(
        Ref.update(running, (set) => new Set([...set].filter((id) => id !== attachId))),
      ),
    );
  });

  return { advance };
});
