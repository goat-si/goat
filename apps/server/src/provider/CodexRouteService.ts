import {
  CodexSettings,
  DEFAULT_OPENCODEX_BASE_URL,
  ServerSettingsError,
  type AuthSessionId,
  type EnvironmentId,
  type ProviderInstanceId,
  type ProviderInstanceMutation,
  type ProviderInstanceConfig,
  type ServerSettings,
  type ServerSettingsPatch,
  type TurnItemId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- fingerprints and process-local revision epochs contain no plaintext configuration.
import * as NodeCrypto from "node:crypto";
import * as Settings from "../serverSettings.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as Environment from "../environment/ServerEnvironment.ts";

export type SettingsRevision = { readonly epoch: string; readonly sequence: number };
export type ApprovedInstancePrecondition = {
  readonly handoffId: TurnItemId;
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly expectedFingerprint: string;
  readonly expectedRevision: SettingsRevision;
  readonly expiresAt?: number;
};
export const instanceFingerprint = (instance: unknown) =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify(instance, (_key, value: unknown) =>
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
          : value,
      ) ?? "null",
    )
    .digest("hex");
class ProviderInstanceBusyError extends ServerSettingsError {
  override get message() {
    return "Wait for this instance's active turns to finish before changing its model route.";
  }
}
class RouteSettingsError extends ServerSettingsError {
  declare readonly explanation: string;
  static explained(explanation: string) {
    return Object.assign(
      new RouteSettingsError({ settingsPath: "<provider-route>", operation: "normalize" }),
      { explanation },
    );
  }
  override get message() {
    return this.explanation;
  }
}
const decodeCodex = Schema.decodeUnknownOption(CodexSettings);
const routeKey = (instance: ProviderInstanceConfig | undefined) => {
  if (instance?.driver !== "codex") return undefined;
  const config = decodeCodex(instance.config ?? {});
  if (Option.isNone(config)) return "invalid";
  const base = config.value.opencodexBaseUrl.trim() || DEFAULT_OPENCODEX_BASE_URL;
  try {
    return `${config.value.modelRoute}:${new URL(base).toString().replace(/\/+$/, "")}`;
  } catch {
    return `${config.value.modelRoute}:invalid:${base}`;
  }
};
/** Internal coordination port. Settings owns persistence; the facade owns authorization.
 * The short admission lock serializes reservation with atomic settings commits;
 * pending revisions fence only the affected instances while hydration runs. */
export class CodexRouteState extends Context.Service<
  CodexRouteState,
  {
    readonly admission: Semaphore.Semaphore;
    readonly revision: () => SettingsRevision;
    readonly reserveUse: (
      id: ProviderInstanceId,
    ) => Effect.Effect<void, ServerSettingsError, Scope.Scope>;
    readonly validate: (
      current: ServerSettings,
      next: ServerSettings,
      approval?: ApprovedInstancePrecondition,
    ) => Effect.Effect<void, ServerSettingsError>;
    readonly committed: (
      current: ServerSettings,
      next: ServerSettings,
    ) => Effect.Effect<SettingsRevision>;
    readonly applied: (revision: SettingsRevision, failed?: boolean) => Effect.Effect<void>;
    readonly watcherStopped: Effect.Effect<void>;
    readonly awaitApplied: (
      ids: ReadonlyArray<ProviderInstanceId>,
    ) => Effect.Effect<void, ServerSettingsError>;
  }
>()("goat/provider/CodexRouteService/CodexRouteState") {}
const makeState = Effect.gen(function* () {
  const admission = yield* Semaphore.make(1);
  const epoch = NodeCrypto.randomUUID();
  let sequence = 0;
  const leases = new Map<string, number>();
  const pending = new Map<
    number,
    {
      readonly ids: ReadonlyArray<string>;
      readonly ack: Deferred.Deferred<void, ServerSettingsError>;
    }
  >();
  const revision = () => ({ epoch, sequence });
  const awaitApplied = (ids: ReadonlyArray<ProviderInstanceId>) =>
    Effect.forEach(
      [...pending.values()].filter((entry) =>
        entry.ids.some((id) => ids.includes(id as ProviderInstanceId)),
      ),
      ({ ack }) => Deferred.await(ack),
      { discard: true },
    ).pipe(
      Effect.timeout("30 seconds"),
      Effect.mapError(() =>
        RouteSettingsError.explained(
          "Settings may be saved, but provider application is unconfirmed. Refresh and retry.",
        ),
      ),
    );
  return CodexRouteState.of({
    admission,
    revision,
    reserveUse: (id) =>
      admission.withPermits(1)(
        Effect.acquireRelease(
          Effect.gen(function* () {
            if ([...pending.values()].some((entry) => entry.ids.includes(id)))
              return yield* RouteSettingsError.explained(
                "Provider settings are awaiting application. Refresh and retry.",
              );
            leases.set(id, (leases.get(id) ?? 0) + 1);
          }),
          () =>
            Effect.sync(() => {
              const count = (leases.get(id) ?? 1) - 1;
              if (count === 0) leases.delete(id);
              else leases.set(id, count);
            }),
        ),
      ),
    validate: (current, next, approval) =>
      Effect.gen(function* () {
        // Called only under both admission and the settings write lock. Check
        // approval before no-op/create retries or secret materialization.
        if (
          approval?.expiresAt !== undefined &&
          approval.expiresAt <= DateTime.toEpochMillis(yield* DateTime.now)
        )
          return yield* RouteSettingsError.explained("This approval expired. Ask again.");
        if (
          approval &&
          (approval.expectedRevision.epoch !== epoch ||
            approval.expectedRevision.sequence !== sequence ||
            instanceFingerprint(current.providerInstances[approval.instanceId]) !==
              approval.expectedFingerprint ||
            current.providerInstances[approval.instanceId]?.driver !== "codex")
        )
          return yield* RouteSettingsError.explained("This approval is stale. Ask again.");
        for (const rawId of new Set([
          ...Object.keys(current.providerInstances),
          ...Object.keys(next.providerInstances),
        ])) {
          const id = rawId as ProviderInstanceId;
          if (
            instanceFingerprint(current.providerInstances[id]) !==
              instanceFingerprint(next.providerInstances[id]) &&
            [...pending.values()].some((entry) => entry.ids.includes(id))
          )
            return yield* RouteSettingsError.explained(
              "Provider settings are awaiting application. Refresh and retry.",
            );
          if (
            routeKey(current.providerInstances[id]) !== routeKey(next.providerInstances[id]) &&
            (leases.get(id) ?? 0) > 0
          )
            return yield* new ProviderInstanceBusyError({
              settingsPath: "<provider-route>",
              operation: "normalize",
              providerInstanceId: id,
              code: "provider_instance_busy",
            });
        }
      }),
    committed: (current, next) =>
      Effect.gen(function* () {
        sequence++;
        const ids = [
          ...new Set([
            ...Object.keys(current.providerInstances),
            ...Object.keys(next.providerInstances),
          ]),
        ]
          .map((id) => id as ProviderInstanceId)
          .filter(
            (id) =>
              instanceFingerprint(current.providerInstances[id]) !==
              instanceFingerprint(next.providerInstances[id]),
          );
        if (ids.length > 0)
          pending.set(sequence, { ids, ack: yield* Deferred.make<void, ServerSettingsError>() });
        return revision();
      }),
    applied: (applied, failed = false) =>
      Effect.gen(function* () {
        if (applied.epoch !== epoch) return;
        const entry = pending.get(applied.sequence);
        if (!entry) return;
        if (failed) {
          yield* Deferred.fail(
            entry.ack,
            RouteSettingsError.explained(
              "Settings may be saved, but provider application failed. Refresh and retry.",
            ),
          );
          return;
        }
        yield* Deferred.succeed(entry.ack, undefined);
        pending.delete(applied.sequence);
      }),
    watcherStopped: Effect.suspend(() =>
      Effect.forEach(
        [...pending.values()],
        ({ ack }) =>
          Deferred.fail(
            ack,
            RouteSettingsError.explained(
              "Settings may be saved, but the provider watcher stopped. Refresh and retry.",
            ),
          ),
        { discard: true },
      ),
    ),
    awaitApplied,
  });
});
export const layerState = Layer.effect(CodexRouteState, makeState);

export class CodexRouteService extends Context.Service<
  CodexRouteService,
  {
    readonly mutateProviderInstance: (
      input: { readonly mutation: ProviderInstanceMutation; readonly patch?: ServerSettingsPatch },
      caller: { readonly kind: "client"; readonly sessionId: AuthSessionId },
      approval?: ApprovedInstancePrecondition,
    ) => Effect.Effect<ServerSettings, ServerSettingsError>;
    readonly reserveUse: (
      id: ProviderInstanceId,
    ) => Effect.Effect<void, ServerSettingsError, Scope.Scope>;
    readonly capture: (id: ProviderInstanceId) => Effect.Effect<
      {
        readonly instance: ProviderInstanceConfig;
        readonly fingerprint: string;
        readonly revision: SettingsRevision;
      },
      ServerSettingsError
    >;
  }
>()("goat/provider/CodexRouteService") {}
const make = Effect.gen(function* () {
  const state = yield* CodexRouteState;
  const settings = yield* Settings.ServerSettingsService;
  const sessions = yield* SessionStore.SessionStore;
  const environment = yield* Environment.ServerEnvironmentIdentity;
  return CodexRouteService.of({
    reserveUse: state.reserveUse,
    capture: (id) =>
      (settings.withStoredSettingsSnapshot ?? settings.withSettingsSnapshot)((snapshot) =>
        Effect.gen(function* () {
          const instance = snapshot.providerInstances[id];
          if (!instance || instance.driver !== "codex")
            return yield* RouteSettingsError.explained("Choose an existing Codex instance.");
          return {
            instance,
            fingerprint: instanceFingerprint(instance),
            revision: state.revision(),
          };
        }),
      ),
    mutateProviderInstance: (input, caller, approval) =>
      Effect.gen(function* () {
        const authorize = Effect.gen(function* () {
          const active = yield* sessions
            .listActive()
            .pipe(
              Effect.mapError(() =>
                RouteSettingsError.explained("Could not authorize this client."),
              ),
            );
          const session = active.find((value) => value.sessionId === caller.sessionId);
          const permissions = session?.permissions ?? session?.scopes ?? [];
          if (
            !session ||
            !permissions.includes("providers:manage") ||
            (approval && !permissions.includes("orchestration:operate"))
          )
            return yield* RouteSettingsError.explained("This client cannot manage providers.");
        });
        yield* authorize;
        if (
          approval &&
          (approval.environmentId !== (yield* environment.getEnvironmentId) ||
            approval.instanceId !== input.mutation.instanceId)
        )
          return yield* RouteSettingsError.explained("This approval is stale. Ask again.");
        return yield* settings.updateProviderInstance(
          input.mutation,
          input.patch,
          approval,
          authorize,
        );
      }),
  });
});
export const layer = Layer.effect(CodexRouteService, make);
