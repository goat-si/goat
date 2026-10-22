import {
  DEFAULT_SERVER_SETTINGS as CLIENT_DEFAULT_SERVER_SETTINGS,
  ServerSettings as ClientServerSettings,
  defaultInstanceIdForDriver,
  type EnvironmentId,
  goatclawPolicyContent,
  isProviderDriverKind,
  matchesMemorySourceReadRevokeAck,
  MEMORY_HUB_MAX_MEMBERS,
  type MemoryHubDisableInput,
  type MemoryHubDisableResult,
  MemoryHubError,
  type MemoryHubForbiddenError,
  MemoryHubSettings,
  MemoryOperationId,
  type MemoryOwnerEnrollment,
  type MemoryOwnerRemoval,
  MemoryOwnerSourceReadPolicy,
  MemoryOwnerSourceReadPolicyUpdateInput,
  type MemoryOwnerSourceReadPolicyView,
  MemoryRpcError,
  MemorySourceReadRevokeAck,
  MemorySpaceId,
  ModelSelection,
  ProjectId,
  ProjectScript,
  ProjectSettingsOverrides,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  ProviderInstanceId,
  type ProviderInstanceMutation,
  resolveProviderInstanceEnabled,
  ResponseStreamingMode,
  ServerSettingsError,
  type ServerSettingsPatch,
} from "@goat/contracts";
import { deepMerge, type DeepPartial } from "@goat/shared/Struct";
import { writeFileStringAtomically } from "@goat/shared/atomicWrite";
import { fromJsonStringPretty, fromLenientJson } from "@goat/shared/schemaJson";
import {
  applyServerSettingsPatch,
  assertNoMemoryHubSettingsPatch,
  deriveLegacyProjectOverrides,
  fallbackTextGenerationModelSelection,
  isModelSelectionProviderEnabled,
} from "@goat/shared/serverSettings";
import { resolveSymlinkTarget } from "@goat/shared/symlink";
import { normalizeThemePreference } from "@goat/shared/themePalettes";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import type * as MemoryStore from "./memory/MemoryStore.ts";
import * as CodexRoute from "./provider/CodexRouteService.ts";
import {
  readSecretFieldValues,
  sourceControlHostSecretName,
} from "./sourceControl/sourceControlHostSecrets.ts";

import { mapSettingsSecrets, SECRET_REDACTED, type SettingsSecret } from "./settingsSecrets.ts";

export {
  resolveReviewGuideModelSelection,
  resolveSourceControlWriterModelSelection,
} from "@goat/shared/serverSettings";

import { MemoryHubProvenance, MemoryHubSettingsSnapshot } from "./memory/MemoryHubSettings.ts";

const ServerSettings = Schema.Struct({
  ...ClientServerSettings.fields,
  memoryHubProvenance: Schema.NullOr(MemoryHubProvenance).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
type ServerSettings = ClientServerSettings & {
  readonly memoryHubProvenance?: MemoryHubProvenance | null;
};
const DEFAULT_SERVER_SETTINGS: ServerSettings = {
  ...CLIENT_DEFAULT_SERVER_SETTINGS,
  memoryHubProvenance: null,
};

const MemoryHubTransitionMarker = Schema.Struct({
  requestId: MemoryOperationId,
  version: Schema.Int,
  previousHubSpace: Schema.optionalKey(MemorySpaceId),
  provenance: Schema.optionalKey(Schema.NullOr(MemoryHubProvenance)),
});
type HubTransitionMarker = typeof MemoryHubTransitionMarker.Type;
const encodeServerSettings = Schema.encodeEffect(ServerSettings);
const encodeServerSettingsJson = Schema.encodeUnknownEffect(
  fromJsonStringPretty(
    Schema.Struct({
      ...ServerSettings.fields,
      _memoryHubTransition: Schema.optionalKey(MemoryHubTransitionMarker),
    }),
  ),
);
const encodeMemoryHubSettings = Schema.encodeEffect(Schema.fromJsonString(MemoryHubSettings));
const decodeMemoryHubSettings = Schema.decodeUnknownEffect(MemoryHubSettings);
const decodeServerSettings = Schema.decodeUnknownEffect(ServerSettings);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Old settings files can hold both flags with conflicting values; an explicit false on either
 * side wins so a user's disable is never silently undone.
 */
const foldProviderInstanceEnabledFlags = (settings: ServerSettings): ServerSettings => {
  let changed = false;
  const providerInstances: Record<string, ProviderInstanceConfig> = {};
  for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
    const config = instance.config;
    // Only fold boolean flags: a malformed `enabled` (e.g. `"false"`) must
    // stay in the blob so driver schema validation flags it instead of the
    // fold silently repairing the config.
    if (
      config === null ||
      typeof config !== "object" ||
      Array.isArray(config) ||
      typeof (config as { readonly enabled?: unknown }).enabled !== "boolean"
    ) {
      providerInstances[instanceId] = instance;
      continue;
    }
    const { enabled: configEnabled, ...restConfig } = config as Record<string, unknown> & {
      readonly enabled: boolean;
    };
    const resolved =
      instance.enabled === false || configEnabled === false
        ? false
        : (instance.enabled ?? configEnabled);
    changed = true;
    providerInstances[instanceId] = {
      ...instance,
      enabled: resolved,
      config: restConfig,
    } satisfies ProviderInstanceConfig;
  }
  if (!changed) {
    return settings;
  }
  return {
    ...settings,
    providerInstances: providerInstances as ServerSettings["providerInstances"],
  };
};

const normalizeServerSettings = (
  settings: ServerSettings,
): Effect.Effect<ServerSettings, ServerSettingsError> =>
  encodeServerSettings({
    ...settings,
    memoryHubProvenance: settings.memoryHubProvenance ?? null,
  }).pipe(
    Effect.flatMap(decodeServerSettings),
    Effect.map(foldProviderInstanceEnabledFlags),
    Effect.map((next) => ({ ...next, defaultTheme: normalizeThemePreference(next.defaultTheme) })),
    Effect.map((next) => ({ ...next, ...deriveLegacyProjectOverrides(next) })),
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath: "<memory>",
          operation: "normalize",
          cause,
        }),
    ),
  );

export function redactServerSettingsForClient(
  settings: ClientServerSettings,
): ClientServerSettings {
  // Persistence-only origin must not reach settings snapshots or streams.
  const { memoryHubProvenance: _provenance, ...clientSettings } = settings as ServerSettings;
  return mapSettingsSecrets(clientSettings, (secret) =>
    secret.sensitive
      ? { value: "", redacted: secret.redacted || secret.value.length > 0 }
      : { value: secret.value, redacted: false },
  );
}

export function applyProviderInstanceMutation(
  settings: ServerSettings,
  mutation: ProviderInstanceMutation,
): ServerSettings {
  const providerInstances = { ...settings.providerInstances };
  if (mutation.operation === "upsert" || mutation.operation === "create") {
    providerInstances[mutation.instanceId] = mutation.instance;
  } else {
    delete providerInstances[mutation.instanceId];
  }
  return { ...settings, providerInstances };
}

function ensureProviderInstanceMutationAllowed(
  settings: ServerSettings,
  mutation: ProviderInstanceMutation,
  settingsPath: string,
): Effect.Effect<void, ServerSettingsError> {
  if (
    mutation.operation === "create" &&
    settings.providerInstances[mutation.instanceId] !== undefined
  ) {
    return Effect.fail(
      new ServerSettingsError({
        settingsPath,
        operation: "create-provider-instance",
        providerInstanceId: mutation.instanceId,
      }),
    );
  }
  return Effect.void;
}

/** Used before any generic settings side effect, including device-host normalization. */

export const rejectMemoryHubSettingsPatch = (patch: unknown, settingsPath: string) =>
  Effect.try({
    try: () => {
      assertNoMemoryHubSettingsPatch(patch);
      if (
        patch !== null &&
        typeof patch === "object" &&
        (Object.hasOwn(patch, "memoryOwnerSourceReadPolicy") ||
          Object.hasOwn(patch, "memoryOwnerSourceReadPolicyVersion"))
      )
        throw new Error("Memory owner policy requires a dedicated transition.");
    },
    catch: (cause) => new ServerSettingsError({ settingsPath, operation: "normalize", cause }),
  });

export type MemoryHubTransition = {
  readonly requestId: MemoryOperationId;
  readonly expectedVersion: number;
  readonly settings: MemoryHubSettings;
  readonly provenance?: MemoryHubProvenance | null;
};

// The private file marker reconciles a crash after settings commit but before the
// administration SQL receipt is marked ready. It carries no credential or body.
const transitionMemoryHubSettings = <E, R>(
  current: ServerSettings,
  input: MemoryHubTransition,
  permit: Effect.Effect<void, E, R>,
  marker: HubTransitionMarker | null,
) =>
  Effect.gen(function* () {
    yield* permit;
    const settings = yield* decodeMemoryHubSettings(input.settings).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath: "memory hub transition",
            operation: "normalize",
            cause,
          }),
      ),
    );
    const provenance = input.provenance ?? null;
    if (
      provenance !== null &&
      (settings.mode !== "hub" || settings.memorySpaceId !== provenance.memorySpaceId)
    )
      return yield* new MemoryHubError({ code: "invalid_output" });
    if (current.memoryHubVersion !== input.expectedVersion) {
      if (
        current.memoryHubVersion === input.expectedVersion + 1 &&
        marker?.requestId === input.requestId &&
        marker.version === current.memoryHubVersion &&
        (current.memoryHubProvenance?.memorySpaceId ?? null) ===
          (provenance?.memorySpaceId ?? null) &&
        (marker.provenance?.memorySpaceId ?? null) === (provenance?.memorySpaceId ?? null) &&
        (yield* encodeMemoryHubSettings(current.memoryHub).pipe(
          Effect.mapError(() => new MemoryHubError({ code: "invalid_output" })),
        )) ===
          (yield* encodeMemoryHubSettings(settings).pipe(
            Effect.mapError(() => new MemoryHubError({ code: "invalid_output" })),
          ))
      )
        return current;
      return yield* new MemoryHubError({ code: "revision_changed" });
    }
    return {
      ...current,
      memoryHub: settings,
      memoryHubProvenance: provenance,
      memoryHubVersion: current.memoryHubVersion + 1,
    };
  });

export class MemoryHubSettingsTransitions extends Context.Service<
  MemoryHubSettingsTransitions,
  {
    readonly applyMemoryHubTransition: <E, R>(
      input: MemoryHubTransition,
      permit: Effect.Effect<void, E, R>,
    ) => Effect.Effect<MemoryHubSettingsSnapshot, E | ServerSettingsError | MemoryHubError, R>;
  }
>()("goat/serverSettings/MemoryHubSettingsTransitions") {}

/** Current committed hub epoch. SQL transactions must use this instead of the full cache. */
export class MemoryHubCommittedSettings extends Context.Service<
  MemoryHubCommittedSettings,
  {
    readonly read: Effect.Effect<MemoryHubSettingsSnapshot>;
    readonly readPublication?: Effect.Effect<import("@goat/contracts").MemoryHubPublication>;
  }
>()("goat/serverSettings/MemoryHubCommittedSettings") {}

/** SQL-free committed policy. An unready producer denies even the default-on setting. */
export interface MemoryProviderPolicy {
  readonly policyReady: boolean;
  readonly enableAgentMemoryAccess: boolean;
  /** Process-local; never a durable credential authority after a restart. */
  readonly epoch: number;
}

/** L2 subscribes before preparing credentials, and rotates on every published epoch. */
export class MemoryProviderCommittedPolicy extends Context.Service<
  MemoryProviderCommittedPolicy,
  {
    readonly read: Effect.Effect<MemoryProviderPolicy>;
    readonly subscribeRotations: Effect.Effect<
      Stream.Stream<MemoryProviderPolicy>,
      never,
      Scope.Scope
    >;
  }
>()("goat/serverSettings/MemoryProviderCommittedPolicy") {}

const makeMemoryProviderPolicy = Effect.gen(function* () {
  const current = yield* Ref.make<MemoryProviderPolicy>(
    Object.freeze({
      policyReady: false,
      enableAgentMemoryAccess: false,
      epoch: 0,
    }),
  );
  // Rotation needs the newest committed epoch, not a backlog of obsolete credentials.
  const rotations = yield* PubSub.sliding<MemoryProviderPolicy>(1);
  const publish = (enableAgentMemoryAccess: boolean) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const changed = yield* Ref.modify(current, (previous) => {
          if (previous.policyReady && previous.enableAgentMemoryAccess === enableAgentMemoryAccess)
            return [null, previous] as const;
          const next = Object.freeze({
            policyReady: true,
            enableAgentMemoryAccess,
            epoch: previous.epoch + 1,
          });
          return [next, next] as const;
        });
        if (changed !== null) yield* PubSub.publish(rotations, changed);
      }),
    );
  const service = {
    read: Ref.get(current),
    subscribeRotations: Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(rotations);
      const snapshot = yield* Ref.get(current);
      return Stream.make(snapshot).pipe(Stream.concat(Stream.fromSubscription(subscription)));
    }),
  } satisfies MemoryProviderCommittedPolicy["Service"];
  return { publish, service };
});

/** Disable-only administration seam. Credential installation remains in Sync's existing service. */
export class MemoryHubAdministration extends Context.Service<
  MemoryHubAdministration,
  {
    readonly disableHub: (
      input: MemoryHubDisableInput,
      permit: import("./memory/MemoryAccess.ts").MemoryPermit,
    ) => Effect.Effect<MemoryHubDisableResult, MemoryRpcError>;
  }
>()("goat/serverSettings/MemoryHubAdministration") {}

export interface MemoryOwnerSourceReadCommitted {
  readonly policy: MemoryOwnerSourceReadPolicy;
  readonly version: number;
}

export class MemoryOwnerSourceReadCommittedPolicy extends Context.Service<
  MemoryOwnerSourceReadCommittedPolicy,
  {
    readonly read: Effect.Effect<MemoryOwnerSourceReadCommitted>;
    readonly changes: Effect.Effect<
      Stream.Stream<MemoryOwnerSourceReadCommitted>,
      never,
      Scope.Scope
    >;
    readonly recordRevokeAck: (
      ack: MemorySourceReadRevokeAck,
    ) => Effect.Effect<MemoryOwnerSourceReadCommitted, ServerSettingsError | MemoryRpcError>;
  }
>()("goat/serverSettings/MemoryOwnerSourceReadCommittedPolicy") {}

export class MemoryOwnerSourceReadPolicyAdministration extends Context.Service<
  MemoryOwnerSourceReadPolicyAdministration,
  {
    readonly get: (
      permit: Effect.Effect<void, MemoryRpcError>,
    ) => Effect.Effect<MemoryOwnerSourceReadPolicyView, MemoryRpcError>;
    readonly update: (
      input: MemoryOwnerSourceReadPolicyUpdateInput,
      permit: Effect.Effect<void, MemoryRpcError>,
    ) => Effect.Effect<MemoryOwnerSourceReadPolicyView, ServerSettingsError | MemoryRpcError>;
  }
>()("goat/serverSettings/MemoryOwnerSourceReadPolicyAdministration") {}

const ownerView = ({
  policy,
  version,
}: MemoryOwnerSourceReadCommitted): MemoryOwnerSourceReadPolicyView => ({
  policy,
  version,
  revocationPropagation: policy.removals.some((r) => r.state === "pending")
    ? "pending"
    : "acknowledged",
});
const ownerProjection = (settings: ServerSettings): MemoryOwnerSourceReadCommitted => ({
  policy: settings.memoryOwnerSourceReadPolicy,
  version: settings.memoryOwnerSourceReadPolicyVersion,
});
const decodeOwnerPolicy = Schema.decodeUnknownEffect(MemoryOwnerSourceReadPolicy);
const encodeOwnerCommitted = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({ policy: MemoryOwnerSourceReadPolicy, version: Schema.Int }),
  ),
);
const decodeOwnerUpdate = Schema.decodeUnknownEffect(MemoryOwnerSourceReadPolicyUpdateInput);
const decodeOwnerAck = Schema.decodeUnknownEffect(MemorySourceReadRevokeAck);
const ownerInvalid = () => new MemoryRpcError({ code: "invalid_output" });
const ownerPairKey = (
  p: Pick<MemoryOwnerEnrollment, "memorySpaceId" | "ownerEnvironmentId" | "requesterEnvironmentId">,
) => JSON.stringify([p.memorySpaceId, p.ownerEnvironmentId, p.requesterEnvironmentId]);

const makeOwnerPolicyPublication = Effect.gen(function* () {
  const freeze = (value: MemoryOwnerSourceReadCommitted): MemoryOwnerSourceReadCommitted =>
    Object.freeze({
      version: value.version,
      policy: Object.freeze({
        ...value.policy,
        allowedRequesterEnvironmentIds: Object.freeze([
          ...value.policy.allowedRequesterEnvironmentIds,
        ]),
        removals: Object.freeze(
          value.policy.removals.map((r) =>
            Object.freeze(
              r.state === "acknowledged" ? { ...r, ack: Object.freeze({ ...r.ack }) } : { ...r },
            ),
          ),
        ),
        enrollments: Object.freeze(value.policy.enrollments.map((e) => Object.freeze({ ...e }))),
      }),
    });
  const current = yield* Ref.make(freeze(ownerProjection(DEFAULT_SERVER_SETTINGS)));
  const changes = yield* PubSub.sliding<MemoryOwnerSourceReadCommitted>(1);
  let initialized = false;
  const publish = (value: MemoryOwnerSourceReadCommitted) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const previous = yield* Ref.get(current);
        initialized = true;
        if (encodeOwnerCommitted(previous) === encodeOwnerCommitted(value)) return;
        const next = freeze(value);
        yield* Ref.set(current, next);
        yield* PubSub.publish(changes, next);
      }),
    );
  return {
    read: Ref.get(current),
    publish,
    // File watchers cannot bypass CAS, regress epochs or install enrollments.
    initialize: (settings: ServerSettings) =>
      Effect.suspend(() => (initialized ? Effect.void : publish(ownerProjection(settings)))),
    changes: Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(changes);
      const snapshot = yield* Ref.get(current);
      return Stream.make(snapshot).pipe(Stream.concat(Stream.fromSubscription(subscription)));
    }),
  };
});

// Retire acknowledged pairs only after retaining every fence in the monotone epoch.
// Active enrollments without a removal are valid; pending barriers must survive.
const normalizeOwnerPolicy = (policy: MemoryOwnerSourceReadPolicy) => ({
  ...policy,
  ownerPolicyEpoch: policy.removals.reduce(
    (epoch, removal) =>
      removal.state === "acknowledged" ? Math.max(epoch, removal.ack.revokedThroughEpoch) : epoch,
    policy.ownerPolicyEpoch,
  ),
  removals: policy.removals.filter((removal) => removal.state === "pending"),
});

const transitionOwnerPolicy = (
  current: MemoryOwnerSourceReadCommitted,
  input: MemoryOwnerSourceReadPolicyUpdateInput,
  space: MemorySpaceId | null,
  owner: EnvironmentId,
) =>
  Effect.gen(function* () {
    const value = yield* decodeOwnerUpdate(input).pipe(Effect.mapError(ownerInvalid));
    if (value.expectedVersion !== current.version)
      return yield* new MemoryRpcError({ code: "revision_changed" });
    const previous = normalizeOwnerPolicy(current.policy);
    const wanted = new Set(value.allowedRequesterEnvironmentIds);
    const enrollments: MemoryOwnerEnrollment[] = [];
    const removals: MemoryOwnerRemoval[] = [...previous.removals];
    let epoch = previous.ownerPolicyEpoch;
    const advance = () => ++epoch;
    for (const enrollment of previous.enrollments) {
      // Space changes never carry an enrollment into another pair implicitly.
      if (
        wanted.has(enrollment.requesterEnvironmentId) &&
        enrollment.memorySpaceId === space &&
        enrollment.ownerEnvironmentId === owner
      ) {
        enrollments.push(enrollment);
      } else if (enrollment.state === "active") {
        const removal: MemoryOwnerRemoval = {
          memorySpaceId: enrollment.memorySpaceId,
          ownerEnvironmentId: enrollment.ownerEnvironmentId,
          requesterEnvironmentId: enrollment.requesterEnvironmentId,
          removalEpoch: advance(),
          state: "pending",
        };
        const index = removals.findIndex((r) => ownerPairKey(r) === ownerPairKey(removal));
        if (index < 0) removals.push(removal);
        else removals[index] = removal;
      }
    }
    let enrolling = false;
    for (const requesterEnvironmentId of wanted) {
      if (enrollments.some((e) => e.requesterEnvironmentId === requesterEnvironmentId)) continue;
      if (space === null) return yield* new MemoryRpcError({ code: "bootstrap_required" });
      const pair = { memorySpaceId: space, ownerEnvironmentId: owner, requesterEnvironmentId };
      const removal = removals.find((r) => ownerPairKey(r) === ownerPairKey(pair));
      enrolling = true;
      const ownerPolicyEpoch = advance();
      enrollments.push(
        removal?.state === "pending"
          ? { ...pair, ownerPolicyEpoch, state: "pending", removalEpoch: removal.removalEpoch }
          : { ...pair, ownerPolicyEpoch, state: "active" },
      );
    }
    // Reserve a removal slot for every committed enrollment, including pending ones.
    // Revocation only moves an existing pair into removals and cannot grow this union.
    const reserved = new Set([...removals, ...enrollments].map(ownerPairKey)).size;
    if (enrolling && reserved > MEMORY_HUB_MAX_MEMBERS)
      return yield* new MemoryRpcError({
        code: "capacity_exceeded",
        capacity: {
          code: "capacity_exceeded",
          dimension: "members",
          current: reserved,
          limit: MEMORY_HUB_MAX_MEMBERS,
          reclaimable: 0,
        },
      });
    const policy = yield* decodeOwnerPolicy({
      allowedRequesterEnvironmentIds: [
        ...new Set(
          enrollments.filter((e) => e.state === "active").map((e) => e.requesterEnvironmentId),
        ),
      ],
      ownerPolicyEpoch: epoch,
      removals,
      enrollments,
    }).pipe(Effect.mapError(ownerInvalid));
    return { policy, version: current.version + 1 };
  });

const acknowledgeOwnerPolicy = (
  current: MemoryOwnerSourceReadCommitted,
  ack: MemorySourceReadRevokeAck,
) =>
  Effect.gen(function* () {
    const value = yield* decodeOwnerAck(ack).pipe(Effect.mapError(ownerInvalid));
    const match = current.policy.removals.find(
      (r) => r.state === "pending" && matchesMemorySourceReadRevokeAck(r, value),
    );
    if (!match) return current;
    const previous = normalizeOwnerPolicy(current.policy);
    let epoch = Math.max(previous.ownerPolicyEpoch, value.revokedThroughEpoch);
    const enrollments = previous.enrollments.map((e): MemoryOwnerEnrollment => {
      if (e.state !== "pending" || ownerPairKey(e) !== ownerPairKey(match)) return e;
      return {
        memorySpaceId: e.memorySpaceId,
        ownerEnvironmentId: e.ownerEnvironmentId,
        requesterEnvironmentId: e.requesterEnvironmentId,
        ownerPolicyEpoch: ++epoch,
        state: "active",
      };
    });
    const policy = yield* decodeOwnerPolicy({
      ...previous,
      ownerPolicyEpoch: epoch,
      allowedRequesterEnvironmentIds: [
        ...new Set(
          enrollments.filter((e) => e.state === "active").map((e) => e.requesterEnvironmentId),
        ),
      ],
      enrollments,
      removals: previous.removals.filter((r) => r !== match),
    }).pipe(Effect.mapError(ownerInvalid));
    return { policy, version: current.version + 1 };
  });

// All mutations share the settings semaphore; publication happens in the commit owner.
const ownerPolicyServices = (
  publication: Effect.Success<typeof makeOwnerPolicyPublication>,
  identity: Option.Option<ServerEnvironment.ServerEnvironmentIdentity["Service"]>,
  withLock: MemoryHubAdminSettings["Service"]["withLock"],
  getSettings: Effect.Effect<ServerSettings, ServerSettingsError>,
  persist: (
    update: (settings: ServerSettings) => Effect.Effect<ServerSettings, MemoryRpcError>,
  ) => Effect.Effect<ServerSettings, ServerSettingsError | MemoryRpcError>,
) => {
  const commit = (next: MemoryOwnerSourceReadCommitted) =>
    persist((settings) =>
      Effect.succeed({
        ...settings,
        memoryOwnerSourceReadPolicy: next.policy,
        memoryOwnerSourceReadPolicyVersion: next.version,
      }),
    ).pipe(Effect.andThen(publication.read));
  return {
    committed: {
      read: publication.read,
      changes: publication.changes,
      recordRevokeAck: (ack: MemorySourceReadRevokeAck) =>
        withLock(
          Effect.gen(function* () {
            const current = yield* publication.read;
            const next = yield* acknowledgeOwnerPolicy(current, ack);
            return next === current ? current : yield* commit(next);
          }),
        ),
    } satisfies MemoryOwnerSourceReadCommittedPolicy["Service"],
    administration: {
      get: (permit: Effect.Effect<void, MemoryRpcError>) =>
        permit.pipe(Effect.andThen(publication.read), Effect.map(ownerView)),
      update: (
        input: MemoryOwnerSourceReadPolicyUpdateInput,
        permit: Effect.Effect<void, MemoryRpcError>,
      ) =>
        withLock(
          Effect.gen(function* () {
            yield* permit;
            if (Option.isNone(identity)) return yield* new MemoryRpcError({ code: "unavailable" });
            const settings = yield* getSettings;
            const owner = yield* identity.value.getEnvironmentId;
            const next = yield* transitionOwnerPolicy(
              yield* publication.read,
              input,
              settings.memoryHub.mode === "disabled" ? null : settings.memoryHub.memorySpaceId,
              owner,
            );
            yield* permit;
            return ownerView(yield* commit(next));
          }),
        ),
    } satisfies MemoryOwnerSourceReadPolicyAdministration["Service"],
  };
};

const HubSettingsLock = Context.Reference<boolean>("goat/serverSettings/HubSettingsLock", {
  defaultValue: () => false,
});

/** Interface seam for the parallel L2 administrator; this layer supplies its settings owner. */
export class MemoryHubAdminSettings extends Context.Service<
  MemoryHubAdminSettings,
  {
    readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    readonly read: Effect.Effect<MemoryHubSettingsSnapshot, MemoryHubError>;
    readonly readPublication: Effect.Effect<import("@goat/contracts").MemoryHubPublication>;
    readonly readPreviousHubRequestId: Effect.Effect<MemoryOperationId | null, MemoryHubError>;
    readonly readPreviousHubSpace: Effect.Effect<MemorySpaceId | null, MemoryHubError>;
    readonly apply: (
      record: MemoryStore.AdminRecord,
      permit: Effect.Effect<void, MemoryHubForbiddenError>,
    ) => Effect.Effect<
      { readonly view: MemoryHubSettingsSnapshot },
      MemoryHubError | MemoryHubForbiddenError
    >;
  }
>()(
  // @effect-diagnostics-next-line deterministicKeys:off -- L2's separately implemented administrator consumes this runtime key.
  "goat/memory/MemoryHubService/MemoryHubAdminSettings",
) {}

const hubAdministrationSettings = (
  read: ServerSettingsService["Service"]["getSettings"],
  withLock: MemoryHubAdminSettings["Service"]["withLock"],
  marker: Effect.Effect<HubTransitionMarker | null>,
  applyLocked: MemoryHubSettingsTransitions["Service"]["applyMemoryHubTransition"],
  readPublication: MemoryHubAdminSettings["Service"]["readPublication"],
): MemoryHubAdminSettings["Service"] => ({
  withLock: (effect) => withLock(effect.pipe(Effect.provideService(HubSettingsLock, true))),
  readPublication,
  read: read.pipe(
    Effect.map((current) => ({
      settings: current.memoryHub,
      version: current.memoryHubVersion,
      provenance: current.memoryHubProvenance ?? null,
    })),
    Effect.mapError(() => new MemoryHubError({ code: "storage_failed" })),
  ),
  readPreviousHubRequestId: Effect.map(marker, (saved) => saved?.requestId ?? null),
  readPreviousHubSpace: read.pipe(
    Effect.flatMap((current) =>
      current.memoryHub.mode === "hub" && current.memoryHub.memorySpaceId !== null
        ? Effect.succeed(current.memoryHub.memorySpaceId)
        : Effect.map(marker, (saved) => saved?.previousHubSpace ?? null),
    ),
    Effect.mapError(() => new MemoryHubError({ code: "storage_failed" })),
  ),
  apply: (record, permit) =>
    Effect.gen(function* () {
      if (!(yield* HubSettingsLock)) return yield* new MemoryHubError({ code: "storage_failed" });
      yield* permit;
      const current = yield* read.pipe(
        Effect.mapError(() => new MemoryHubError({ code: "storage_failed" })),
      );
      if (record.stage !== "activated")
        return yield* new MemoryHubError({ code: "bootstrap_required" });
      const action = record.action;
      let settings = current.memoryHub;
      if (action.action === "configure") {
        settings = action.settings;
        // The administrator supplies the space only after SQL publication commits.
        if (settings.mode === "hub" && settings.memorySpaceId === null)
          return yield* new MemoryHubError({ code: "bootstrap_required" });
      } else if (action.action === "installCredential") {
        if (!record.secretName) return yield* new MemoryHubError({ code: "bootstrap_required" });
        settings = {
          mode: "member",
          hubEnvironmentId: action.hubEnvironmentId,
          endpoint: action.endpoint,
          memorySpaceId: action.memorySpaceId,
          secretName: record.secretName,
        };
      }
      const view = yield* applyLocked(
        {
          requestId: record.requestId,
          expectedVersion: record.expectedVersion,
          settings,
          provenance:
            record.initialization === "auto-initialized" &&
            settings.mode === "hub" &&
            settings.memorySpaceId !== null
              ? { source: "auto-initialized", memorySpaceId: settings.memorySpaceId }
              : action.action === "configure" || action.action === "installCredential"
                ? null
                : (current.memoryHubProvenance ?? null),
        },
        permit,
      ).pipe(
        Effect.mapError((error) =>
          error._tag === "ServerSettingsError"
            ? new MemoryHubError({ code: "storage_failed" })
            : error,
        ),
      );
      return { view };
    }),
});

export class ServerSettingsService extends Context.Service<
  ServerSettingsService,
  {
    readonly start: Effect.Effect<void, ServerSettingsError>;

    readonly ready: Effect.Effect<void, ServerSettingsError>;

    readonly getSettings: Effect.Effect<ServerSettings, ServerSettingsError>;

    readonly updateSettings: (
      patch: ServerSettingsPatch,
      /** Runs inside the write lock before the patch applies, so a revoked grant cannot commit. */
      authorizeAtCommit?: Effect.Effect<void, ServerSettingsError>,
    ) => Effect.Effect<ServerSettings, ServerSettingsError>;

    /**
     * Read-modify-write: `patchFor` sees the latest stored settings inside the
     * write lock and returns the patch to apply, so a nested key edited by
     * another writer between a caller's read and its write is never lost.
     */

    readonly updateSettingsWith: (
      patchFor: (
        current: ServerSettings,
      ) => Effect.Effect<ServerSettingsPatch, ServerSettingsError>,
      /** Runs inside the write lock before `patchFor`, so a revoked grant cannot commit. */
      authorizeAtCommit?: Effect.Effect<void, ServerSettingsError>,
    ) => Effect.Effect<ServerSettings, ServerSettingsError>;

    readonly updateProviderInstance: (
      mutation: ProviderInstanceMutation,
      patch?: ServerSettingsPatch,
      approval?: CodexRoute.ApprovedInstancePrecondition,
      authorizeAtCommit?: Effect.Effect<void, ServerSettingsError>,
    ) => Effect.Effect<ServerSettings, ServerSettingsError>;

    readonly withSettingsSnapshot: <A, E, R>(
      use: (settings: ServerSettings) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ServerSettingsError, R>;

    readonly withStoredSettingsSnapshot?: <A, E, R>(
      use: (settings: ServerSettings) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ServerSettingsError, R>;

    readonly checkpointReplicationPermit: (host: string) => Effect.Effect<
      {
        readonly choice: "on" | "off" | undefined;
        readonly publish: <A, E, R>(
          effect: Effect.Effect<A, E, R>,
        ) => Effect.Effect<Option.Option<A>, E, R>;
      },
      ServerSettingsError
    >;

    readonly streamChanges: Stream.Stream<ServerSettings>;

    /**
     * Use this before reading a snapshot when changes between the snapshot and
     * a lazily started stream must not be lost.
     */
    readonly subscribeChanges: Effect.Effect<Stream.Stream<ServerSettings>, never, Scope.Scope>;
    readonly subscribeProviderChanges?: Effect.Effect<
      Stream.Stream<
        { readonly settings: ServerSettings; readonly revision: CodexRoute.SettingsRevision },
        ServerSettingsError
      >,
      never,
      Scope.Scope
    >;
  }
>()("goat/serverSettings/ServerSettingsService") {
  static readonly layerTest = (overrides: DeepPartial<ServerSettings> = {}) => layerTest(overrides);
}

// Publication holds only its host gate. A settings writer never waits for that gate
// while holding the global write semaphore, so staged payload I/O cannot stall settings.
const makeCheckpointReplicationAdmission = () => {
  const gates = new Map<string, { gate: Semaphore.Semaphore; revision: number }>();
  const forHost = (host: string) => {
    let entry = gates.get(host);
    if (entry === undefined) {
      entry = { gate: Semaphore.makeUnsafe(1), revision: 0 };
      gates.set(host, entry);
    }
    return entry;
  };
  const permit = Effect.fn("ServerSettings.checkpointReplicationPermit")(function* (
    host: string,
    read: Effect.Effect<ServerSettings, ServerSettingsError>,
  ) {
    const entry = forHost(host);
    return yield* entry.gate.withPermits(1)(
      Effect.gen(function* () {
        const settings = yield* read;
        const revision = entry.revision;
        return {
          choice: settings.fleet.hosts?.[host]?.checkpointReplication,
          publish: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            entry.gate.withPermits(1)(
              Effect.suspend(() =>
                entry.revision === revision
                  ? effect.pipe(Effect.map(Option.some))
                  : Effect.succeed(Option.none<A>()),
              ),
            ),
        };
      }),
    );
  });
  const tryCommit = <A, E, R>(
    current: ServerSettings,
    next: ServerSettings,
    commit: Effect.Effect<A, E, R>,
  ) => {
    const changed = [
      ...new Set([
        ...Object.keys(current.fleet.hosts ?? {}),
        ...Object.keys(next.fleet.hosts ?? {}),
      ]),
    ]
      .filter(
        (host) =>
          current.fleet.hosts?.[host]?.checkpointReplication !==
          next.fleet.hosts?.[host]?.checkpointReplication,
      )
      .sort()
      .map(forHost);
    let guarded = commit.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          for (const entry of changed) entry.revision++;
        }),
      ),
      Effect.map(Option.some),
      Effect.uninterruptible,
    );
    for (const entry of changed.toReversed())
      guarded = entry.gate.withPermitsIfAvailable(1)(guarded).pipe(Effect.map(Option.flatten));
    return guarded.pipe(
      Effect.map((result) =>
        Option.isSome(result)
          ? { done: true as const, value: result.value }
          : {
              done: false as const,
              wait: Effect.forEach(changed, ({ gate }) => gate.withPermits(1)(Effect.void), {
                discard: true,
              }),
            },
      ),
    );
  };
  const retry = Effect.fn("ServerSettings.retryCheckpointPublication")(function* <A, E, R>(
    attempt: Effect.Effect<
      { done: true; value: A } | { done: false; wait: Effect.Effect<void> },
      E,
      R
    >,
  ) {
    for (let attemptNumber = 0; attemptNumber < 16; attemptNumber++) {
      const result = yield* attempt;
      if (result.done) return result.value;
      yield* result.wait;
    }
    return yield* new ServerSettingsError({
      settingsPath: "checkpointReplication",
      operation: "normalize",
      cause: "Checkpoint publication remained busy; retry this settings change.",
    });
  });
  return { permit, tryCommit, retry };
};

const makeTest = Effect.fn("serverSettings.makeTest")(function* (
  overrides: DeepPartial<ServerSettings> = {},
) {
  const { automaticGitFetchInterval, providerHealthRefreshInterval, ...overridesForMerge } =
    overrides;
  const merged = deepMerge(DEFAULT_SERVER_SETTINGS, overridesForMerge);
  const initialSettings = yield* normalizeServerSettings({
    ...merged,
    ...(automaticGitFetchInterval !== undefined
      ? { automaticGitFetchInterval: automaticGitFetchInterval as Duration.Duration }
      : {}),
    ...(providerHealthRefreshInterval !== undefined
      ? { providerHealthRefreshInterval: providerHealthRefreshInterval as Duration.Duration }
      : {}),
  });
  const currentSettingsRef = yield* Ref.make<ServerSettings>(initialSettings);
  const providerPolicy = yield* makeMemoryProviderPolicy;
  const ownerPublication = yield* makeOwnerPolicyPublication;
  yield* ownerPublication.initialize(initialSettings);
  const ownerIdentity = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironmentIdentity);
  yield* providerPolicy.publish(initialSettings.enableAgentMemoryAccess);
  const writeSemaphore = yield* Semaphore.make(1);
  const checkpointAdmission = makeCheckpointReplicationAdmission();
  const hubMarkerRef = yield* Ref.make<HubTransitionMarker | null>(null);
  const getSettings = Ref.get(currentSettingsRef).pipe(Effect.map(resolveTextGenerationProvider));

  const updateTestSettingsLocked = <E, R>(
    update: (current: ServerSettings) => Effect.Effect<ServerSettings, E | ServerSettingsError, R>,
  ): Effect.Effect<ServerSettings, E | ServerSettingsError, R> =>
    Ref.get(currentSettingsRef).pipe(
      Effect.flatMap(update),
      Effect.flatMap(normalizeServerSettings),
      Effect.tap((nextSettings) =>
        Effect.uninterruptible(
          Ref.set(currentSettingsRef, nextSettings).pipe(
            Effect.andThen(providerPolicy.publish(nextSettings.enableAgentMemoryAccess)),
            Effect.andThen(ownerPublication.publish(ownerProjection(nextSettings))),
          ),
        ),
      ),
      Effect.map(resolveTextGenerationProvider),
    );
  const updateTestSettings = <E, R>(
    update: (current: ServerSettings) => Effect.Effect<ServerSettings, E | ServerSettingsError, R>,
  ) =>
    checkpointAdmission.retry(
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(currentSettingsRef);
          const next = yield* update(current);
          return yield* checkpointAdmission.tryCommit(
            current,
            next,
            updateTestSettingsLocked(() => Effect.succeed(next)),
          );
        }),
      ),
    );
  const applyHubLocked: MemoryHubSettingsTransitions["Service"]["applyMemoryHubTransition"] = (
    input,
    permit,
  ) =>
    updateTestSettingsLocked((current) =>
      Ref.get(hubMarkerRef).pipe(
        Effect.flatMap((marker) => transitionMemoryHubSettings(current, input, permit, marker)),
      ),
    ).pipe(
      Effect.tap((next) =>
        Ref.get(hubMarkerRef).pipe(
          Effect.flatMap((previous) =>
            Ref.set(hubMarkerRef, {
              requestId: input.requestId,
              version: next.memoryHubVersion,
              provenance: next.memoryHubProvenance ?? null,
              ...(next.memoryHub.mode === "hub" && next.memoryHub.memorySpaceId !== null
                ? { previousHubSpace: next.memoryHub.memorySpaceId }
                : previous?.previousHubSpace
                  ? { previousHubSpace: previous.previousHubSpace }
                  : {}),
            }),
          ),
        ),
      ),
      Effect.map((next) => ({
        settings: next.memoryHub,
        version: next.memoryHubVersion,
        provenance: next.memoryHubProvenance ?? null,
      })),
    );

  const ownerServices = ownerPolicyServices(
    ownerPublication,
    ownerIdentity,
    (effect) => writeSemaphore.withPermits(1)(effect),
    getSettings,
    updateTestSettingsLocked,
  );

  return {
    committedOwnerPolicy: ownerServices.committed,
    ownerPolicyAdministration: ownerServices.administration,
    start: Effect.void,
    ready: Effect.void,
    getSettings,
    updateSettings: (patch, authorizeAtCommit) =>
      updateTestSettings((currentSettings) =>
        (authorizeAtCommit ?? Effect.void).pipe(
          Effect.andThen(rejectMemoryHubSettingsPatch(patch, "test settings")),
          Effect.flatMap(() =>
            stampGoatclaw(currentSettings, applyServerSettingsPatch(currentSettings, patch)),
          ),
        ),
      ),
    updateSettingsWith: (patchFor, authorizeAtCommit) =>
      updateTestSettings((currentSettings) =>
        Effect.gen(function* () {
          if (authorizeAtCommit) yield* authorizeAtCommit;
          const patch = yield* patchFor(currentSettings);
          yield* rejectMemoryHubSettingsPatch(patch, "test settings");
          return yield* stampGoatclaw(
            currentSettings,
            applyServerSettingsPatch(currentSettings, patch),
          );
        }),
      ),
    updateProviderInstance: (mutation, patch = {}) =>
      updateTestSettings((currentSettings) =>
        Effect.gen(function* () {
          yield* rejectMemoryHubSettingsPatch(patch, "test settings");
          yield* ensureProviderInstanceMutationAllowed(currentSettings, mutation, "test settings");
          const patched = applyServerSettingsPatch(currentSettings, patch);
          return applyProviderInstanceMutation(patched, mutation);
        }),
      ),
    applyMemoryHubTransition: (input, permit) =>
      writeSemaphore.withPermits(1)(applyHubLocked(input, permit)),
    adminSettings: hubAdministrationSettings(
      getSettings,
      (effect) => writeSemaphore.withPermits(1)(effect),
      Ref.get(hubMarkerRef),
      applyHubLocked,
      Effect.succeed({ state: "current" as const }),
    ),
    checkpointReplicationPermit: (host) => checkpointAdmission.permit(host, getSettings),
    withSettingsSnapshot: (use) =>
      writeSemaphore.withPermits(1)(getSettings.pipe(Effect.flatMap(use))),
    committedProviderPolicy: providerPolicy.service,
    committedHubSettings: {
      readPublication: Effect.succeed({ state: "current" as const }),
      read: Ref.get(currentSettingsRef).pipe(
        Effect.map((current) => ({
          settings: current.memoryHub,
          version: current.memoryHubVersion,
          provenance: current.memoryHubProvenance ?? null,
        })),
      ),
    },
    streamChanges: Stream.empty,
    subscribeChanges: Effect.succeed(Stream.empty),
  } satisfies ServerSettingsService["Service"] &
    MemoryHubSettingsTransitions["Service"] & {
      adminSettings: MemoryHubAdminSettings["Service"];
      committedHubSettings: MemoryHubCommittedSettings["Service"];
      committedProviderPolicy: MemoryProviderCommittedPolicy["Service"];
      committedOwnerPolicy: MemoryOwnerSourceReadCommittedPolicy["Service"];
      ownerPolicyAdministration: MemoryOwnerSourceReadPolicyAdministration["Service"];
    };
});

// Keep fixtures accepting a settings-only replacement compatible. Memory
// composition opts into the complete context already built by settingsLayers.

export function layerTest(
  overrides: DeepPartial<ServerSettings>,
  services: "memoryHub",
): Layer.Layer<
  | ServerSettingsService
  | MemoryHubCommittedSettings
  | MemoryOwnerSourceReadCommittedPolicy
  | MemoryOwnerSourceReadPolicyAdministration
  | MemoryHubAdminSettings
  | MemoryHubSettingsTransitions,
  ServerSettingsError
>;
export function layerTest(
  overrides?: DeepPartial<ServerSettings>,
): Layer.Layer<ServerSettingsService, ServerSettingsError>;
export function layerTest(overrides: DeepPartial<ServerSettings> = {}, _services?: "memoryHub") {
  return Layer.unwrap(makeTest(overrides).pipe(Effect.map(settingsLayers)));
}

// Migrate saved token delivery without accepting it in settings writes or
// letting one retired value reset the rest of the environment's settings.
const PersistedResponseStreamingMode = Schema.Union([
  ResponseStreamingMode,
  Schema.Literal("token"),
]).pipe(
  Schema.decodeTo(
    ResponseStreamingMode,
    SchemaTransformation.transform({
      decode: (mode) => (mode === "token" ? "paragraph" : mode),
      encode: (mode) => mode,
    }),
  ),
);
const ServerSettingsJson = fromLenientJson(
  Schema.Struct({
    ...ServerSettings.fields,
    _memoryHubTransition: Schema.optionalKey(MemoryHubTransitionMarker),
    responseStreamingMode: PersistedResponseStreamingMode.pipe(
      Schema.withDecodingDefault(Effect.succeed("paragraph" as const)),
    ),
    projectSettingsOverrides: Schema.Record(
      ProjectId,
      Schema.Struct({
        ...ProjectSettingsOverrides.fields,
        responseStreamingMode: Schema.optionalKey(PersistedResponseStreamingMode),
      }),
    ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  }),
);
const decodeServerSettingsJsonExit = Schema.decodeUnknownExit(ServerSettingsJson);
// Inspect field presence separately from decoding defaults for external replacements.
const decodeCommittedHubJson = Schema.decodeUnknownExit(
  fromLenientJson(
    Schema.Struct({
      memoryHub: ServerSettings.fields.memoryHub,
      memoryHubVersion: Schema.optionalKey(Schema.Number),
      memoryHubProvenance: ServerSettings.fields.memoryHubProvenance,
    }),
  ),
);
const LegacyProviderSettingsJson = fromLenientJson(
  Schema.Struct({
    providers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    bitbucket: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    github: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }),
);
const decodeLegacyProviderSettingsJsonExit = Schema.decodeUnknownExit(LegacyProviderSettingsJson);

const LEGACY_BITBUCKET_SECRET_NAMES: Readonly<Record<string, string>> = {
  accessToken: "bitbucket-access-token",
  apiToken: "bitbucket-api-token",
};
const legacyGitHubTokenSecretName = (host: string) =>
  `github-token-${Buffer.from(host.trim().toLowerCase(), "utf8").toString("base64url")}`;

function migrateLegacySourceControlSettings(
  settings: ServerSettings,
  legacy: {
    readonly bitbucket?: Readonly<Record<string, unknown>> | undefined;
    readonly github?: Readonly<Record<string, unknown>> | undefined;
  },
): {
  readonly settings: ServerSettings;
  readonly secretMoves: ReadonlyArray<{ readonly from: string; readonly to: string }>;
} {
  const sourceControlHosts = { ...settings.sourceControlHosts };
  const secretMoves: Array<{ readonly from: string; readonly to: string }> = [];
  if (legacy.bitbucket !== undefined && sourceControlHosts.bitbucket === undefined) {
    sourceControlHosts.bitbucket = legacy.bitbucket;
    for (const [field, from] of Object.entries(LEGACY_BITBUCKET_SECRET_NAMES)) {
      if (legacy.bitbucket[field] !== SECRET_REDACTED) continue;
      secretMoves.push({
        from,
        to: sourceControlHostSecretName({ kind: "bitbucket", field, serverHost: null }),
      });
    }
  }
  if (legacy.github !== undefined && sourceControlHosts.github === undefined) {
    sourceControlHosts.github = legacy.github;
    for (const [serverHost, value] of readSecretFieldValues(legacy.github.tokens)) {
      if (serverHost === null || value !== SECRET_REDACTED) continue;
      secretMoves.push({
        from: legacyGitHubTokenSecretName(serverHost),
        to: sourceControlHostSecretName({ kind: "github", field: "tokens", serverHost }),
      });
    }
  }
  return { settings: { ...settings, sourceControlHosts }, secretMoves };
}

const HISTORY_RESTORED_DRIVERS: ReadonlySet<ProviderDriverKind> = new Set(
  ["cursor", "grok", "opencode"].map((driver) => ProviderDriverKind.make(driver)),
);

function migrateLegacyProviderSettings(
  settings: ServerSettings,
  legacyProviders: Readonly<Record<string, unknown>>,
  providerHistory: ReadonlyArray<{
    readonly providerName: string;
    readonly providerInstanceId: string | null;
  }>,
): ServerSettings {
  const usedProviders = new Set<string>(providerHistory.map(({ providerName }) => providerName));
  const usedProviderInstances = new Set<string>(
    providerHistory.map(
      ({ providerName, providerInstanceId }) => providerInstanceId ?? providerName,
    ),
  );

  const providerInstances: Record<ProviderInstanceId, ProviderInstanceConfig> = {};
  for (const [instanceId, instance] of Object.entries(settings.providerInstances) as Array<
    [ProviderInstanceId, ProviderInstanceConfig]
  >) {
    providerInstances[instanceId] =
      instance.enabled === undefined &&
      HISTORY_RESTORED_DRIVERS.has(instance.driver) &&
      usedProviderInstances.has(instanceId)
        ? { ...instance, enabled: true }
        : instance;
  }

  const legacyEntries = new Map(Object.entries(legacyProviders));
  for (const driver of HISTORY_RESTORED_DRIVERS) {
    if (!legacyEntries.has(driver)) legacyEntries.set(driver, {});
  }
  for (const [kind, blob] of legacyEntries) {
    if (!isProviderDriverKind(kind) || blob === null || typeof blob !== "object") continue;
    if (Array.isArray(blob)) continue;
    const driver = kind;
    const instanceId = defaultInstanceIdForDriver(driver);
    if (Object.hasOwn(providerInstances, instanceId)) continue;

    const { enabled: rawEnabled, ...config } = blob as Record<string, unknown>;
    const explicitEnabled = typeof rawEnabled === "boolean" ? rawEnabled : undefined;
    const enabled =
      explicitEnabled ??
      (HISTORY_RESTORED_DRIVERS.has(driver) && usedProviders.has(driver) ? true : undefined);
    const driverDefault = resolveProviderInstanceEnabled({ driver, config: {} });
    if (Object.keys(config).length === 0 && (enabled === undefined || enabled === driverDefault)) {
      continue;
    }
    providerInstances[instanceId] = {
      driver,
      ...(enabled === undefined ? {} : { enabled }),
      config,
    } satisfies ProviderInstanceConfig;
  }

  return {
    ...settings,
    providerInstances,
  };
}

const ACP_REGISTRY_DRIVER = ProviderDriverKind.make("acpRegistry");

function selectionSupportsTextGeneration(
  settings: ServerSettings,
  selection: ModelSelection,
): boolean {
  return settings.providerInstances[selection.instanceId]?.driver !== ACP_REGISTRY_DRIVER;
}

function resolveTextGenerationProvider(settings: ServerSettings): ServerSettings {
  return isModelSelectionProviderEnabled(settings, settings.textGenerationModelSelection) &&
    selectionSupportsTextGeneration(settings, settings.textGenerationModelSelection)
    ? settings
    : fallbackTextGenerationProvider(settings);
}

function fallbackTextGenerationProvider(settings: ServerSettings): ServerSettings {
  const fallback = fallbackTextGenerationModelSelection(
    settings.providerInstances,
    (instanceId, driver) =>
      resolveProviderInstanceEnabled(
        settings.providerInstances[instanceId] ?? { driver, config: {} },
      ),
    { defaultModelSelection: settings.defaultModelSelection },
  );
  return fallback === null ? settings : { ...settings, textGenerationModelSelection: fallback };
}

const ATOMIC_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  "memoryOwnerSourceReadPolicy",
  "backgroundActivity",
  "automaticGitFetchInterval",
  "providerHealthRefreshInterval",
  "sourceControlWriterModelSelection",
  "reviewGuideModelSelection",
  "memoryModelSelection",
  "goatBotModelSelection",
  "textGenerationModelSelection",
  "pullRequestMergeMethod",
  // goatclaw's permission profiles: a partial record would lose the profile defaultProfile names.
  "profiles",
]);

/**
 * goatclaw applies fleet-wide and the newest change wins on every host (goatclaw/FleetSync), so a
 * change made here carries its time. A synced policy brings its own stamp and keeps it.
 */
const stampGoatclaw = (current: ServerSettings, next: ServerSettings) =>
  next.goatclaw.updatedAt !== current.goatclaw.updatedAt ||
  goatclawPolicyContent(next.goatclaw) === goatclawPolicyContent(current.goatclaw)
    ? Effect.succeed(next)
    : DateTime.now.pipe(
        Effect.map((now): ServerSettings => ({
          ...next,
          goatclaw: { ...next.goatclaw, updatedAt: DateTime.formatIso(now) },
        })),
      );

function stripDefaultServerSettings(current: unknown, defaults: unknown): unknown | undefined {
  if (Array.isArray(current) || Array.isArray(defaults)) {
    return Equal.equals(current, defaults) ? undefined : current;
  }

  if (
    current !== null &&
    defaults !== null &&
    typeof current === "object" &&
    typeof defaults === "object"
  ) {
    const currentRecord = current as Record<string, unknown>;
    const defaultsRecord = defaults as Record<string, unknown>;
    const next: Record<string, unknown> = {};

    for (const key of Object.keys(currentRecord)) {
      if (ATOMIC_SETTINGS_KEYS.has(key)) {
        if (!Equal.equals(currentRecord[key], defaultsRecord[key])) {
          next[key] = currentRecord[key];
        }
      } else {
        const stripped = stripDefaultServerSettings(currentRecord[key], defaultsRecord[key]);
        if (stripped !== undefined) {
          next[key] = stripped;
        }
      }
    }

    return Object.keys(next).length > 0 ? next : undefined;
  }

  return Object.is(current, defaults) ? undefined : current;
}

const decodeProjectScriptsJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(ProjectScript)),
);
const decodeModelSelectionJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.NullOr(ModelSelection)),
);

interface LegacyProjectSettingsRow {
  readonly projectId: string;
  readonly defaultModelSelection: string | null;
  readonly defaultThreadEnvMode: string | null;
  readonly autoPull: number;
  readonly scripts: string;
}

/**
 * Marked with `projectSettingsFolded` so a later reset in the UI survives restarts.
 */
function foldLegacyProjectSettings(
  settings: ServerSettings,
  rows: ReadonlyArray<LegacyProjectSettingsRow>,
): ServerSettings {
  if (settings.projectSettingsFolded) return settings;
  if (
    rows.length === 0 &&
    Object.keys(settings.projectAgentBrowserAccessOverrides).length === 0 &&
    Object.keys(settings.projectAutoPullOverrides).length === 0 &&
    Object.keys(settings.projectScriptOverrides).length === 0
  ) {
    return settings;
  }
  const entries: Record<string, ProjectSettingsOverrides> = {
    ...settings.projectSettingsOverrides,
  };
  const set = <K extends keyof ProjectSettingsOverrides>(
    projectId: string,
    key: K,
    value: ProjectSettingsOverrides[K] | undefined,
  ) => {
    if (value === undefined) return;
    const entry = entries[projectId] ?? {};
    if (Object.hasOwn(entry, key)) return;
    entries[projectId] = { ...entry, [key]: value };
  };
  for (const [projectId, value] of Object.entries(settings.projectAgentBrowserAccessOverrides)) {
    set(projectId, "enableAgentBrowserAccess", value);
  }
  for (const [projectId, value] of Object.entries(settings.projectAutoPullOverrides)) {
    set(projectId, "defaultAutoPull", value);
  }
  // A stored null meant "reset to machine defaults", which is now plain
  // inheritance; the project's own aggregate scripts must not resurface.
  const resetScripts = new Set<string>();
  for (const [projectId, value] of Object.entries(settings.projectScriptOverrides)) {
    if (value === null) resetScripts.add(projectId);
    else set(projectId, "defaultProjectScripts", value);
  }
  for (const row of rows) {
    const model = decodeModelSelectionJson(row.defaultModelSelection ?? "null");
    if (Option.isSome(model) && model.value !== null) {
      set(row.projectId, "defaultModelSelection", model.value);
    }
    if (row.defaultThreadEnvMode === "local" || row.defaultThreadEnvMode === "worktree") {
      set(row.projectId, "defaultThreadEnvMode", row.defaultThreadEnvMode);
    }
    if (row.autoPull === 1) set(row.projectId, "defaultAutoPull", true);
    const scripts = decodeProjectScriptsJson(row.scripts);
    if (Option.isSome(scripts) && scripts.value.length > 0 && !resetScripts.has(row.projectId)) {
      set(row.projectId, "defaultProjectScripts", scripts.value);
    }
  }
  const projectSettingsOverrides = Object.fromEntries(
    Object.entries(entries).filter(([, entry]) => Object.keys(entry).length > 0),
  );
  return {
    ...settings,
    projectSettingsOverrides,
    projectSettingsFolded: true,
    ...deriveLegacyProjectOverrides({ projectSettingsOverrides }),
  };
}

const make = Effect.gen(function* () {
  const { settingsPath } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const sql = yield* SqlClient.SqlClient;
  const writeSemaphore = yield* Semaphore.make(1);
  const checkpointAdmission = makeCheckpointReplicationAdmission();
  const routeState = yield* Effect.serviceOption(CodexRoute.CodexRouteState);
  const hubMarkerRef = yield* Ref.make<HubTransitionMarker | null>(null);
  const providerPolicy = yield* makeMemoryProviderPolicy;
  const ownerPublication = yield* makeOwnerPolicyPublication;
  const ownerIdentity = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironmentIdentity);
  const committedHubRef = yield* Ref.make<
    MemoryHubSettingsSnapshot & { publication: import("@goat/contracts").MemoryHubPublication }
  >({
    settings: DEFAULT_SERVER_SETTINGS.memoryHub,
    version: DEFAULT_SERVER_SETTINGS.memoryHubVersion,
    provenance: null,
    publication: { state: "unavailable" },
  });
  const publishCommittedHub = (
    settings: Pick<ServerSettings, "memoryHub" | "memoryHubVersion" | "memoryHubProvenance">,
  ) =>
    Ref.set(committedHubRef, {
      settings: settings.memoryHub,
      version: settings.memoryHubVersion,
      provenance: settings.memoryHubProvenance ?? null,
      publication: { state: "current" as const },
    });
  const retainCommittedHub = (code: "invalid_settings" | "settings_unavailable") =>
    Ref.update(committedHubRef, (current) => ({
      ...current,
      publication: {
        state:
          current.publication.state === "unavailable"
            ? ("unavailable" as const)
            : ("last_valid" as const),
        code,
      },
    }));
  const cacheKey = "settings" as const;
  const changesPubSub = yield* PubSub.unbounded<ServerSettings>();
  const providerChangesPubSub = yield* PubSub.unbounded<{
    readonly settings: ServerSettings;
    readonly revision: CodexRoute.SettingsRevision;
  }>();
  const startedRef = yield* Ref.make(false);
  const startedDeferred = yield* Deferred.make<void, ServerSettingsError>();
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

  const emitChange = (settings: ServerSettings) =>
    Effect.gen(function* () {
      yield* PubSub.publish(changesPubSub, settings);
      if (Option.isSome(routeState))
        yield* PubSub.publish(providerChangesPubSub, {
          settings,
          revision: routeState.value.revision(),
        });
    });

  const readConfigExists = fs.exists(settingsPath).pipe(
    Effect.tapError(() => retainCommittedHub("settings_unavailable")),
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          operation: "check-exists",
          cause,
        }),
    ),
  );

  const readRawConfig = fs.readFileString(settingsPath).pipe(
    Effect.tapError(() => retainCommittedHub("settings_unavailable")),
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          operation: "read-file",
          cause,
        }),
    ),
  );

  const hasCommittedHubEpoch = (view: MemoryHubSettingsSnapshot) =>
    view.version !== 0 || view.settings.mode !== "disabled";

  const publishExternalHub = (raw: string) =>
    Effect.gen(function* () {
      const decoded = decodeServerSettingsJsonExit(raw);
      const projection = decodeCommittedHubJson(raw);
      const legacy = decodeLegacyProviderSettingsJsonExit(raw);
      const current = yield* Ref.get(committedHubRef);
      if (
        Exit.isFailure(decoded) ||
        Exit.isFailure(projection) ||
        Exit.isFailure(legacy) ||
        (projection.value.memoryHubVersion === undefined && hasCommittedHubEpoch(current))
      ) {
        yield* retainCommittedHub("invalid_settings");
        yield* Effect.logWarning(
          "invalid external settings projection, retaining committed memory hub",
          {
            path: settingsPath,
            reason:
              Exit.isFailure(decoded) || Exit.isFailure(projection) || Exit.isFailure(legacy)
                ? "decode"
                : "missing-version",
          },
        );
        return false;
      }
      yield* ownerPublication.initialize(decoded.value);
      const {
        memoryHubProvenance: provenance,
        memoryHub: hub,
        _memoryHubTransition: marker,
      } = decoded.value;
      const trustedProvenance =
        provenance !== null &&
        hub.mode === "hub" &&
        hub.memorySpaceId === provenance.memorySpaceId &&
        marker?.version === decoded.value.memoryHubVersion &&
        marker.provenance?.memorySpaceId === provenance.memorySpaceId
          ? provenance
          : null;
      yield* publishCommittedHub({ ...decoded.value, memoryHubProvenance: trustedProvenance });
      yield* providerPolicy.publish(decoded.value.enableAgentMemoryAccess);
      return true;
    });

  const refreshCommittedHub = Effect.gen(function* () {
    if (yield* readConfigExists) {
      return yield* publishExternalHub(yield* readRawConfig);
    }
    const current = yield* Ref.get(committedHubRef);
    // A fresh environment can legitimately have no settings file. Watching that
    // absence must not invalidate its trusted defaults before hub initialization.
    // The SQL administration guard still protects opt-outs after a lost file.
    if (!hasCommittedHubEpoch(current) && current.publication.state === "current") return true;
    yield* retainCommittedHub("settings_unavailable");
    // Deletion, editor replacement and a dangling symlink are indistinguishable.
    // Keep the epoch; resetting an established hub requires an explicit valid version.
    if (hasCommittedHubEpoch(yield* Ref.get(committedHubRef))) {
      yield* Effect.logWarning("settings file unavailable, retaining committed memory hub", {
        path: settingsPath,
      });
    }
    return false;
  });

  const writeSettingsAtomically = Effect.fnUntraced(
    function* (settings: ServerSettings, transition?: HubTransitionMarker) {
      const marker = transition ?? (yield* Ref.get(hubMarkerRef));
      const sparse = (stripDefaultServerSettings(settings, DEFAULT_SERVER_SETTINGS) ??
        {}) as Record<string, unknown>;
      const sparseSettingsJson = yield* encodeServerSettingsJson({
        ...sparse,
        ...(marker === null ? {} : { _memoryHubTransition: marker }),
      });

      return yield* writeFileStringAtomically({
        filePath: settingsPath,
        contents: `${sparseSettingsJson}\n`,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          // Publish immediately after the rename, before atomicWrite's asynchronous
          // temp cleanup. No cancellation may split durable commit from its Ref epoch.
          rename: (from, to) =>
            fs.rename(from, to).pipe(
              Effect.tap(() =>
                publishCommittedHub(settings).pipe(
                  Effect.andThen(providerPolicy.publish(settings.enableAgentMemoryAccess)),
                  Effect.andThen(ownerPublication.publish(ownerProjection(settings))),
                ),
              ),
              Effect.uninterruptible,
            ),
        }),
        Effect.provideService(Path.Path, pathService),
      );
    },
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          operation: "write-file",
          cause,
        }),
    ),
  );

  const moveInlineSettingsSecrets = Effect.fn("serverSettings.moveInlineSettingsSecrets")(
    function* (settings: ServerSettings) {
      const pending: SettingsSecret[] = [];
      mapSettingsSecrets(settings, (secret) => {
        if (secret.kind === "field" && !secret.redacted && secret.value.length > 0) {
          pending.push(secret);
        }
        return secret;
      });
      const moved = new Set<string>();
      for (const secret of pending) {
        const stored = yield* secretStore
          .set(secret.secretName, textEncoder.encode(secret.value))
          .pipe(
            Effect.as(true),
            Effect.catch(() =>
              Effect.logWarning("failed to move a settings secret into the secret store").pipe(
                Effect.as(false),
              ),
            ),
          );
        if (stored) moved.add(secret.secretName);
      }
      if (moved.size === 0) return settings;
      return mapSettingsSecrets(settings, (secret) =>
        moved.has(secret.secretName) ? { value: "", redacted: true } : secret,
      );
    },
  );

  const loadSettingsFromDisk = Effect.gen(function* () {
    let settings: ServerSettings = DEFAULT_SERVER_SETTINGS;
    let legacyProviders: Readonly<Record<string, unknown>> | undefined;
    let legacySourceControl: Parameters<typeof migrateLegacySourceControlSettings>[1] = {};
    let parseFailure = Option.none<unknown>();
    let settingsFileTrusted = true;

    const settingsExists = yield* readConfigExists;
    if (settingsExists) {
      const raw = yield* readRawConfig;
      settingsFileTrusted = yield* publishExternalHub(raw);
      const decoded = decodeServerSettingsJsonExit(raw);
      const legacySettings = decodeLegacyProviderSettingsJsonExit(raw);
      if (legacySettings._tag === "Success") {
        legacyProviders = legacySettings.value.providers;
        legacySourceControl = {
          bitbucket: legacySettings.value.bitbucket,
          github: legacySettings.value.github,
        };
      }
      if (decoded._tag === "Failure" || legacySettings._tag === "Failure") {
        settingsFileTrusted = false;
        const failure = decoded._tag === "Failure" ? decoded : legacySettings;
        // The file may hold an opt-out we can no longer read; never resume threads on a guess.
        settings = { ...DEFAULT_SERVER_SETTINGS, continueThreadsAfterServerUpdate: false };
        if (failure._tag === "Failure") {
          parseFailure = Option.some(Cause.squash(failure.cause));
          yield* Effect.logWarning("failed to parse settings.json, using defaults", {
            path: settingsPath,
            issues: Cause.pretty(failure.cause),
            cause: failure.cause,
          });
        }
      } else {
        const { _memoryHubTransition: marker, ...publicSettings } = decoded.value;
        yield* Ref.set(hubMarkerRef, marker ?? null);
        settings = {
          ...publicSettings,
          defaultTheme: normalizeThemePreference(decoded.value.defaultTheme),
        };
      }
    }

    if (!settingsExists) {
      const current = yield* Ref.get(committedHubRef);
      if (
        !hasCommittedHubEpoch(current) &&
        (current.publication.state === "current" ||
          (current.publication.state === "unavailable" && current.publication.code === undefined))
      )
        yield* publishCommittedHub(DEFAULT_SERVER_SETTINGS);
      else yield* retainCommittedHub("settings_unavailable");
      if (!(yield* providerPolicy.service.read).policyReady)
        yield* providerPolicy.publish(DEFAULT_SERVER_SETTINGS.enableAgentMemoryAccess);
      else settingsFileTrusted = false;
    }
    yield* ownerPublication.initialize(settings);
    const committedOwner = yield* ownerPublication.read;
    const committedProviderPolicy = yield* providerPolicy.service.read;

    const committedHub = yield* Ref.get(committedHubRef);
    if (!settingsExists && hasCommittedHubEpoch(committedHub)) {
      settingsFileTrusted = false;
      yield* Effect.logWarning("settings file unavailable, retaining committed memory hub", {
        path: settingsPath,
      });
    }
    // Full settings and migrations must not turn a rejected projection into a new commit.
    settings = {
      ...settings,
      enableAgentMemoryAccess: committedProviderPolicy.enableAgentMemoryAccess,
      memoryHub: committedHub.settings,
      memoryHubVersion: committedHub.version,
      memoryHubProvenance: committedHub.provenance,
      memoryOwnerSourceReadPolicy: committedOwner.policy,
      memoryOwnerSourceReadPolicyVersion: committedOwner.version,
    };

    const providerHistory = yield* sql<{
      readonly providerName: string;
      readonly providerInstanceId: string | null;
    }>`
      SELECT DISTINCT
        provider_name AS "providerName",
        provider_instance_id AS "providerInstanceId"
      FROM projection_thread_sessions
      WHERE provider_name IN ('cursor', 'grok', 'opencode')
      UNION
      SELECT DISTINCT
        provider_name AS "providerName",
        provider_instance_id AS "providerInstanceId"
      FROM provider_session_runtime
      WHERE provider_name IN ('cursor', 'grok', 'opencode')
    `.pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            operation: "read-provider-history",
            cause,
          }),
      ),
    );

    const legacyProjectRows =
      settings.projectSettingsFolded || !settingsFileTrusted
        ? []
        : yield* sql<LegacyProjectSettingsRow>`
          SELECT
            project_id AS "projectId",
            default_model_selection_json AS "defaultModelSelection",
            default_thread_env_mode AS "defaultThreadEnvMode",
            auto_pull AS "autoPull",
            scripts_json AS "scripts"
          FROM projection_projects
          WHERE deleted_at IS NULL
        `.pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  operation: "read-project-settings",
                  cause,
                }),
            ),
          );

    const loaded = foldProviderInstanceEnabledFlags(
      legacyProviders === undefined
        ? settings
        : migrateLegacyProviderSettings(settings, legacyProviders, providerHistory),
    );
    const folded = settingsFileTrusted
      ? foldLegacyProjectSettings(loaded, legacyProjectRows)
      : loaded;
    // Copied, not moved: the old entry is removed only after the new file is written. A token
    // that cannot be read or copied leaves the retired keys in place, so the migration runs again
    // on the next load instead of dropping it.
    const legacySecretsCopied = yield* Effect.forEach(
      settingsFileTrusted
        ? migrateLegacySourceControlSettings(folded, legacySourceControl).secretMoves
        : [],
      (move) =>
        secretStore.get(move.from).pipe(
          Effect.flatMap((secret) =>
            Option.isNone(secret) ? Effect.void : secretStore.set(move.to, secret.value),
          ),
          Effect.as(true),
          Effect.catch(() =>
            Effect.logWarning("failed to copy a source control secret to its new name", {
              secretName: move.to,
            }).pipe(Effect.as(false)),
          ),
        ),
    ).pipe(Effect.map((copied) => copied.every(Boolean)));
    const hasLegacySourceControl =
      settingsFileTrusted &&
      legacySecretsCopied &&
      (legacySourceControl.bitbucket !== undefined || legacySourceControl.github !== undefined);
    const sourceControlMigration = hasLegacySourceControl
      ? migrateLegacySourceControlSettings(folded, legacySourceControl)
      : { settings: folded, secretMoves: [] };
    const migrated = settingsFileTrusted
      ? yield* moveInlineSettingsSecrets(sourceControlMigration.settings)
      : folded;
    if (
      settingsFileTrusted &&
      (migrated !== loaded || legacyProviders !== undefined || hasLegacySourceControl)
    ) {
      yield* writeSettingsAtomically(migrated);
      for (const move of sourceControlMigration.secretMoves) {
        yield* secretStore.remove(move.from).pipe(Effect.ignore);
      }
    }
    return { settings: migrated, parseFailure };
  });

  const settingsCache = yield* Cache.makeWith((_key: typeof cacheKey) => loadSettingsFromDisk, {
    capacity: 1,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
  });

  const getSettingsFromCache = Cache.get(settingsCache, cacheKey).pipe(
    Effect.map((loaded) => loaded.settings),
  );
  const reloadSettings = Cache.invalidate(settingsCache, cacheKey).pipe(
    Effect.andThen(Cache.get(settingsCache, cacheKey)),
  );

  const materializeSettingsSecrets = Effect.fn("serverSettings.materializeSettingsSecrets")(
    function* (settings: ServerSettings): Effect.fn.Return<ServerSettings, ServerSettingsError> {
      const storedSecrets = new Map<string, string>();
      const pending = new Map<string, SettingsSecret>();
      mapSettingsSecrets(settings, (secret) => {
        if (secret.sensitive && secret.redacted) pending.set(secret.secretName, secret);
        return secret;
      });
      for (const secret of pending.values()) {
        const value = yield* secretStore.get(secret.secretName).pipe(
          Effect.mapError(
            (cause) =>
              new ServerSettingsError({
                settingsPath,
                operation: "read-secret",
                providerInstanceId: secret.providerInstanceId,
                environmentVariable: secret.environmentVariable,
                cause,
              }),
          ),
        );
        storedSecrets.set(
          secret.secretName,
          Option.isSome(value) ? textDecoder.decode(value.value) : "",
        );
      }
      return mapSettingsSecrets(settings, (secret) => ({
        value:
          secret.sensitive && secret.redacted
            ? (storedSecrets.get(secret.secretName) ?? "")
            : secret.value,
        redacted: secret.sensitive && secret.kind === "environment" && secret.redacted,
      }));
    },
  );

  const materializeChanges = (changes: Stream.Stream<ServerSettings>) =>
    changes.pipe(
      Stream.mapEffect((settings) =>
        materializeSettingsSecrets(settings).pipe(
          Effect.catch((error: ServerSettingsError) =>
            Effect.logWarning("failed to materialize settings secrets", {
              operation: error.operation,
              providerInstanceId: error.providerInstanceId,
              environmentVariable: error.environmentVariable,
              cause: error.cause,
            }).pipe(Effect.as(settings)),
          ),
        ),
      ),
      Stream.map(resolveTextGenerationProvider),
    );

  type SecretChange = {
    readonly secretName: string;
    readonly providerInstanceId?: string;
    readonly environmentVariable?: string;
  } & (
    | { readonly kind: "write"; readonly value: Uint8Array }
    | { readonly kind: "remove"; readonly operation: "remove-secret" | "remove-stale-secret" }
  );

  const persistSettingsSecrets = (current: ServerSettings, next: ServerSettings) =>
    Effect.sync(() => {
      const previous = new Map<string, SettingsSecret>();
      mapSettingsSecrets(current, (secret) => {
        previous.set(secret.secretName, secret);
        return secret;
      });
      const changes: SecretChange[] = [];
      const nextSecretNames = new Set<string>();
      const settings = mapSettingsSecrets(next, (secret) => {
        const metadata = {
          secretName: secret.secretName,
          ...(secret.providerInstanceId !== undefined
            ? { providerInstanceId: secret.providerInstanceId }
            : {}),
          ...(secret.environmentVariable !== undefined
            ? { environmentVariable: secret.environmentVariable }
            : {}),
        };
        if (!secret.sensitive) {
          changes.push({ ...metadata, kind: "remove", operation: "remove-secret" });
          return { value: secret.value, redacted: false };
        }
        const old = previous.get(secret.secretName);
        const inlineValue =
          old?.sensitive && !old.redacted && old.value.length > 0 ? old.value : undefined;
        const value = secret.redacted ? inlineValue : secret.value;
        if (value === undefined) {
          nextSecretNames.add(secret.secretName);
          return { value: "", redacted: true };
        }
        if (value.length === 0) {
          changes.push({ ...metadata, kind: "remove", operation: "remove-secret" });
          return { value: "", redacted: false };
        }
        nextSecretNames.add(secret.secretName);
        changes.push({ ...metadata, kind: "write", value: textEncoder.encode(value) });
        return { value: "", redacted: true };
      });
      for (const secret of previous.values()) {
        if (!secret.sensitive || nextSecretNames.has(secret.secretName)) continue;
        if (changes.some((change) => change.secretName === secret.secretName)) continue;
        changes.push({
          kind: "remove",
          secretName: secret.secretName,
          operation: "remove-stale-secret",
          ...(secret.providerInstanceId !== undefined
            ? { providerInstanceId: secret.providerInstanceId }
            : {}),
          ...(secret.environmentVariable !== undefined
            ? { environmentVariable: secret.environmentVariable }
            : {}),
        });
      }
      return { settings, changes };
    });

  const rollbackSettingsSecretWrites = (
    writes: ReadonlyArray<{
      readonly secretName: string;
      readonly previousValue: Option.Option<Uint8Array>;
      readonly providerInstanceId?: string;
      readonly environmentVariable?: string;
    }>,
  ) =>
    Effect.forEach(
      writes.toReversed(),
      (write) =>
        (Option.isSome(write.previousValue)
          ? secretStore.set(write.secretName, write.previousValue.value)
          : secretStore.remove(write.secretName)
        ).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("failed to roll back settings secret", {
              providerInstanceId: write.providerInstanceId,
              environmentVariable: write.environmentVariable,
              cause,
            }),
          ),
        ),
      { discard: true },
    );

  const applySettingsSecretChanges = (changes: ReadonlyArray<SecretChange>) => {
    const applied: Array<{
      readonly secretName: string;
      readonly previousValue: Option.Option<Uint8Array>;
      readonly providerInstanceId?: string;
      readonly environmentVariable?: string;
    }> = [];
    const rollback = Effect.suspend(() => rollbackSettingsSecretWrites(applied));
    return Effect.forEach(
      changes,
      (change) =>
        Effect.gen(function* () {
          const previousValue = yield* secretStore.get(change.secretName).pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  operation: "read-secret",
                  providerInstanceId: change.providerInstanceId,
                  environmentVariable: change.environmentVariable,
                  cause,
                }),
            ),
          );
          // A store operation may mutate before reporting an error (for example chmod after rename).
          applied.push({ ...change, previousValue });
          yield* (
            change.kind === "write"
              ? secretStore.set(change.secretName, change.value)
              : secretStore.remove(change.secretName)
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  operation: change.kind === "write" ? "write-secret" : change.operation,
                  providerInstanceId: change.providerInstanceId,
                  environmentVariable: change.environmentVariable,
                  cause,
                }),
            ),
          );
        }),
      { discard: true },
    ).pipe(
      Effect.tapError(() => rollback),
      Effect.as(rollback),
    );
  };

  const updateSettingsWhileLocked = <E, R>(
    update: (current: ServerSettings) => Effect.Effect<ServerSettings, E | ServerSettingsError, R>,
    transition?: HubTransitionMarker,
  ): Effect.Effect<ServerSettings, E | ServerSettingsError, R> =>
    Effect.gen(function* () {
      const { settings: current, parseFailure } = yield* reloadSettings;
      if (Option.isSome(parseFailure)) {
        return yield* new ServerSettingsError({
          settingsPath,
          operation: "read-file",
          cause: parseFailure.value,
        });
      }
      const updated = yield* update(current);
      if (Option.isSome(routeState)) yield* routeState.value.validate(current, updated);
      if (CodexRoute.instanceFingerprint(current) === CodexRoute.instanceFingerprint(updated))
        return yield* materializeSettingsSecrets(current).pipe(
          Effect.map(resolveTextGenerationProvider),
        );
      const persisted = yield* persistSettingsSecrets(current, updated);
      const next = yield* normalizeServerSettings(persisted.settings);
      const materialized = yield* Effect.uninterruptibleMask(() =>
        Effect.gen(function* () {
          const rollbackSecretChanges = yield* applySettingsSecretChanges(persisted.changes);
          const materializedExit = yield* Effect.exit(materializeSettingsSecrets(next));
          if (Exit.isFailure(materializedExit)) {
            yield* rollbackSecretChanges;
            return yield* Effect.failCause(materializedExit.cause);
          }
          const writeExit = yield* Effect.exit(writeSettingsAtomically(next, transition));
          if (Exit.isFailure(writeExit)) {
            yield* rollbackSecretChanges;
            return yield* Effect.failCause(writeExit.cause);
          }
          if (transition) yield* Ref.set(hubMarkerRef, transition);
          // Once the file commits, cancellation must not leave the CAS cache or subscribers behind.
          yield* Cache.set(settingsCache, cacheKey, {
            settings: next,
            parseFailure: Option.none(),
          });
          if (Option.isSome(routeState)) yield* routeState.value.committed(current, next);
          yield* emitChange(next);
          return materializedExit.value;
        }),
      );
      return resolveTextGenerationProvider(materialized);
    });

  const updateAndPersistSettings = <E, R>(
    update: (current: ServerSettings) => Effect.Effect<ServerSettings, E | ServerSettingsError, R>,
    targetIds: ReadonlyArray<ProviderInstanceId> = [],
  ) => {
    const attempt = writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const { settings: current, parseFailure } = yield* reloadSettings;
        if (Option.isSome(parseFailure))
          return yield* new ServerSettingsError({
            settingsPath,
            operation: "read-file",
            cause: parseFailure.value,
          });
        const next = yield* update(current);
        return yield* checkpointAdmission.tryCommit(
          current,
          next,
          Effect.gen(function* () {
            const settings = yield* updateSettingsWhileLocked(() => Effect.succeed(next));
            const changed = [
              ...new Set([
                ...Object.keys(current.providerInstances),
                ...Object.keys(settings.providerInstances),
              ]),
            ]
              .map((id) => id as ProviderInstanceId)
              .filter(
                (id) =>
                  CodexRoute.instanceFingerprint(current.providerInstances[id]) !==
                  CodexRoute.instanceFingerprint(settings.providerInstances[id]),
              );
            return {
              settings,
              applied: Option.isSome(routeState)
                ? routeState.value.awaitApplied([...new Set([...changed, ...targetIds])])
                : Effect.void,
            };
          }),
        );
      }),
    );
    return checkpointAdmission
      .retry(
        Option.isSome(routeState) ? routeState.value.admission.withPermits(1)(attempt) : attempt,
      )
      .pipe(Effect.flatMap(({ settings, applied }) => applied.pipe(Effect.as(settings))));
  };
  const applyHubLocked: MemoryHubSettingsTransitions["Service"]["applyMemoryHubTransition"] = (
    input,
    permit,
  ) =>
    Effect.gen(function* () {
      const current = yield* getSettingsFromCache;
      const marker = yield* Ref.get(hubMarkerRef);
      const previousHubSpace =
        input.settings.mode === "hub" && input.settings.memorySpaceId !== null
          ? input.settings.memorySpaceId
          : current.memoryHub.mode === "hub"
            ? current.memoryHub.memorySpaceId
            : marker?.previousHubSpace;
      const next = yield* updateSettingsWhileLocked(
        (current) => transitionMemoryHubSettings(current, input, permit, marker),
        {
          requestId: input.requestId,
          version: input.expectedVersion + 1,
          provenance: input.provenance ?? null,
          ...(previousHubSpace ? { previousHubSpace } : {}),
        },
      );
      return {
        settings: next.memoryHub,
        version: next.memoryHubVersion,
        provenance: next.memoryHubProvenance ?? null,
      };
    });

  const withSettingsSnapshot: ServerSettingsService["Service"]["withSettingsSnapshot"] = (use) =>
    writeSemaphore.withPermits(1)(
      getSettingsFromCache.pipe(
        Effect.flatMap(materializeSettingsSecrets),
        Effect.map(resolveTextGenerationProvider),
        Effect.flatMap(use),
      ),
    );

  const revalidateAndEmit = writeSemaphore.withPermits(1)(
    Effect.gen(function* () {
      yield* refreshCommittedHub;
      const { settings } = yield* reloadSettings;
      yield* emitChange(settings);
    }),
  );

  const watchFileChanges = (filePath: string) => {
    const directory = pathService.dirname(filePath);
    const fileName = pathService.basename(filePath);
    const resolvedFilePath = pathService.resolve(filePath);
    return fs
      .watch(directory)
      .pipe(
        Stream.filter(
          (event) =>
            event.path === fileName ||
            event.path === filePath ||
            pathService.resolve(directory, event.path) === resolvedFilePath,
        ),
      );
  };

  const startWatcher = Effect.gen(function* () {
    const settingsDir = pathService.dirname(settingsPath);

    yield* fs.makeDirectory(settingsDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            operation: "prepare-directory",
            cause,
          }),
      ),
    );

    const revalidateAndEmitSafely = revalidateAndEmit.pipe(Effect.ignoreCause({ log: true }));

    // A symlinked settings file is rewritten in its destination's directory,
    // which a watch on the link's directory never sees. The link is resolved
    // again whenever it changes, so repointing it moves the watch along.
    const watchLinkTarget = Effect.gen(function* () {
      const linkTargetPath = yield* resolveSymlinkTarget(settingsPath).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, pathService),
      );
      if (linkTargetPath === pathService.resolve(settingsPath)) {
        return Option.none<string>();
      }
      yield* fs
        .makeDirectory(pathService.dirname(linkTargetPath), { recursive: true })
        .pipe(Effect.ignore({ log: true }));
      return Option.some(linkTargetPath);
    }).pipe(Effect.orElseSucceed(() => Option.none<string>()));

    const initialLinkTarget = yield* watchLinkTarget;
    const linkTargetEvents = Stream.make(initialLinkTarget).pipe(
      Stream.concat(watchFileChanges(settingsPath).pipe(Stream.mapEffect(() => watchLinkTarget))),
      Stream.changes,
      Stream.switchMap(
        Option.match({
          onNone: () => Stream.empty,
          onSome: (linkTargetPath) =>
            watchFileChanges(linkTargetPath).pipe(Stream.ignore({ log: true })),
        }),
      ),
    );

    // Editors emit multiple events per save (truncate, write, rename) and
    // `fs.watch` can fire before the content has been flushed to disk.
    const debouncedSettingsEvents = Stream.merge(
      watchFileChanges(settingsPath),
      linkTargetEvents,
    ).pipe(Stream.debounce(Duration.millis(100)));

    yield* Stream.runForEach(debouncedSettingsEvents, () => revalidateAndEmitSafely).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(watcherScope),
      Effect.asVoid,
    );
  });

  const start = Effect.gen(function* () {
    const shouldStart = yield* Ref.modify(startedRef, (started) => [!started, true]);
    if (!shouldStart) {
      return yield* Deferred.await(startedDeferred);
    }

    const startup = writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        yield* startWatcher;
        yield* reloadSettings;
      }),
    );

    const startupExit = yield* Effect.exit(startup);
    if (startupExit._tag === "Failure") {
      yield* Deferred.failCause(startedDeferred, startupExit.cause).pipe(Effect.orDie);
      return yield* Effect.failCause(startupExit.cause);
    }

    yield* Deferred.succeed(startedDeferred, undefined).pipe(Effect.orDie);
  });

  const ownerServices = ownerPolicyServices(
    ownerPublication,
    ownerIdentity,
    (effect) => writeSemaphore.withPermits(1)(effect),
    getSettingsFromCache,
    updateSettingsWhileLocked,
  );

  return {
    committedOwnerPolicy: ownerServices.committed,
    ownerPolicyAdministration: ownerServices.administration,
    start,
    ready: Deferred.await(startedDeferred),
    getSettings: getSettingsFromCache.pipe(
      Effect.flatMap(materializeSettingsSecrets),
      Effect.map(resolveTextGenerationProvider),
    ),
    updateSettings: (patch, authorizeAtCommit) =>
      updateAndPersistSettings(
        (current) =>
          (authorizeAtCommit ?? Effect.void).pipe(
            Effect.andThen(rejectMemoryHubSettingsPatch(patch, settingsPath)),
            Effect.flatMap(() => stampGoatclaw(current, applyServerSettingsPatch(current, patch))),
          ),
        Object.keys(patch.providerInstances ?? {}).map((id) => id as ProviderInstanceId),
      ),
    updateSettingsWith: (patchFor, authorizeAtCommit) =>
      updateAndPersistSettings((current) =>
        Effect.gen(function* () {
          if (authorizeAtCommit) yield* authorizeAtCommit;
          const patch = yield* patchFor(current);
          yield* rejectMemoryHubSettingsPatch(patch, settingsPath);
          return yield* stampGoatclaw(current, applyServerSettingsPatch(current, patch));
        }),
      ),
    updateProviderInstance: (mutation, patch = {}, approval, authorizeAtCommit) =>
      updateAndPersistSettings(
        (current) =>
          Effect.gen(function* () {
            if (authorizeAtCommit) yield* authorizeAtCommit;
            if (approval) {
              if (Option.isNone(routeState))
                return yield* new ServerSettingsError({ settingsPath, operation: "normalize" });
              yield* routeState.value.validate(current, current, approval);
            }
            // Retry comparison uses the same envelope shape as a committed
            // instance: legacy config.enabled lives on the envelope after save.
            const canonicalInstance =
              mutation.operation === "create"
                ? foldProviderInstanceEnabledFlags(applyProviderInstanceMutation(current, mutation))
                    .providerInstances[mutation.instanceId]
                : undefined;
            const effectiveMutation =
              mutation.operation === "create" &&
              current.providerInstances[mutation.instanceId] !== undefined &&
              canonicalInstance !== undefined &&
              CodexRoute.instanceFingerprint(current.providerInstances[mutation.instanceId]) ===
                CodexRoute.instanceFingerprint(canonicalInstance)
                ? { ...mutation, operation: "upsert" as const, instance: canonicalInstance }
                : mutation;
            yield* rejectMemoryHubSettingsPatch(patch, settingsPath);
            yield* ensureProviderInstanceMutationAllowed(current, effectiveMutation, settingsPath);
            const patched = applyServerSettingsPatch(current, patch);
            return applyProviderInstanceMutation(patched, effectiveMutation);
          }),
        [mutation.instanceId],
      ),
    applyMemoryHubTransition: (input, permit) =>
      writeSemaphore.withPermits(1)(applyHubLocked(input, permit)),
    adminSettings: hubAdministrationSettings(
      getSettingsFromCache,
      (effect) => writeSemaphore.withPermits(1)(effect),
      Ref.get(hubMarkerRef),
      applyHubLocked,
      Ref.get(committedHubRef).pipe(Effect.map((s) => s.publication)),
    ),
    committedProviderPolicy: providerPolicy.service,
    committedHubSettings: {
      read: Ref.get(committedHubRef).pipe(
        Effect.map(({ settings, version, provenance }) => ({ settings, version, provenance })),
      ),
      readPublication: Ref.get(committedHubRef).pipe(Effect.map((s) => s.publication)),
    },
    checkpointReplicationPermit: (host) => checkpointAdmission.permit(host, getSettingsFromCache),
    withSettingsSnapshot,
    withStoredSettingsSnapshot: <A, E, R>(
      use: (settings: ServerSettings) => Effect.Effect<A, E, R>,
    ) => writeSemaphore.withPermits(1)(getSettingsFromCache.pipe(Effect.flatMap(use))),
    get subscribeProviderChanges() {
      return PubSub.subscribe(providerChangesPubSub).pipe(
        Effect.map((subscription) =>
          Stream.fromSubscription(subscription).pipe(
            Stream.mapEffect((event) =>
              materializeSettingsSecrets(event.settings).pipe(
                Effect.map((settings) => ({
                  ...event,
                  settings: resolveTextGenerationProvider(settings),
                })),
              ),
            ),
          ),
        ),
      );
    },
    get streamChanges() {
      return materializeChanges(Stream.fromPubSub(changesPubSub));
    },
    get subscribeChanges() {
      return PubSub.subscribe(changesPubSub).pipe(
        Effect.map((subscription) => materializeChanges(Stream.fromSubscription(subscription))),
      );
    },
  } satisfies ServerSettingsService["Service"] &
    MemoryHubSettingsTransitions["Service"] & {
      adminSettings: MemoryHubAdminSettings["Service"];
      committedHubSettings: MemoryHubCommittedSettings["Service"];
      committedProviderPolicy: MemoryProviderCommittedPolicy["Service"];
      committedOwnerPolicy: MemoryOwnerSourceReadCommittedPolicy["Service"];
      ownerPolicyAdministration: MemoryOwnerSourceReadPolicyAdministration["Service"];
    };
});
const settingsLayers = (
  service: ServerSettingsService["Service"] &
    MemoryHubSettingsTransitions["Service"] & {
      adminSettings: MemoryHubAdminSettings["Service"];
      committedHubSettings: MemoryHubCommittedSettings["Service"];
      committedProviderPolicy: MemoryProviderCommittedPolicy["Service"];
      committedOwnerPolicy: MemoryOwnerSourceReadCommittedPolicy["Service"];
      ownerPolicyAdministration: MemoryOwnerSourceReadPolicyAdministration["Service"];
    },
) =>
  Layer.mergeAll(
    Layer.succeed(ServerSettingsService, service),
    Layer.succeed(MemoryHubCommittedSettings, service.committedHubSettings),
    Layer.succeed(MemoryProviderCommittedPolicy, service.committedProviderPolicy),
    Layer.succeed(MemoryOwnerSourceReadCommittedPolicy, service.committedOwnerPolicy),
    Layer.succeed(MemoryOwnerSourceReadPolicyAdministration, service.ownerPolicyAdministration),
    Layer.succeed(MemoryHubAdminSettings, service.adminSettings),
    Layer.succeed(MemoryHubSettingsTransitions, {
      applyMemoryHubTransition: service.applyMemoryHubTransition,
    }),
  );

export const layer = Layer.unwrap(make.pipe(Effect.map(settingsLayers)));
