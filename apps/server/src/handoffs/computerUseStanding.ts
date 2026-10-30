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
import type * as Semaphore from "effect/Semaphore";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as ComputerUseLeases from "../cua/ComputerUseLeases.ts";
import type * as ServerSettings from "../serverSettings.ts";
import type * as DateTime from "effect/DateTime";
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
};

const unavailable = (cause: unknown) => new HandoffError({ reason: "unavailable", cause });

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
    use: (list: ReadonlyArray<string>) => Effect.Effect<A, HandoffError>,
  ) =>
    Option.isSome(settings)
      ? settings.value
          .withSettingsSnapshot((snapshot) => use(snapshot.cuaAllowedApps))
          .pipe(Effect.mapError(unavailable))
      : use([]);
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
  const clear = Effect.fn("Handoffs.clearComputerUseSessions")((threadId?: ThreadId) =>
    (threadId === undefined
      ? sql`DELETE FROM computer_use_session_approvals`
      : sql`DELETE FROM computer_use_session_approvals WHERE thread_id = ${threadId}`
    ).pipe(Effect.asVoid, Effect.mapError(unavailable)),
  );
  const record = Effect.fn("Handoffs.recordComputerUseScope")(function* (
    input: HandoffRespondInput,
    result: Handoff,
    endsApproved: boolean,
  ) {
    if (result.state === "completed" && input.computerUseScope && result.apps) {
      if (input.computerUseScope === "session") {
        for (const app of result.apps)
          yield* sql`INSERT OR IGNORE INTO computer_use_session_approvals (thread_id, app_key) VALUES (${input.threadId}, ${cuaAppKey(app)})`.pipe(
            Effect.mapError(unavailable),
          );
      } else if (Option.isSome(settings)) {
        yield* settings.value
          .updateSettingsWith((current) =>
            Effect.succeed({ cuaAllowedApps: [...current.cuaAllowedApps, ...(result.apps ?? [])] }),
          )
          .pipe(Effect.mapError(unavailable));
      }
    }
    if (endsApproved) yield* clear(input.threadId);
  });
  const auto = Effect.fn("Handoffs.autoComputerUse")((input: CreateInput) => {
    const attempt = withAllowedSettings((list) =>
      Effect.gen(function* () {
        const apps = input.apps;
        if (
          input.target.path !== COMPUTER_USE_GRANT_HANDOFF_PATH ||
          apps === undefined ||
          apps.length === 0 ||
          input.computerUseForeground !== undefined ||
          apps.some(isExcludedCuaApplication)
        )
          return Option.none();
        if (!(yield* allowed(input.requestedBy.threadId, apps, list))) return Option.none();
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
          { ...input, reason: `${input.reason} Allowed by a standing choice.` },
          true,
        );
        if (Option.isSome(leases)) yield* leases.value.changed;
        return Option.some(granted);
      }),
    ).pipe(lock.withPermits(1));
    return Option.isSome(leases) ? leases.value.serializeAdmission(attempt) : attempt;
  });
  const stopUnlocked = Effect.fn("Handoffs.stopComputerUseSessionsUnlocked")(function* (
    threadId?: ThreadId,
  ) {
    const stopped = new Set(
      Option.isNone(leases)
        ? []
        : threadId === undefined
          ? yield* leases.value.stopAll
          : (yield* leases.value.stop(threadId))
            ? [threadId]
            : [],
    );
    yield* clear(threadId);
    if (Option.isSome(leases)) {
      const grants = yield* leases.value.grants.pipe(Effect.mapError(unavailable));
      for (const grant of grants) {
        if (threadId !== undefined && grant.threadId !== threadId) continue;
        const handoff = yield* deps.read(grant.threadId, grant.handoffId);
        if (handoff.computerUseScope === undefined) continue;
        yield* leases.value.release([grant.handoffId]);
        yield* deps.revoke(handoff);
        stopped.add(grant.threadId);
      }
    }
    return [...stopped];
  }, lock.withPermits(1));
  const stop = Effect.fn("Handoffs.stopComputerUseSessions")((threadId?: ThreadId) => {
    const effect = stopUnlocked(threadId);
    return Option.isSome(leases) ? leases.value.serializeAdmission(effect) : effect;
  });
  const toggle = Effect.fn("Handoffs.withComputerUseToggle")(<A, E, R>(
    enabled: boolean,
    update: Effect.Effect<A, E, R>,
  ) => {
    const effect = Effect.gen(function* () {
      if (Option.isNone(settings)) return yield* new HandoffError({ reason: "unavailable" });
      const before = yield* settings.value.getSettings.pipe(Effect.mapError(unavailable));
      if (!enabled || !before.enableCua) yield* stopUnlocked();
      return yield* update;
    });
    return Option.isSome(leases) ? leases.value.serializeAdmission(effect) : effect;
  });
  const revalidate = Effect.fn("Handoffs.revalidateComputerUse")((threadId?: ThreadId) => {
    const effect = withAllowedSettings((list) =>
      Effect.gen(function* () {
        if (Option.isNone(leases)) return;
        const grants = yield* leases.value.grants.pipe(Effect.mapError(unavailable));
        for (const grant of grants) {
          if (threadId !== undefined && grant.threadId !== threadId) continue;
          const handoff = yield* deps.read(grant.threadId, grant.handoffId);
          if (
            (handoff.computerUseScope !== "always" && handoff.computerUseScope !== "standing") ||
            handoff.apps === undefined
          )
            continue;
          if (yield* allowed(grant.threadId, handoff.apps, list)) continue;
          yield* leases.value.release([grant.handoffId]);
          yield* deps.revoke(handoff);
        }
      }),
    ).pipe(lock.withPermits(1));
    return Option.isSome(leases) ? leases.value.serializeAdmission(effect) : effect;
  });
  return { validate, record, clear, auto, stop, revalidate, toggle };
};
