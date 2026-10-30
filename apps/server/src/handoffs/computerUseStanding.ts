import {
  COMPUTER_USE_GRANT_HANDOFF_PATH,
  HandoffError,
  isHandoffPending,
  type Handoff,
  type HandoffRespondInput,
  type HandoffSummary,
  type HandoffHuman,
  type NodeId,
  type RunId,
  type ThreadId,
} from "@goat/contracts";
import { cuaAppKey, isExcludedCuaApplication } from "@goat/shared/cuaDriverManifest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Semaphore from "effect/Semaphore";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as ComputerUseLeases from "../cua/ComputerUseLeases.ts";
import type * as ServerSettings from "../serverSettings.ts";
import type * as DateTime from "effect/DateTime";
import { mentions } from "../cua/ComputerUseNamedApps.ts";
import type { SshProgressBinding } from "./Handoffs.ts";

export type CreateInput = {
  readonly kind: Handoff["kind"];
  readonly title: string;
  readonly reason: string;
  readonly requestedBy: Handoff["requestedBy"];
  readonly target: Handoff["target"];
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly human: HandoffHuman;
  readonly args: Readonly<Record<string, unknown>>;
  readonly expiresAt?: DateTime.Utc;
  readonly sshProgress?: SshProgressBinding;
  readonly apps?: ReadonlyArray<string>;
  readonly computerUseForeground?: Handoff["computerUseForeground"];
  readonly namedMessages?: ReadonlyArray<{
    readonly app: string;
    readonly messageId: string;
    readonly name?: string;
  }>;
};

const unavailable = (cause: unknown) => new HandoffError({ reason: "unavailable", cause });
const isHandoffError = Schema.is(HandoffError);
const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

export const makeComputerUseStanding = (deps: {
  sql: SqlClient.SqlClient;
  lock: Semaphore.Semaphore;
  leases: Option.Option<ComputerUseLeases.ComputerUseLeases["Service"]>;
  settings: Option.Option<ServerSettings.ServerSettingsService["Service"]>;
  create: (input: CreateInput, automatic: boolean) => Effect.Effect<HandoffSummary, HandoffError>;
  read: (
    threadId: ThreadId,
    handoffId: Handoff["handoffId"],
  ) => Effect.Effect<Handoff, HandoffError>;
  revoke: (handoff: Handoff) => Effect.Effect<void, HandoffError>;
}) => {
  const { sql, lock, leases, settings } = deps;
  const syncAllowed = Effect.fn("Handoffs.syncComputerUseAllowedApps")(function* (
    list: ReadonlyArray<string>,
  ) {
    const keys = [...new Set(list.map(cuaAppKey))];
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const previous = yield* sql<{
            app_key: string;
          }>`SELECT app_key FROM computer_use_allowed_apps_snapshot`;
          const next = new Set(keys);
          if (previous.length === keys.length && previous.every((row) => next.has(row.app_key)))
            return;
          const removed = previous.some((row) => !next.has(row.app_key));
          if (removed)
            yield* sql`INSERT INTO computer_use_revocation_watermarks (scope, sequence)
          VALUES ('', (SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events))
          ON CONFLICT(scope) DO UPDATE SET sequence = MAX(sequence, excluded.sequence)`;
          yield* sql`DELETE FROM computer_use_allowed_apps_snapshot`;
          for (const key of keys)
            yield* sql`INSERT INTO computer_use_allowed_apps_snapshot (app_key) VALUES (${key})`;
        }),
      )
      .pipe(Effect.mapError(unavailable));
  });
  const allowed = Effect.fn("Handoffs.computerUseStandingAllowed")(function* (
    threadId: ThreadId,
    apps: ReadonlyArray<string>,
    list: ReadonlyArray<string>,
  ) {
    const saved = yield* sql<{
      app_key: string;
    }>`SELECT app_key FROM computer_use_session_approvals WHERE thread_id = ${threadId}`;
    const session = new Set(saved.map((row) => row.app_key));
    const always = new Set(list.map(cuaAppKey));
    return apps.every(
      (app) =>
        !isExcludedCuaApplication(app) &&
        (session.has(cuaAppKey(app)) || always.has(cuaAppKey(app))),
    );
  }, Effect.mapError(unavailable));
  const withAllowedSettings = <A>(
    use: (list: ReadonlyArray<string>, enabled: boolean) => Effect.Effect<A, HandoffError>,
  ) =>
    Option.isSome(settings)
      ? (settings.value.withStoredSettingsSnapshot ?? settings.value.withSettingsSnapshot)(
          (snapshot) => use(snapshot.cuaAllowedApps, snapshot.enableCua),
        ).pipe(Effect.mapError(unavailable))
      : use([], false);
  const validate = Effect.fn("Handoffs.validateComputerUseScope")((
    input: HandoffRespondInput,
    record: Handoff,
  ): Effect.Effect<void, HandoffError> => {
    if (input.computerUseScope === undefined) return Effect.void;
    if (
      record.target.path !== COMPUTER_USE_GRANT_HANDOFF_PATH ||
      input.action !== "completed" ||
      !isHandoffPending(record.state) ||
      record.apps === undefined ||
      record.apps.length === 0 ||
      record.computerUseForeground !== undefined ||
      record.apps.some(isExcludedCuaApplication)
    )
      return Effect.fail(new HandoffError({ reason: "invalid_request" }));
    if (input.computerUseScope === "always" && Option.isNone(settings))
      return Effect.fail(new HandoffError({ reason: "unavailable" }));
    return Effect.void;
  });
  const clear = Effect.fn("Handoffs.clearComputerUseSessions")(
    (threadId?: ThreadId, cutoff?: number) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const sequence =
              cutoff ??
              (yield* sql<{
                sequence: number;
              }>`SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events`)[0]
                ?.sequence ??
              0;
            yield* sql`INSERT INTO computer_use_revocation_watermarks (scope, sequence)
        VALUES (${threadId ?? ""}, ${sequence})
        ON CONFLICT(scope) DO UPDATE SET sequence = MAX(sequence, excluded.sequence)`;
            yield* threadId === undefined
              ? sql`DELETE FROM computer_use_session_approvals WHERE created_sequence <= ${sequence}`
              : sql`DELETE FROM computer_use_session_approvals WHERE thread_id = ${threadId} AND created_sequence <= ${sequence}`;
          }),
        )
        .pipe(Effect.mapError(unavailable)),
  );
  const record = Effect.fn("Handoffs.recordComputerUseScope")(
    function* (input: HandoffRespondInput, result: Handoff) {
      if (
        result.target.path === COMPUTER_USE_GRANT_HANDOFF_PATH &&
        result.state === "completed" &&
        result.actor.type === "client"
      )
        yield* sql`INSERT OR IGNORE INTO computer_use_person_approval (id) VALUES (1)`;
      if (result.state === "completed" && input.computerUseScope && result.apps) {
        if (input.computerUseScope === "session") {
          for (const app of result.apps)
            yield* sql`INSERT INTO computer_use_session_approvals (thread_id, app_key, created_sequence) VALUES (${input.threadId}, ${cuaAppKey(app)}, (SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events WHERE command_id = ${`handoff:${result.handoffId}:completed`})) ON CONFLICT(thread_id, app_key) DO UPDATE SET created_sequence = excluded.created_sequence`;
        } else if (Option.isSome(settings)) {
          const updated = yield* settings.value.updateSettingsWith((current) =>
            Effect.succeed({ cuaAllowedApps: [...current.cuaAllowedApps, ...(result.apps ?? [])] }),
          );
          yield* syncAllowed(updated.cuaAllowedApps);
        }
      }
    },
    Effect.mapError((cause) => (isHandoffError(cause) ? cause : unavailable(cause))),
  );
  const auto = Effect.fn("Handoffs.autoComputerUse")((input: CreateInput) => {
    const attempt = withAllowedSettings((list, enabled) =>
      Effect.gen(function* () {
        if (!enabled) return yield* new HandoffError({ reason: "unavailable" });
        yield* syncAllowed(list);
        const apps = input.apps;
        if (
          input.target.path !== COMPUTER_USE_GRANT_HANDOFF_PATH ||
          apps === undefined ||
          apps.length === 0 ||
          input.computerUseForeground !== undefined ||
          apps.some(isExcludedCuaApplication)
        )
          return Option.none();
        const standing = yield* allowed(input.requestedBy.threadId, apps, list);
        const named: Array<{ readonly app: string; readonly messageId: string }> = [];
        if (!standing && input.namedMessages !== undefined && input.namedMessages.length > 0) {
          const approved = yield* sql`SELECT id FROM computer_use_person_approval LIMIT 1`.pipe(
            Effect.mapError(unavailable),
          );
          if (approved.length > 0) {
            const ids = encodeIds([
              ...new Set(input.namedMessages.map((entry) => entry.messageId)),
            ]);
            const eligible = yield* sql<{
              message_id: string;
              text: string;
            }>`SELECT ids.value AS message_id, json_extract(event.payload_json, '$.text') AS text
              FROM json_each(${ids}) AS ids
              JOIN orchestration_events AS event ON event.sequence = (
                SELECT sequence FROM orchestration_events
                WHERE application_event_version = 2 AND aggregate_kind = 'thread'
                  AND stream_id = ${input.requestedBy.threadId} AND event_type = 'message.updated'
                  AND json_extract(payload_json, '$.role') = 'user'
                  AND json_extract(payload_json, '$.id') = ids.value
                ORDER BY sequence LIMIT 1
              )
              WHERE json_extract(event.payload_json, '$.createdBy') = 'user'
                AND json_extract(event.payload_json, '$.creationSource') IN ('web', 'mobile')
                AND json_type(event.payload_json, '$.context.guest') IS NULL
                AND json_extract(event.payload_json, '$.scheduledTaskId') IS NULL
                AND json_extract(event.payload_json, '$.senderThreadId') IS NULL
                AND json_extract(event.payload_json, '$.channel') IS NULL
                AND COALESCE(json_extract(event.payload_json, '$.workflowScript'), 0) = 0
                AND event.sequence > COALESCE((SELECT MAX(sequence) FROM computer_use_revocation_watermarks
                WHERE scope IN ('', ${input.requestedBy.threadId})), 0)`.pipe(
              Effect.mapError(unavailable),
            );
            const originals = new Map(eligible.map((row) => [row.message_id, row.text]));
            const evidence = new Map<string, Array<(typeof input.namedMessages)[number]>>();
            for (const entry of input.namedMessages) {
              const original = originals.get(entry.messageId);
              if (
                typeof original !== "string" ||
                !(
                  mentions(original, entry.app) ||
                  (entry.name !== undefined && mentions(original, entry.name))
                )
              )
                continue;
              const key = cuaAppKey(entry.app);
              const entries = evidence.get(key) ?? [];
              entries.push(entry);
              evidence.set(key, entries);
            }
            for (const app of apps) {
              const already = yield* allowed(input.requestedBy.threadId, [app], list);
              if (already) continue;
              const used = yield* sql<{
                message_id: string;
              }>`SELECT message_id FROM computer_use_named_messages
                WHERE thread_id = ${input.requestedBy.threadId} AND app_key = ${cuaAppKey(app)}`.pipe(
                Effect.mapError(unavailable),
              );
              const candidates = evidence.get(cuaAppKey(app)) ?? [];
              const usedIds = new Set(used.map((row) => row.message_id));
              if (!candidates.some((entry) => !usedIds.has(entry.messageId))) return Option.none();
              named.push(...candidates);
            }
          }
        }
        if (!standing && named.length === 0) return Option.none();
        if (
          Option.isSome(leases) &&
          Option.isSome(
            yield* leases.value
              .holder(input.requestedBy.threadId, apps)
              .pipe(Effect.mapError(unavailable)),
          )
        )
          return Option.none();
        const granted = yield* deps.create(
          {
            ...input,
            reason: `${input.reason} ${named.length > 0 ? "Allowed because the person named the app." : "Allowed by a standing choice."}`,
          },
          true,
        );
        for (const entry of named) {
          yield* sql`INSERT INTO computer_use_session_approvals (thread_id, app_key, created_sequence) VALUES (${input.requestedBy.threadId}, ${cuaAppKey(entry.app)}, (SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events WHERE command_id = ${`handoff:${granted.handoffId}:create`})) ON CONFLICT(thread_id, app_key) DO UPDATE SET created_sequence = excluded.created_sequence`.pipe(
            Effect.mapError(unavailable),
          );
          yield* sql`INSERT OR IGNORE INTO computer_use_named_messages (thread_id, app_key, message_id) VALUES (${input.requestedBy.threadId}, ${cuaAppKey(entry.app)}, ${entry.messageId})`.pipe(
            Effect.mapError(unavailable),
          );
        }
        if (Option.isSome(leases)) yield* leases.value.changed;
        return Option.some(granted);
      }),
    ).pipe(lock.withPermits(1));
    return Option.isSome(leases) ? leases.value.serializeAdmission(attempt) : attempt;
  });
  const stopUnlocked = Effect.fn("Handoffs.stopComputerUseSessionsUnlocked")(function* (
    threadId: ThreadId | undefined,
    cutoff?: number,
  ) {
    const prior =
      threadId === undefined || cutoff === undefined
        ? []
        : yield* sql<{
            sequence: number;
          }>`SELECT sequence FROM computer_use_revocation_watermarks WHERE scope = ${threadId}`.pipe(
            Effect.mapError(unavailable),
          );
    const previouslyApplied =
      cutoff !== undefined && prior[0] !== undefined && prior[0].sequence >= cutoff;
    const grants = Option.isNone(leases)
      ? []
      : yield* leases.value.grants.pipe(Effect.mapError(unavailable));
    const older: Array<(typeof grants)[number]> = [];
    let hasNewer = false;
    for (const grant of grants) {
      if (threadId !== undefined && grant.threadId !== threadId) continue;
      if (cutoff !== undefined) {
        const events = yield* sql<{
          sequence: number;
        }>`SELECT sequence FROM orchestration_events WHERE application_event_version = 2 AND aggregate_kind = 'thread' AND stream_id = ${grant.threadId} AND event_type = 'turn-item.updated' AND json_extract(payload_json, '$.handoff.handoffId') = ${grant.handoffId} AND json_extract(payload_json, '$.handoff.state') = 'completed' ORDER BY sequence DESC LIMIT 1`.pipe(
          Effect.mapError(unavailable),
        );
        if (events[0] !== undefined && events[0].sequence > cutoff) {
          hasNewer = true;
          continue;
        }
      }
      older.push(grant);
    }
    const stopped = new Set<ThreadId>();
    if (Option.isSome(leases) && !hasNewer && (!previouslyApplied || older.length > 0)) {
      if (threadId === undefined) for (const id of yield* leases.value.stopAll) stopped.add(id);
      else if (yield* leases.value.stop(threadId)) stopped.add(threadId);
    }
    yield* clear(threadId, cutoff);
    if (Option.isSome(leases)) {
      for (const grant of older) {
        const handoff = yield* deps.read(grant.threadId, grant.handoffId);
        if (handoff.computerUseScope === undefined) continue;
        yield* leases.value.release([grant.handoffId]);
        yield* deps.revoke(handoff);
        stopped.add(grant.threadId);
      }
    }
    return [...stopped];
  }, lock.withPermits(1));
  const stop = Effect.fn("Handoffs.stopComputerUseSessions")((
    threadId?: ThreadId,
    cutoff?: number,
  ) => {
    const effect = stopUnlocked(threadId, cutoff);
    return Option.isSome(leases) ? leases.value.serializeAdmission(effect) : effect;
  });
  const toggle = Effect.fn("Handoffs.withComputerUseToggle")(<A, E, R>(
    enabled: boolean,
    update: Effect.Effect<A, E, R>,
  ) => {
    const effect = Effect.gen(function* () {
      if (Option.isNone(settings)) return yield* new HandoffError({ reason: "unavailable" });
      const before = yield* settings.value.getSettings.pipe(Effect.mapError(unavailable));
      if (!enabled || !before.enableCua) yield* stopUnlocked(undefined);
      return yield* update;
    });
    return Option.isSome(leases) ? leases.value.serializeAdmission(effect) : effect;
  });
  const revalidateAgainst = Effect.fn("Handoffs.revalidateComputerUseAgainst")(function* (
    list: ReadonlyArray<string>,
    threadId?: ThreadId,
    endingHandoffId?: Handoff["handoffId"],
  ) {
    if (Option.isNone(leases)) return;
    const grants = yield* leases.value.grants.pipe(Effect.mapError(unavailable));
    for (const grant of grants) {
      if (threadId !== undefined && grant.threadId !== threadId) continue;
      const handoff = yield* deps.read(grant.threadId, grant.handoffId);
      if (handoff.computerUseScope === undefined || handoff.apps === undefined) continue;
      if (yield* allowed(grant.threadId, handoff.apps, list)) continue;
      yield* leases.value.release([grant.handoffId]);
      if (grant.handoffId !== endingHandoffId) yield* deps.revoke(handoff);
    }
  });
  const revalidateUnlocked = (threadId?: ThreadId, endingHandoffId?: Handoff["handoffId"]) =>
    withAllowedSettings((list) =>
      Effect.gen(function* () {
        yield* syncAllowed(list);
        yield* revalidateAgainst(list, threadId, endingHandoffId);
      }),
    );
  const revalidate = Effect.fn("Handoffs.revalidateComputerUse")((threadId?: ThreadId) => {
    const effect = revalidateUnlocked(threadId).pipe(lock.withPermits(1));
    return Option.isSome(leases) ? leases.value.serializeAdmission(effect) : effect;
  });
  const observeSettings = Effect.fn("Handoffs.observeComputerUseSettings")((
    list: ReadonlyArray<string>,
  ) => {
    const effect = Effect.gen(function* () {
      yield* syncAllowed(list);
      yield* revalidateAgainst(list);
    }).pipe(lock.withPermits(1));
    return Option.isSome(leases) ? leases.value.serializeAdmission(effect) : effect;
  });
  const withSettings = Effect.fn("Handoffs.withComputerUseSettings")(<A, E, R>(
    patch: { readonly enableCua?: boolean; readonly cuaAllowedApps?: ReadonlyArray<string> },
    update: Effect.Effect<A, E, R>,
  ) => {
    const effect = Effect.gen(function* () {
      if (Option.isNone(settings)) return yield* new HandoffError({ reason: "unavailable" });
      const before = yield* settings.value.getSettings.pipe(Effect.mapError(unavailable));
      if (patch.cuaAllowedApps !== undefined) {
        const next = new Set(patch.cuaAllowedApps.map(cuaAppKey));
        if (before.cuaAllowedApps.some((app) => !next.has(cuaAppKey(app))))
          yield* sql`INSERT INTO computer_use_revocation_watermarks (scope, sequence)
            VALUES ('', (SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events))
            ON CONFLICT(scope) DO UPDATE SET sequence = MAX(sequence, excluded.sequence)`.pipe(
            Effect.mapError(unavailable),
          );
      }
      if (patch.enableCua !== undefined && (!patch.enableCua || !before.enableCua))
        yield* stopUnlocked(undefined);
      const result = yield* update;
      if (patch.cuaAllowedApps !== undefined) yield* revalidateUnlocked().pipe(lock.withPermits(1));
      return result;
    });
    return Option.isSome(leases) ? leases.value.serializeAdmission(effect) : effect;
  });
  const end = Effect.fn("Handoffs.endComputerUseSession")(function* (
    threadId: ThreadId,
    handoffId: Handoff["handoffId"],
  ) {
    yield* clear(threadId);
    if (Option.isSome(leases)) yield* leases.value.release([handoffId]);
    yield* revalidateUnlocked(threadId, handoffId);
  });
  return {
    validate,
    record,
    clear,
    auto,
    stop,
    revalidate,
    toggle,
    end,
    withSettings,
    observeSettings,
  };
};
