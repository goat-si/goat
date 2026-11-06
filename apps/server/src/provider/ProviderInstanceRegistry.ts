import { providerConfigSecret, providerSecretReferences } from "./providerConfigSecrets.ts";
import {
  providerInstanceConfigEnabledFlag,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ProviderDriverKind,
  type ServerProvider,
  type SecretReference,
  type ServerSettings,
} from "@goat/contracts";
import * as NodeUtil from "node:util";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { buildUnavailableProviderSnapshot } from "./unavailableProviderSnapshot.ts";
import * as ProviderInstanceRegistryMutator from "./ProviderInstanceRegistryMutator.ts";
import type { AnyProviderDriver, ProviderInstance } from "@goat/provider-core/server/driver";

export class ProviderInstanceRegistry extends Context.Service<
  ProviderInstanceRegistry,
  {
    readonly getInstance: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<ProviderInstance | undefined>;
    readonly listInstances: Effect.Effect<ReadonlyArray<ProviderInstance>>;
    readonly listUnavailable: Effect.Effect<ReadonlyArray<ServerProvider>>;
    /** streamChanges subscribes on consumption; use subscribeChanges before forking to avoid missing the next publish. */
    readonly streamChanges: Stream.Stream<void>;
    readonly subscribeChanges: Effect.Effect<PubSub.Subscription<void>, never, Scope.Scope>;
    readonly reloadSecrets?: (instanceId?: ProviderInstanceId) => Effect.Effect<void>;
  }
>()("goat/provider/ProviderInstanceRegistry") {}

interface LiveEntry {
  readonly instance: ProviderInstance;
  readonly scope: Scope.Closeable;
  readonly entry: ProviderInstanceConfig;
  readonly providerConfigs: ReadonlyArray<unknown>;
  readonly resolvedSecrets: ReadonlyArray<string>;
}

const providerConfigsFor = (
  entry: ProviderInstanceConfig,
  providers: ServerSettings["secretProviders"] | undefined,
) => providerSecretReferences(entry).map((reference) => providers?.[reference.provider]);

interface RegistryState {
  readonly entries: Ref.Ref<ReadonlyMap<ProviderInstanceId, LiveEntry>>;
  readonly unavailable: Ref.Ref<ReadonlyMap<ProviderInstanceId, ServerProvider>>;
  readonly changes: PubSub.PubSub<void>;
  readonly unreadable: Ref.Ref<
    ReadonlyMap<
      ProviderInstanceId,
      { entry: ProviderInstanceConfig; providerConfigs: ReadonlyArray<unknown> }
    >
  >;
}

const entryEqual = (a: ProviderInstanceConfig, b: ProviderInstanceConfig): boolean =>
  Equal.equals(a, b);
class SecretReadUnavailable extends Schema.TaggedError<SecretReadUnavailable>()(
  "SecretReadUnavailable",
  {},
) {}
const referenceKey = (reference: SecretReference) =>
  `${reference.provider}\u0000${reference.reference}`;

/**
 * An explicit false on either the envelope or the raw config blob wins (most
 * restrictive) — old settings files can carry both flags with conflicting
 * values, and a user's disable must never be silently undone.
 */
export const resolveEntryEnabled = (
  entry: ProviderInstanceConfig,
  typedConfig: unknown,
): boolean => {
  const rawConfigEnabled = providerInstanceConfigEnabledFlag(entry.config);
  if (entry.enabled === false || rawConfigEnabled === false) {
    return false;
  }
  return entry.enabled ?? providerInstanceConfigEnabledFlag(typedConfig) ?? true;
};

const buildEntry = Effect.fn("ProviderInstanceRegistry.buildEntry")(function* <R>(input: {
  readonly driversById: ReadonlyMap<ProviderDriverKind, AnyProviderDriver<R>>;
  readonly parentScope: Scope.Scope;
  readonly instanceId: ProviderInstanceId;
  readonly rawInstanceId: string;
  readonly entry: ProviderInstanceConfig;
  readonly resolveSecret?: (reference: SecretReference) => Effect.Effect<string, Error>;
  readonly providerConfigs: ReadonlyArray<unknown>;
  readonly deferSecrets: boolean;
}): Effect.fn.Return<
  | { readonly kind: "live"; readonly live: LiveEntry }
  | {
      readonly kind: "unavailable";
      readonly snapshot: ServerProvider;
      readonly secretsUnreadable?: true;
    },
  never,
  R
> {
  const { driversById, parentScope, instanceId, rawInstanceId, entry, resolveSecret } = input;
  const driver = driversById.get(entry.driver);
  if (!driver) {
    return {
      kind: "unavailable" as const,
      snapshot: yield* buildUnavailableProviderSnapshot({
        driverKind: entry.driver,
        instanceId,
        displayName: entry.displayName,
        accentColor: entry.accentColor,
        reason: `Driver '${entry.driver}' is not registered in this build.`,
      }),
    };
  }

  const decoder = Schema.decodeUnknownEffect(driver.configSchema);
  const decodeResult = yield* decoder(entry.config ?? driver.defaultConfig()).pipe(Effect.result);
  if (decodeResult._tag === "Failure") {
    const issue = decodeResult.failure;
    const detail = issue.message ?? String(issue);
    yield* Effect.logError("Failed to decode provider instance config", {
      instanceId: rawInstanceId,
      driver: entry.driver,
      detail,
    });
    return {
      kind: "unavailable" as const,
      snapshot: yield* buildUnavailableProviderSnapshot({
        driverKind: entry.driver,
        instanceId,
        displayName: entry.displayName,
        accentColor: entry.accentColor,
        reason: `Invalid config for instance '${rawInstanceId}': ${detail}`,
      }),
    };
  }

  const typedConfig = decodeResult.success;
  const enabled = resolveEntryEnabled(entry, typedConfig);
  if (enabled && input.deferSecrets && providerSecretReferences(entry).length > 0) {
    return {
      kind: "unavailable" as const,
      snapshot: yield* buildUnavailableProviderSnapshot({
        driverKind: entry.driver,
        instanceId,
        displayName: entry.displayName,
        accentColor: entry.accentColor,
        reason: "Reading secrets…",
      }),
    };
  }
  if (enabled && providerSecretReferences(entry).length > 32) {
    return {
      kind: "unavailable" as const,
      snapshot: yield* buildUnavailableProviderSnapshot({
        driverKind: entry.driver,
        instanceId,
        displayName: entry.displayName,
        accentColor: entry.accentColor,
        reason: "Too many secret references for this provider.",
      }),
    };
  }
  const result = yield* Effect.gen(function* () {
    const environment = [];
    const resolvedSecrets: string[] = [];
    for (const variable of entry.environment ?? []) {
      const { secret, ...plain } = variable;
      if (secret === undefined) {
        environment.push(plain);
        continue;
      }
      if (!enabled) continue;
      const value = resolveSecret ? yield* resolveSecret(secret).pipe(Effect.option) : undefined;
      if (value === undefined || value._tag === "None")
        return { kind: "unreadable" as const, name: variable.name };
      environment.push({ ...plain, value: value.value, sensitive: true });
      resolvedSecrets.push(value.value);
    }
    const configSecret = providerConfigSecret(entry);
    let config = typedConfig;
    if (!enabled && configSecret) config = { ...typedConfig, [configSecret.field]: "" };
    if (enabled && configSecret) {
      const value = resolveSecret
        ? yield* resolveSecret(configSecret.reference).pipe(Effect.option)
        : undefined;
      if (value === undefined || value._tag === "None" || !value.value.trim())
        return { kind: "unreadable" as const, name: configSecret.field };
      config = { ...typedConfig, [configSecret.field]: value.value };
      resolvedSecrets.push(value.value);
    }
    return { kind: "resolved" as const, environment, resolvedSecrets, config };
  }).pipe(Effect.timeoutOption("45 seconds"));
  if (result._tag === "None" || result.value.kind === "unreadable") {
    const reason =
      result._tag === "None"
        ? "Secret provider did not answer in time."
        : `Could not read ${result.value.name} from its secret provider.`;
    return {
      kind: "unavailable" as const,
      secretsUnreadable: true as const,
      snapshot: yield* buildUnavailableProviderSnapshot({
        driverKind: entry.driver,
        instanceId,
        displayName: entry.displayName,
        accentColor: entry.accentColor,
        reason,
      }),
    };
  }
  const { environment, resolvedSecrets, config } = result.value;
  const childScope = yield* Scope.fork(parentScope);

  const createResult = yield* driver
    .create({
      instanceId,
      displayName: entry.displayName,
      accentColor: entry.accentColor,
      environment,
      enabled,
      config,
    })
    .pipe(Effect.provideService(Scope.Scope, childScope), Effect.result);
  if (createResult._tag === "Failure") {
    const detail =
      providerSecretReferences(entry).length > 0
        ? "Provider initialization failed."
        : createResult.failure.detail;
    yield* Effect.logError("Failed to create provider instance", {
      instanceId: rawInstanceId,
      driver: entry.driver,
      detail,
    });
    yield* Scope.close(childScope, Exit.void).pipe(Effect.ignore);
    return {
      kind: "unavailable" as const,
      snapshot: yield* buildUnavailableProviderSnapshot({
        driverKind: entry.driver,
        instanceId,
        displayName: entry.displayName,
        accentColor: entry.accentColor,
        reason: `Driver '${entry.driver}' failed to create instance: ${detail}`,
      }),
    };
  }

  return {
    kind: "live" as const,
    live: {
      instance: createResult.success,
      scope: childScope,
      entry,
      providerConfigs: input.providerConfigs,
      resolvedSecrets,
    },
  };
});

const makeReconcile = <R>(input: {
  readonly state: RegistryState;
  readonly driversById: ReadonlyMap<ProviderDriverKind, AnyProviderDriver<R>>;
  readonly parentScope: Scope.Scope;
  readonly resolveSecret?: (reference: SecretReference) => Effect.Effect<string, Error>;
}): ((
  configMap: ProviderInstanceConfigMap,
  secretProviders?: ServerSettings["secretProviders"],
  rebuild?: ReadonlySet<ProviderInstanceId>,
  deferSecrets?: boolean,
  resolveOverride?: (reference: SecretReference) => Effect.Effect<string, Error>,
) => Effect.Effect<void, never, R>) => {
  const { state, driversById, parentScope, resolveSecret } = input;
  return (configMap, secretProviders, rebuild, deferSecrets, resolveOverride) =>
    Effect.gen(function* () {
      const previousEntries = yield* Ref.get(state.entries);
      const previousUnavailable = yield* Ref.get(state.unavailable);
      const previousUnreadable = yield* Ref.get(state.unreadable);
      const nextRaw = Object.entries(configMap);
      const nextKeys = new Set<ProviderInstanceId>(
        nextRaw.map(([raw]) => ProviderInstanceId.make(raw)),
      );

      // Close changed/removed scopes before replacements to preserve one live scope per id.
      const removedIds: Array<ProviderInstanceId> = [];
      const replacedIds = new Set<ProviderInstanceId>();
      for (const [instanceId, live] of previousEntries) {
        if (!nextKeys.has(instanceId)) {
          removedIds.push(instanceId);
          continue;
        }
        const nextEntry = configMap[instanceId];
        if (
          nextEntry !== undefined &&
          (rebuild?.has(instanceId) ||
            !entryEqual(live.entry, nextEntry) ||
            !NodeUtil.isDeepStrictEqual(
              live.providerConfigs,
              providerConfigsFor(nextEntry, secretProviders),
            ))
        ) {
          replacedIds.add(instanceId);
        }
      }
      const retiredIds = [...removedIds, ...replacedIds];
      if (retiredIds.length > 0) {
        const remaining = new Map(previousEntries);
        for (const id of retiredIds) remaining.delete(id);
        yield* Ref.set(state.entries, remaining);
      }
      for (const id of retiredIds) {
        const live = previousEntries.get(id);
        if (live) {
          yield* Scope.close(live.scope, Exit.void).pipe(Effect.ignore);
        }
      }

      const builtEntries = new Map<ProviderInstanceId, LiveEntry>();
      const builtUnavailable = new Map<ProviderInstanceId, ServerProvider>();
      const builtUnreadable = new Map<
        ProviderInstanceId,
        { entry: ProviderInstanceConfig; providerConfigs: ReadonlyArray<unknown> }
      >();
      let orderChanged = false;
      const previousOrder = [...previousEntries.keys()];
      const nextOrder: Array<ProviderInstanceId> = [];

      for (const [rawInstanceId, entry] of nextRaw) {
        const instanceId = ProviderInstanceId.make(rawInstanceId);
        nextOrder.push(instanceId);

        const existing = previousEntries.get(instanceId);
        if (existing !== undefined && !replacedIds.has(instanceId)) {
          builtEntries.set(instanceId, existing);
          continue;
        }
        const previousFailure = previousUnavailable.get(instanceId);
        const parked = previousUnreadable.get(instanceId);
        if (
          previousFailure &&
          parked &&
          !rebuild?.has(instanceId) &&
          entryEqual(parked.entry, entry) &&
          NodeUtil.isDeepStrictEqual(
            parked.providerConfigs,
            providerConfigsFor(entry, secretProviders),
          )
        ) {
          builtUnavailable.set(instanceId, previousFailure);
          builtUnreadable.set(instanceId, parked);
          continue;
        }
        if (rebuild !== undefined && !rebuild.has(instanceId) && previousFailure !== undefined) {
          builtUnavailable.set(instanceId, previousFailure);
          if (parked) builtUnreadable.set(instanceId, parked);
          continue;
        }

        const result = yield* buildEntry({
          driversById,
          parentScope,
          instanceId,
          rawInstanceId,
          entry,
          providerConfigs: providerConfigsFor(entry, secretProviders),
          deferSecrets: deferSecrets === true,
          ...((resolveOverride ?? resolveSecret)
            ? { resolveSecret: resolveOverride ?? resolveSecret }
            : {}),
        });
        if (result.kind === "live") {
          builtEntries.set(instanceId, result.live);
        } else {
          builtUnavailable.set(instanceId, result.snapshot);
          if (result.secretsUnreadable)
            builtUnreadable.set(instanceId, {
              entry,
              providerConfigs: providerConfigsFor(entry, secretProviders),
            });
        }
      }

      if (previousOrder.length === nextOrder.length) {
        for (let i = 0; i < previousOrder.length; i++) {
          if (previousOrder[i] !== nextOrder[i]) {
            orderChanged = true;
            break;
          }
        }
      } else {
        orderChanged = true;
      }

      const entriesChanged =
        orderChanged ||
        removedIds.length > 0 ||
        replacedIds.size > 0 ||
        builtEntries.size !== previousEntries.size;
      const unavailableChanged =
        builtUnavailable.size !== previousUnavailable.size ||
        [...builtUnavailable].some(([id, snapshot]) => {
          const prev = previousUnavailable.get(id);
          return prev === undefined || !Equal.equals(prev, snapshot);
        }) ||
        [...previousUnavailable].some(([id]) => !builtUnavailable.has(id));

      yield* Ref.set(state.entries, builtEntries);
      yield* Ref.set(state.unavailable, builtUnavailable);
      yield* Ref.set(state.unreadable, builtUnreadable);

      if (entriesChanged || unavailableChanged) {
        yield* PubSub.publish(state.changes, undefined);
      }
    });
};

export const makeProviderInstanceRegistry = Effect.fn(
  "ProviderInstanceRegistry.makeProviderInstanceRegistry",
)(function* <R>(input: {
  readonly drivers: ReadonlyArray<AnyProviderDriver<R>>;
  readonly configMap: ProviderInstanceConfigMap;
  readonly secretProviders?: ServerSettings["secretProviders"];
  readonly resolveSecret?: (reference: SecretReference) => Effect.Effect<string, Error>;
  readonly invalidateSecrets?: () => void;
  readonly deferSecrets?: boolean;
}): Effect.fn.Return<
  {
    readonly registry: ProviderInstanceRegistry["Service"];
    readonly mutator: ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutatorShape;
  },
  never,
  R | Scope.Scope
> {
  const driversById = new Map<ProviderDriverKind, AnyProviderDriver<R>>(
    input.drivers.map((driver) => [driver.driverKind, driver]),
  );

  // Capture the enclosing scope so per-instance child scopes can be
  // attached to it at `reconcile` time. Without this, `reconcile`
  // called later (e.g. from the hydration layer) would attach child
  // scopes to the *caller's* scope instead of the registry's.
  const parentScope = yield* Scope.Scope;

  const driverContext = yield* Effect.context<R>();

  const entries = yield* Ref.make<ReadonlyMap<ProviderInstanceId, LiveEntry>>(new Map());
  const unavailable = yield* Ref.make<ReadonlyMap<ProviderInstanceId, ServerProvider>>(new Map());
  const changes = yield* PubSub.unbounded<void>();
  yield* Effect.addFinalizer(() => PubSub.shutdown(changes));

  const unreadable = yield* Ref.make<
    ReadonlyMap<
      ProviderInstanceId,
      { entry: ProviderInstanceConfig; providerConfigs: ReadonlyArray<unknown> }
    >
  >(new Map());
  const state: RegistryState = { entries, unavailable, unreadable, changes };
  const reconcileSemaphore = yield* Semaphore.make(1);
  const latest = yield* Ref.make({
    configMap: input.configMap,
    secretProviders: input.secretProviders,
  });
  const reconcileWithR = makeReconcile({
    state,
    driversById,
    parentScope,
    ...(input.resolveSecret ? { resolveSecret: input.resolveSecret } : {}),
  });
  const reconcile: ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutatorShape["reconcile"] =
    (configMap, secretProviders, deferSecrets) =>
      reconcileSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const previous = yield* Ref.get(latest);
          const changed = Object.entries(configMap).some(([id, entry]) => {
            if (providerSecretReferences(entry).length === 0) return false;
            const old = previous.configMap[ProviderInstanceId.make(id)];
            return (
              old !== undefined &&
              (!entryEqual(old, entry) ||
                !NodeUtil.isDeepStrictEqual(
                  providerConfigsFor(old, previous.secretProviders),
                  providerConfigsFor(entry, secretProviders),
                ))
            );
          });
          if (changed) input.invalidateSecrets?.();
          yield* Ref.set(latest, { configMap, secretProviders });
          yield* reconcileWithR(configMap, secretProviders, undefined, deferSecrets);
        }).pipe(Effect.provideContext(driverContext)),
      );

  yield* reconcile(input.configMap, input.secretProviders, input.deferSecrets);

  const refreshSecrets = (instanceId: ProviderInstanceId | undefined, invalidate: boolean) =>
    reconcileSemaphore.withPermits(1)(
      Effect.gen(function* () {
        if (invalidate) input.invalidateSecrets?.();
        const snapshot = yield* Ref.get(latest);
        const liveEntries = yield* Ref.get(entries);
        const rebuild = new Set<ProviderInstanceId>();
        const outcomes = new Map<string, string | null>();
        const completed = new Set<ProviderInstanceId>();
        const targets: Array<{
          id: ProviderInstanceId;
          references: ReadonlyArray<SecretReference>;
          live: LiveEntry;
        }> = [];
        for (const [rawId, entry] of Object.entries(snapshot.configMap)) {
          if (instanceId !== undefined && rawId !== instanceId) continue;
          const references = providerSecretReferences(entry);
          if (references.length === 0) continue;
          const id = ProviderInstanceId.make(rawId);
          const live = liveEntries.get(id);
          if (!live) {
            rebuild.add(id);
            continue;
          }
          if (!live.instance.enabled) continue;
          targets.push({ id, references, live });
        }
        yield* Effect.gen(function* () {
          for (const { id, references, live } of targets) {
            const values: string[] = [];
            for (const reference of references) {
              const key = referenceKey(reference);
              let value = outcomes.get(key);
              if (value === undefined) {
                const result = input.resolveSecret
                  ? yield* input.resolveSecret(reference).pipe(Effect.option)
                  : undefined;
                value = result?._tag === "Some" ? result.value : null;
                outcomes.set(key, value);
              }
              if (value === null) {
                rebuild.add(id);
                break;
              }
              values.push(value);
            }
            if (!NodeUtil.isDeepStrictEqual(values, live.resolvedSecrets)) rebuild.add(id);
            completed.add(id);
          }
        }).pipe(Effect.timeoutOption("45 seconds"));
        for (const { id, references } of targets) {
          if (completed.has(id)) continue;
          rebuild.add(id);
          for (const reference of references) {
            const key = referenceKey(reference);
            if (!outcomes.has(key)) outcomes.set(key, null);
          }
        }
        const resolveOnce = (reference: SecretReference): Effect.Effect<string, Error> => {
          const value = outcomes.get(referenceKey(reference));
          if (value === null) return Effect.fail(new SecretReadUnavailable());
          if (value !== undefined) return Effect.succeed(value);
          return input.resolveSecret
            ? input.resolveSecret(reference)
            : Effect.fail(new SecretReadUnavailable());
        };
        yield* reconcileWithR(
          snapshot.configMap,
          snapshot.secretProviders,
          rebuild,
          undefined,
          resolveOnce,
        ).pipe(Effect.provideContext(driverContext));
      }),
    );

  const reloadSecrets = (instanceId?: ProviderInstanceId) => refreshSecrets(instanceId, true);

  const registry: ProviderInstanceRegistry["Service"] = {
    getInstance: (id) => Ref.get(entries).pipe(Effect.map((map) => map.get(id)?.instance)),
    listInstances: Ref.get(entries).pipe(
      Effect.map(
        (map) =>
          Array.from(map.values(), (live) => live.instance) as ReadonlyArray<ProviderInstance>,
      ),
    ),
    listUnavailable: Ref.get(unavailable).pipe(
      Effect.map((map) => Array.from(map.values()) as ReadonlyArray<ServerProvider>),
    ),
    reloadSecrets,
    get streamChanges() {
      return Stream.fromPubSub(changes);
    },
    get subscribeChanges() {
      return PubSub.subscribe(changes);
    },
  };

  const mutator: ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutatorShape = {
    reconcile,
    reloadSecrets,
    hydrateSecrets: () => refreshSecrets(undefined, false),
  };

  return { registry, mutator };
});

export const layer = <R>(input: {
  readonly drivers: ReadonlyArray<AnyProviderDriver<R>>;
  readonly configMap: ProviderInstanceConfigMap;
  readonly secretProviders?: ServerSettings["secretProviders"];
  readonly resolveSecret?: (reference: SecretReference) => Effect.Effect<string, Error>;
  readonly invalidateSecrets?: () => void;
  readonly deferSecrets?: boolean;
}): Layer.Layer<
  ProviderInstanceRegistry | ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator,
  never,
  R
> =>
  Layer.effectContext(
    makeProviderInstanceRegistry(input).pipe(
      Effect.map(({ registry, mutator }) =>
        Context.make(ProviderInstanceRegistry, registry).pipe(
          Context.add(ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator, mutator),
        ),
      ),
    ),
  ) as Layer.Layer<
    ProviderInstanceRegistry | ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator,
    never,
    R
  >;
