import * as CodexRoute from "../provider/CodexRouteService.ts";
import * as AdapterInfrastructure from "../provider/ProviderOrchestrationAdapterInfrastructure.ts";
import type { MemorySnapshotPolicy } from "../memory/MemorySnapshot.ts";
import { AgentScope } from "@goat/shared/AgentScope";
import * as KeyedLock from "@goat/shared/KeyedLock";
import { resolveProjectSettings } from "@goat/shared/projectSettings";
import {
  COMPUTER_USE_LEASE_ROUTE,
  isOrchestrationV2WorkActive,
  ModelSelection,
  type AuthEnvironmentScope,
  type MemoryTaskGrantCeiling,
  type RunId,
  type NodeId,
  OrchestrationV2DomainEvent,
  OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  OrchestrationV2RuntimeRequest,
  ProviderInstanceId,
  type ProviderInteractionMode,
  type TurnCapability,
  ProviderSessionId,
  ThreadId,
  type ProviderThreadId,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { normalizeModelMetricLabel } from "../observability/Attributes.ts";
import {
  providerSessionsTotal,
  providerTurnDuration,
  providerTurnsTotal,
  withMetrics,
} from "../observability/Metrics.ts";
import { ProviderWorkspaceMissingError } from "../provider/Errors.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ServerSettings from "../serverSettings.ts";
import * as CuaDriver from "../cua/CuaDriver.ts";
import * as ComputerUse from "../cua/ComputerUseAttachment.ts";
import { withTurnAgentAccess } from "./TurnCapabilities.ts";
import { type PrepareReuse, selectPrepareInput } from "./McpPrepareInput.ts";
import * as ComputerUseLeases from "../cua/ComputerUseLeases.ts";
import * as ComputerUseOrigin from "../cua/ComputerUseOrigin.ts";
import * as PermissionProfiles from "../goatclaw/PermissionProfiles.ts";
import type { McpProviderSessionConfig } from "@goat/provider-core/server/mcpSession";
import * as MemoryAccess from "../memory/MemoryAccess.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as EventSink from "./EventSink.ts";
import * as CommandOutputHub from "./CommandOutputHub.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { makeScopeCloser } from "./ProviderSessionScopeClose.ts";

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_IDLE_PIN_MS = 4 * 60 * 60 * 1000;
const RELEASE_SCOPE_CLOSE_TIMEOUT_MS = 30 * 1000;

const busyTurnPrefix = (providerThreadId: ProviderThreadId) => `${providerThreadId}#`;
const busyTurnKey = (providerThreadId: ProviderThreadId, runOrdinal: number) =>
  `${busyTurnPrefix(providerThreadId)}${runOrdinal}`;
const UNLOAD_THREAD_TIMEOUT_MS = 10 * 1000;

export const ProviderSessionReleaseReason = Schema.Literals([
  "idle_timeout",
  "runtime_error",
  "manual_shutdown",
  "server_shutdown",
]);
export type ProviderSessionReleaseReason = typeof ProviderSessionReleaseReason.Type;

export class ProviderSessionOpenError extends Schema.TaggedError<ProviderSessionOpenError>()(
  "ProviderSessionOpenError",
  {
    instanceId: ProviderInstanceId,
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to open provider instance ${this.instanceId} session ${this.providerSessionId}.`;
  }
}

export class ProviderSessionLookupError extends Schema.TaggedError<ProviderSessionLookupError>()(
  "ProviderSessionLookupError",
  {
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to look up provider session ${this.providerSessionId}.`;
  }
}

export class ProviderSessionCloseError extends Schema.TaggedError<ProviderSessionCloseError>()(
  "ProviderSessionCloseError",
  {
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to close provider session ${this.providerSessionId}.`;
  }
}

export class ProviderSessionReleaseError extends Schema.TaggedError<ProviderSessionReleaseError>()(
  "ProviderSessionReleaseError",
  {
    providerSessionId: ProviderSessionId,
    reason: ProviderSessionReleaseReason,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to release provider session ${this.providerSessionId}.`;
  }
}

export class ProviderSessionActivityError extends Schema.TaggedError<ProviderSessionActivityError>()(
  "ProviderSessionActivityError",
  {
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to update provider session activity for ${this.providerSessionId}.`;
  }
}

export const ProviderSessionManagerV2Error = Schema.Union([
  ProviderSessionOpenError,
  ProviderWorkspaceMissingError,
  ProviderSessionLookupError,
  ProviderSessionCloseError,
  ProviderSessionReleaseError,
  ProviderSessionActivityError,
]);
export type ProviderSessionManagerV2Error = typeof ProviderSessionManagerV2Error.Type;

export interface ProviderMemoryPrepareInput {
  readonly runId?: RunId;
  readonly delegatedTaskId?: NodeId;
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  /** Explicit null is ordinary; missing legacy task authority is none. */
  readonly memoryGrantCeiling?: MemoryTaskGrantCeiling | null;
  readonly readOnly?: boolean;
  /** Plan turns never get computer use. */
  readonly interactionMode?: ProviderInteractionMode;
  readonly dispatchScopes?: ReadonlyArray<AuthEnvironmentScope>;
  /** What this turn's `@computer` / `@browser` chips asked for; the next turn starts over. */
  readonly turnCapabilities?: ReadonlyArray<TurnCapability>;
}

/** What opening a provider session for a turn admits; the same for a new or a shared session. */
function openPrepareInput(
  input: Parameters<ProviderSessionManagerV2Shape["open"]>[0],
  providerInstanceId: ProviderInstanceId,
): ProviderMemoryPrepareInput {
  const sandbox = input.runtimePolicy.sandboxPolicy;
  return {
    threadId: input.threadId,
    providerInstanceId,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.delegatedTaskId === undefined ? {} : { delegatedTaskId: input.delegatedTaskId }),
    ...(input.memoryGrantCeiling === undefined
      ? {}
      : { memoryGrantCeiling: input.memoryGrantCeiling }),
    ...(input.dispatchScopes === undefined ? {} : { dispatchScopes: input.dispatchScopes }),
    readOnly:
      input.readOnly === true ||
      sandbox === "read-only" ||
      (typeof sandbox === "object" &&
        sandbox !== null &&
        "type" in sandbox &&
        sandbox.type === "readOnly"),
    interactionMode: input.runtimePolicy.interactionMode,
    turnCapabilities: input.turnCapabilities ?? [],
  };
}

export interface McpCredentialRotation {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId: string;
  readonly grantedScopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly memoryPolicy: McpSessionRegistry.McpMemoryPolicy;
}

export interface ProviderSessionManagerV2Shape {
  /** Positive execution authority with prepare identity; callers also match the run/task projection. */
  readonly memoryAccessInputs?: (
    threadId: ThreadId,
    providerInstanceId: ProviderInstanceId,
  ) => Effect.Effect<
    | (ProviderMemoryPrepareInput & {
        readonly currentMemoryGrant: Exclude<MemoryTaskGrantCeiling, "none">;
      })
    | undefined
  >;
  readonly currentMemoryPolicy?: (threadId: ThreadId) => Effect.Effect<MemorySnapshotPolicy>;
  readonly prepareMcpSession?: (input: ProviderMemoryPrepareInput) => Effect.Effect<void>;
  readonly mcpCredentialRotations?: Stream.Stream<McpCredentialRotation>;

  readonly shutdown: Effect.Effect<void>;
  readonly open: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly modelSelection: ModelSelection;
    readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
    readonly runId?: RunId;
    readonly delegatedTaskId?: NodeId;
    readonly memoryGrantCeiling?: MemoryTaskGrantCeiling | null;
    readonly readOnly?: boolean;
    readonly dispatchScopes?: ReadonlyArray<AuthEnvironmentScope>;
    readonly turnCapabilities?: ReadonlyArray<TurnCapability>;
    readonly resumeFromSession?: OrchestrationV2ProviderSession;
    readonly initialNativeThreadId?: string;
    readonly initialProviderItemIdentityVersion?: 2;
  }) => Effect.Effect<
    ProviderAdapter.ProviderAdapterV2SessionRuntime,
    ProviderSessionManagerV2Error
  >;
  readonly get: (
    providerSessionId: ProviderSessionId,
  ) => Effect.Effect<
    Option.Option<ProviderAdapter.ProviderAdapterV2SessionRuntime>,
    ProviderSessionManagerV2Error
  >;
  readonly isLive: (providerSessionId: ProviderSessionId) => Effect.Effect<boolean>;
  readonly close: (
    providerSessionId: ProviderSessionId,
  ) => Effect.Effect<void, ProviderSessionManagerV2Error>;
  readonly closeInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<void, ProviderSessionManagerV2Error>;
  readonly release: (input: {
    readonly providerSessionId: ProviderSessionId;
    readonly reason: ProviderSessionReleaseReason;
    readonly detail?: string;
  }) => Effect.Effect<void, ProviderSessionManagerV2Error>;
  readonly detach: (input: {
    readonly providerSessionId: ProviderSessionId;
    readonly threadId: ThreadId;
    readonly detail?: string;
    readonly revokeMcpCredential?: boolean;
  }) => Effect.Effect<void, ProviderSessionManagerV2Error>;
}

export class ProviderSessionManagerV2 extends Context.Service<
  ProviderSessionManagerV2,
  ProviderSessionManagerV2Shape
>()("goat/orchestration-v2/ProviderSessionManager/ProviderSessionManagerV2") {}

interface LiveSessionEntry {
  readonly attachedThreadIds: ReadonlySet<ThreadId>;
  readonly loadedProviderThreadKeyByThread: ReadonlyMap<ThreadId, string>;
  /** Scope revocation to recorded credential ids so superseded sessions cannot revoke replacements opened before detach. */
  readonly mcpCredentialIdByThread: ReadonlyMap<ThreadId, string>;
  readonly supportsMultipleProviderThreads: boolean;
  readonly runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
  readonly exposedRuntime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
  readonly eventSubscribers: Ref.Ref<
    ReadonlyMap<number, Queue.Queue<ProviderSessionEventSignal, Cause.Done>>
  >;
  readonly requestEventPermit: Semaphore.Semaphore;
  readonly scope: Scope.Closeable;
  readonly idleGeneration: number;
  readonly busyTurns: ReadonlySet<string>;
  readonly busyTurnByThread: ReadonlyMap<ThreadId, string>;
  readonly lastActivityAtMs: number;
  readonly idleFiber: Fiber.Fiber<void, never> | null;
  readonly pinnedSinceMs: number | null;
  readonly idleThreadUnloads: ReadonlyMap<ThreadId, IdleThreadUnload>;
}

interface IdleThreadUnload {
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly generation: number;
  readonly fiber: Fiber.Fiber<void, never> | null;
}

type ProviderSessionEventSignal =
  | { readonly type: "event"; readonly event: ProviderAdapter.ProviderAdapterV2Event }
  | {
      readonly type: "failure";
      readonly cause: Cause.Cause<ProviderAdapter.ProviderAdapterV2Error>;
    };

export interface ProviderSessionManagerV2LayerOptions {
  readonly idleTimeoutMs?: number;
  readonly maxIdlePinMs?: number;
  readonly configureMcp?: boolean;
  /** Test barrier after activity/removal updates, before awaiting idle-fiber interruption. */
  readonly beforeIdleFiberInterrupt?: Effect.Effect<void>;
}

function releaseStatusFor(
  reason: ProviderSessionReleaseReason,
): OrchestrationV2ProviderSession["status"] {
  return reason === "runtime_error" ? "error" : "stopped";
}

function releasedRuntimeRequestStatusFor(
  reason: ProviderSessionReleaseReason,
): OrchestrationV2RuntimeRequest["status"] {
  return reason === "manual_shutdown" || reason === "server_shutdown" ? "cancelled" : "expired";
}

function sessionKey(providerSessionId: ProviderSessionId): string {
  return String(providerSessionId);
}

function sessionScopedRuntimeRequestThreadId(
  event: ProviderAdapter.ProviderAdapterV2Event,
): ThreadId | undefined {
  switch (event.type) {
    case "runtime_request.updated":
      return event.runtimeRequest.providerTurnId === null ? event.threadId : undefined;
    case "node.updated":
      return event.node.runId === null && event.node.runtimeRequestId !== null
        ? event.node.threadId
        : undefined;
    case "turn_item.updated":
      return event.turnItem.runId === null &&
        (event.turnItem.type === "approval_request" || event.turnItem.type === "user_input_request")
        ? event.turnItem.threadId
        : undefined;
    default:
      return undefined;
  }
}

function providerThreadRuntimeKey(
  providerThread: Parameters<
    ProviderAdapter.ProviderAdapterV2SessionRuntime["resumeThread"]
  >[0]["providerThread"],
): string {
  const nativeThreadRef = providerThread.nativeThreadRef;
  return nativeThreadRef === null
    ? String(providerThread.id)
    : `${nativeThreadRef.driver}:${nativeThreadRef.nativeId}`;
}

function providerThreadLoadKey(input: {
  readonly providerThread: Parameters<
    ProviderAdapter.ProviderAdapterV2SessionRuntime["resumeThread"]
  >[0]["providerThread"];
  readonly modelSelection?: ModelSelection;
  readonly runtimePolicy?: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
}): string {
  return JSON.stringify({
    providerThread: providerThreadRuntimeKey(input.providerThread),
    modelSelection: input.modelSelection ?? null,
    runtimePolicy: input.runtimePolicy ?? null,
  });
}

export const layerWithOptions = (
  options: ProviderSessionManagerV2LayerOptions = {},
): Layer.Layer<
  ProviderSessionManagerV2,
  never,
  | CommandOutputHub.CommandOutputHub
  | EventSink.EventSinkV2
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | McpSessionRegistry.McpSessionRegistry
  | ProjectionStore.ProjectionStoreV2
  | ProviderEventIngestor.ProviderEventIngestorV2
  | ProviderAdapterRegistry.ProviderAdapterRegistryV2
> =>
  Layer.effect(
    ProviderSessionManagerV2,
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
      const codexRoutes = yield* Effect.serviceOption(CodexRoute.CodexRouteState);
      const fileSystem = yield* FileSystem.FileSystem;
      const mcpSessionRegistry = yield* McpSessionRegistry.McpSessionRegistry;
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const admission = yield* Effect.serviceOption(AdapterInfrastructure.ProviderMemoryAdmission);
      /** Unreadable settings must preserve explicit browser-access opt-outs. */
      const serverSettings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
      /**
       * Optional like settings. Every prepare asks the computer use decision
       * again, so enabling or disabling it reaches a live session on its next
       * turn.
       */
      const cuaDriver = yield* Effect.serviceOption(CuaDriver.CuaDriver);
      /** Absent only in test assemblies; without it every turn counts as unleased. */
      const computerUseLeases = yield* Effect.serviceOption(ComputerUseLeases.ComputerUseLeases);
      /** Absent only in test assemblies, which then run without goatclaw limits. */
      const permissionProfiles = yield* Effect.serviceOption(PermissionProfiles.PermissionProfiles);
      // An enabled policy fails closed: a thread whose limit cannot be read gets no native subagents.
      const withNativeSubagentLimit = (threadId: ThreadId, config: McpProviderSessionConfig) =>
        Effect.gen(function* () {
          const { nativeSubagentLimit: _previous, ...rest } = config;
          if (Option.isNone(permissionProfiles)) return rest;
          const limit = yield* permissionProfiles.value.nativeSubagentLimit(threadId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not read the goatclaw subagent limit; allowing none.", {
                cause,
              }).pipe(Effect.as(0)),
            ),
          );
          return limit === undefined ? rest : { ...rest, nativeSubagentLimit: limit };
        });
      const originReads = ComputerUseOrigin.projectionOriginReads({
        getThreadRecords: (id, fields, filter) =>
          projectionStore.getThreadRecords(id, fields, filter),
        channelOrigin: (id) =>
          Option.isSome(computerUseLeases)
            ? computerUseLeases.value.channelOrigin(id)
            : Effect.succeed(undefined),
      });
      const computerUseOriginOf = (threadId: ThreadId, runId: RunId | undefined) =>
        ComputerUseOrigin.computerUseOrigin(originReads, { threadId, runId });
      const memoryPolicy = yield* Effect.serviceOption(
        ServerSettings.MemoryProviderCommittedPolicy,
      );
      // Acquire the subscription before any credential can be prepared.
      const memoryRotations = Option.isSome(memoryPolicy)
        ? yield* memoryPolicy.value.subscribeRotations
        : undefined;
      const credentialRotations = yield* PubSub.unbounded<McpCredentialRotation>();
      const memoryPrepareInputs = new Map<
        ThreadId,
        ProviderMemoryPrepareInput & {
          readonly destinationUsable: boolean;
          readonly providerSessionId?: ProviderSessionId | undefined;
        }
      >();
      // Only an explicit admission may seed the following open. Rotation/reuse
      // metadata alone must not authorize a different admission or provider.
      const pendingMemoryAdmissions = new Map<ThreadId, ProviderMemoryPrepareInput>();
      const projectService = yield* Effect.serviceOption(ProjectService.ProjectService);
      const eventSink = yield* EventSink.EventSinkV2;
      const commandOutput = yield* CommandOutputHub.CommandOutputHub;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const providerEventIngestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const agentScope = yield* AgentScope;
      const agentAccessSettings = Effect.fn("ProviderSessionManagerV2.agentAccessSettings")(
        function* (threadId: ThreadId) {
          if (Option.isNone(serverSettings)) return { browser: true, device: false };
          return yield* Effect.gen(function* () {
            const settings = yield* serverSettings.value.getSettings;
            const thread = yield* projectionStore.getThread(threadId);
            const entries = Object.values(settings.projectSettingsOverrides);
            const browserOverridden = entries.some(
              (entry) => entry.enableAgentBrowserAccess !== undefined,
            );
            const deviceOverridden = entries.some(
              (entry) => entry.enableAgentDeviceAccess !== undefined,
            );
            if (browserOverridden || deviceOverridden) {
              const project = Option.isSome(projectService)
                ? yield* projectService.value.getById(thread.projectId)
                : Option.none();
              if (Option.isNone(project))
                return {
                  browser: browserOverridden ? false : settings.enableAgentBrowserAccess,
                  device: deviceOverridden ? false : settings.enableAgentDeviceAccess,
                };
            }
            const effective = resolveProjectSettings(settings, thread.projectId).settings;
            return {
              browser: effective.enableAgentBrowserAccess,
              device: effective.enableAgentDeviceAccess,
            };
          }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning(
                "Could not resolve agent access; withholding browser and device tools.",
                { threadId, cause },
              ).pipe(Effect.as({ browser: false, device: false })),
            ),
          );
        },
      );
      const layerScope = yield* Effect.scope;
      // Group signals stop providers before restart capture; drop post-signal events so recovery owns that state.
      const shutdownSignal = { received: false };
      const onShutdownSignal = () => {
        shutdownSignal.received = true;
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          process.on("SIGINT", onShutdownSignal);
          process.on("SIGTERM", onShutdownSignal);
        }),
        () =>
          Effect.sync(() => {
            process.off("SIGINT", onShutdownSignal);
            process.off("SIGTERM", onShutdownSignal);
          }),
      );
      const sessions = yield* Ref.make(new Map<string, LiveSessionEntry>());
      // Retry per released entry; reusing ids must not lose cleanup for earlier threads.
      const releaseRecordRetries = yield* FiberSet.make();
      const nextSubscriberId = yield* Ref.make(0);
      const sessionOpen = yield* KeyedLock.make<ProviderSessionId>();
      const threadAttachment = yield* KeyedLock.make<string>();
      const threadAttachmentKey = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
      }) => `${input.providerSessionId}\u0000${input.threadId}`;
      const idleTimeoutMs = Math.max(1, options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
      const maxIdlePinMs = Math.max(0, options.maxIdlePinMs ?? DEFAULT_MAX_IDLE_PIN_MS);
      interface PreparedMcpCredential {
        readonly mcpCredentialId: string | undefined;
        readonly issued: boolean;
      }
      /** ACP and OpenCode consume credentials during openSession; reserve them against revocation until publication. */
      const mcpCredentialReservations = new Map<string, number>();
      const mcpReservationKey = (threadId: ThreadId, mcpCredentialId: string) =>
        `${threadId}\0${mcpCredentialId}`;
      const reserveMcpCredential = (threadId: ThreadId, mcpCredentialId: string) => {
        const key = mcpReservationKey(threadId, mcpCredentialId);
        mcpCredentialReservations.set(key, (mcpCredentialReservations.get(key) ?? 0) + 1);
      };
      const dropMcpCredentialReservation = (threadId: ThreadId, mcpCredentialId: string) => {
        const key = mcpReservationKey(threadId, mcpCredentialId);
        const count = mcpCredentialReservations.get(key) ?? 0;
        if (count <= 1) {
          mcpCredentialReservations.delete(key);
        } else {
          mcpCredentialReservations.set(key, count - 1);
        }
      };
      const isMcpCredentialReserved = (threadId: ThreadId, mcpCredentialId: string) =>
        (mcpCredentialReservations.get(mcpReservationKey(threadId, mcpCredentialId)) ?? 0) > 0;
      const isCurrentAttachment = (
        config: import("@goat/provider-core/server/mcpSession").McpProviderSessionConfig,
      ) =>
        Effect.gen(function* () {
          const threadId = config.threadId;
          const prepared = memoryPrepareInputs.get(threadId);
          const holdsCurrentAuthority = mcpSessions
            .read(threadId)
            .pipe(
              Effect.map(
                (current) =>
                  current?.providerSessionId === config.providerSessionId &&
                  current.credentialGeneration === config.credentialGeneration,
              ),
            );
          if (!prepared || !(yield* holdsCurrentAuthority)) return false;
          const attached =
            isMcpCredentialReserved(threadId, config.providerSessionId) ||
            Array.from((yield* Ref.get(sessions)).values()).some(
              (entry) =>
                entry.runtime.instanceId === prepared.providerInstanceId &&
                entry.attachedThreadIds.has(threadId) &&
                entry.mcpCredentialIdByThread.get(threadId) === config.providerSessionId,
            );
          if (!attached) return false;
          const thread = yield* projectionStore.getThread(threadId).pipe(Effect.option);
          return (
            Option.isSome(thread) &&
            thread.value.deletedAt === null &&
            thread.value.archivedAt === null &&
            thread.value.providerInstanceId === prepared.providerInstanceId &&
            // Authority can be replaced under the same id while the thread is read.
            (yield* holdsCurrentAuthority)
          );
        });
      const currentMemoryPolicy = (threadId: ThreadId) =>
        Effect.gen(function* () {
          const committed = Option.isSome(memoryPolicy)
            ? yield* memoryPolicy.value.read
            : undefined;
          const denied = { grant: "none" as const, policyEpoch: committed?.epoch ?? 0 };
          if (!committed?.policyReady || !committed.enableAgentMemoryAccess) return denied;
          const config = yield* mcpSessions.read(threadId);
          if (!config) return denied;
          const policy = yield* (
            mcpSessionRegistry.currentMemoryPolicy?.(config.providerSessionId) ??
              Effect.succeed(undefined)
          );
          // Denied credentials never need the attachment's thread projection.
          if (!policy || policy.grant === "none" || policy.policyEpoch !== committed.epoch)
            return denied;
          return (yield* isCurrentAttachment(config)) ? policy : denied;
        });
      if (Option.isSome(admission))
        yield* admission.value.bind(currentMemoryPolicy, isCurrentAttachment);
      const mcpPrepareLock = yield* KeyedLock.make<ThreadId>();
      /** Serialize prepares per thread so concurrent rotations cannot revoke each other's credentials. */
      const prepareMcpSession = (
        input: ProviderMemoryPrepareInput,
        reusePreparedInput: PrepareReuse = false,
      ): Effect.Effect<PreparedMcpCredential> =>
        options.configureMcp === false
          ? mcpSessions
              .clear(input.threadId)
              .pipe(Effect.as<PreparedMcpCredential>({ mcpCredentialId: undefined, issued: false }))
          : mcpPrepareLock.withLock(
              input.threadId,
              Effect.gen(function* () {
                const previousInput = memoryPrepareInputs.get(input.threadId);
                const preparedInput = selectPrepareInput(input, reusePreparedInput, previousInput);
                if (preparedInput === undefined)
                  return { mcpCredentialId: undefined, issued: false };
                const { threadId, providerInstanceId } = preparedInput;
                const thread = yield* projectionStore.getThread(threadId).pipe(Effect.option);
                const usableThread =
                  Option.isSome(thread) &&
                  thread.value.deletedAt === null &&
                  thread.value.archivedAt === null &&
                  thread.value.providerInstanceId === providerInstanceId;
                memoryPrepareInputs.set(threadId, {
                  ...preparedInput,
                  destinationUsable: usableThread,
                  providerSessionId:
                    previousInput?.providerInstanceId === providerInstanceId
                      ? previousInput.providerSessionId
                      : undefined,
                });
                const readOnly = preparedInput.readOnly === true;
                const threadReadAllowed = usableThread;
                const committed = Option.isSome(memoryPolicy)
                  ? yield* memoryPolicy.value.read
                  : { policyReady: false, enableAgentMemoryAccess: false, epoch: 0 };
                const grant = MemoryAccess.effectiveMemoryGrant({
                  ...committed,
                  readOnly,
                  memoryGrantCeiling: usableThread ? preparedInput.memoryGrantCeiling : "none",
                  ...(preparedInput.dispatchScopes === undefined
                    ? {}
                    : { dispatchScopes: preparedInput.dispatchScopes }),
                });
                const issuedPolicy = { grant, policyEpoch: committed.epoch };
                const grantedScopes: ReadonlyArray<AuthEnvironmentScope> = [
                  ...(grant === "none" ? [] : ["memory:read" as const]),
                  ...(grant === "read_write" ? ["memory:write" as const] : []),
                  ...(threadReadAllowed ? ["orchestration:read" as const] : []),
                ];
                const readCurrentPolicy = () =>
                  Effect.gen(function* () {
                    if (Option.isNone(memoryPolicy)) return undefined;
                    const current = yield* memoryPolicy.value.read;
                    if (!current.policyReady) return undefined;
                    return {
                      policyEpoch: current.epoch,
                      grant: MemoryAccess.effectiveMemoryGrant({
                        ...current,
                        readOnly,
                        memoryGrantCeiling: usableThread
                          ? preparedInput.memoryGrantCeiling
                          : "none",
                        ...(preparedInput.dispatchScopes === undefined
                          ? {}
                          : { dispatchScopes: preparedInput.dispatchScopes }),
                      }),
                    };
                  });
                let issuedCredentialId: string | undefined;
                const holdsCredential = (entry: LiveSessionEntry) =>
                  entry.runtime.instanceId === providerInstanceId &&
                  entry.attachedThreadIds.has(threadId) &&
                  entry.mcpCredentialIdByThread.get(threadId) === issuedCredentialId;
                const isLiveCaller = Ref.get(sessions).pipe(
                  Effect.map((current) =>
                    Array.from(current.values()).some(
                      (entry) =>
                        holdsCredential(entry) &&
                        entry.busyTurnByThread.has(threadId) &&
                        entry.busyTurns.has(entry.busyTurnByThread.get(threadId)!),
                    ),
                  ),
                );
                // Renews idle expiry while GOAT still holds the session; a detached
                // or released one is left to expire.
                const isAttached = Ref.get(sessions).pipe(
                  Effect.map((current) => Array.from(current.values()).some(holdsCredential)),
                );
                // Reuse a still-valid credential for this thread instead of
                // rotating: long-lived provider processes (codex app-server)
                // build their MCP client once per conversation and keep using
                // the credential it started with, so a thread that detaches and
                // re-attaches across a workspace handoff must come back to the
                // same token or the process's tool calls fail auth.
                const { browser: browserToolsAvailable, device: deviceToolsAvailable } =
                  withTurnAgentAccess(
                    yield* agentAccessSettings(threadId),
                    preparedInput.turnCapabilities,
                  );
                const capabilities = new Set<
                  import("../mcp/McpInvocationContext.ts").McpCapability
                >(["orchestration", "worktree", "pull-requests"]);
                if (browserToolsAvailable) capabilities.add("preview");
                if (deviceToolsAvailable) capabilities.add("device");
                if (grant !== "none") capabilities.add("memory");
                const computerUseOrigin = yield* computerUseOriginOf(threadId, preparedInput.runId);
                const computerUse = yield* ComputerUse.computerUseAttachment(cuaDriver, {
                  threadId,
                  driver: yield* registry.get(providerInstanceId).pipe(
                    Effect.map((adapter) => adapter.driver),
                    Effect.orElseSucceed(() => undefined),
                  ),
                  interactionMode: preparedInput.interactionMode,
                  ...(usableThread ? { runtimeMode: thread.value.runtimeMode } : {}),
                  runId: preparedInput.runId,
                  personStarted:
                    preparedInput.runId !== undefined &&
                    (yield* ComputerUseOrigin.personStarted(originReads, {
                      threadId,
                      runId: preparedInput.runId,
                    })),
                  readOnly,
                  origin: computerUseOrigin,
                  leases: computerUseLeases,
                  requested: preparedInput.turnCapabilities,
                });
                const subagent = yield* projectionStore.getThread(threadId).pipe(
                  Effect.map((thread) => thread.lineage.relationshipToParent === "subagent"),
                  Effect.orElseSucceed(() => false),
                );
                const existing = yield* mcpSessions.read(threadId);
                if (existing !== undefined) {
                  // Reserve before async validation so release cannot revoke between validation and reservation.
                  reserveMcpCredential(threadId, existing.providerSessionId);
                  const rawToken = existing.authorizationHeader.replace(/^Bearer\s+/, "");
                  // Interrupted resolution must release the reservation before the caller learns of it.
                  const resolved = yield* mcpSessionRegistry
                    .resolve(rawToken)
                    .pipe(
                      Effect.onInterrupt(() =>
                        Effect.sync(() =>
                          dropMcpCredentialReservation(threadId, existing.providerSessionId),
                        ),
                      ),
                    );
                  if (
                    resolved !== undefined &&
                    resolved.thread.threadId === threadId &&
                    resolved.thread.providerInstanceId === providerInstanceId &&
                    resolved.capabilities.has("preview") === browserToolsAvailable &&
                    resolved.capabilities.has("device") === deviceToolsAvailable &&
                    resolved.readOnly === readOnly &&
                    resolved.grantedScopes?.join(",") === grantedScopes.join(",") &&
                    resolved.memoryPolicy?.grant === grant &&
                    resolved.memoryPolicy.policyEpoch === committed.epoch &&
                    // A credential issued while the lineage read failed is replaced once it works.
                    (resolved.thread.subagent === true) === subagent
                  ) {
                    yield* mcpSessions.set(
                      yield* withNativeSubagentLimit(
                        threadId,
                        ComputerUse.withComputerUse(
                          existing,
                          computerUse,
                          COMPUTER_USE_LEASE_ROUTE,
                        ),
                      ),
                    );
                    return { mcpCredentialId: existing.providerSessionId, issued: false };
                  }
                  dropMcpCredentialReservation(threadId, existing.providerSessionId);
                }
                // A provider process keeps the header it was given for its whole
                // turn, and several harnesses for its whole life, so changed
                // authority is replaced under the same token. Only a different
                // provider instance, or a credential already revoked, gets a new one.
                const renew =
                  existing !== undefined && existing.providerInstanceId === providerInstanceId
                    ? {
                        authorizationHeader: existing.authorizationHeader,
                        providerSessionId: existing.providerSessionId,
                      }
                    : undefined;
                if (renew === undefined) yield* mcpSessionRegistry.revokeThread(threadId);
                const credential = yield* mcpSessionRegistry.issue({
                  threadId,
                  providerInstanceId,
                  browserToolsAvailable,
                  capabilities,
                  grantedScopes,
                  memoryPolicy: issuedPolicy,
                  ...(Option.isNone(memoryPolicy) ? {} : { readCurrentPolicy }),
                  isLiveCaller,
                  isAttached,
                  readOnly,
                  ...(renew === undefined ? {} : { renew }),
                  subagent,
                });
                issuedCredentialId = credential.config.providerSessionId;
                if (renew !== undefined)
                  yield* mcpSessionRegistry.revokeThread(threadId, {
                    exceptProviderSessionId: credential.config.providerSessionId,
                  });
                yield* mcpSessions.set(
                  yield* withNativeSubagentLimit(
                    threadId,
                    ComputerUse.withComputerUse(
                      credential.config,
                      computerUse,
                      COMPUTER_USE_LEASE_ROUTE,
                    ),
                  ),
                );
                yield* Ref.update(
                  sessions,
                  (current) =>
                    new Map(
                      Array.from(current, ([key, entry]) => [
                        key,
                        entry.attachedThreadIds.has(threadId)
                          ? {
                              ...entry,
                              mcpCredentialIdByThread: new Map(entry.mcpCredentialIdByThread).set(
                                threadId,
                                credential.config.providerSessionId,
                              ),
                            }
                          : entry,
                      ]),
                    ),
                );
                const rotation = {
                  threadId,
                  providerInstanceId,
                  providerSessionId: credential.config.providerSessionId,
                  grantedScopes,
                  memoryPolicy: issuedPolicy,
                };
                if (Option.isSome(admission)) yield* admission.value.rotated(rotation);
                else yield* PubSub.publish(credentialRotations, rotation);
                reserveMcpCredential(threadId, credential.config.providerSessionId);
                // A renewed credential is still held by a live process, so a failed
                // open must not revoke it.
                return {
                  mcpCredentialId: credential.config.providerSessionId,
                  issued: credential.renewed !== true,
                };
              }),
            );
      /**
       * With a credential id, revocation is scoped to that credential and the
       * config slot is cleared only while it still holds it; a replacement
       * session's newer credential survives. Without one (attach failed before
       * a credential was recorded), fall back to thread-wide revocation.
       */
      const clearMcpSession = (
        threadId: ThreadId,
        mcpCredentialId?: string,
        admissionToClear:
          | ProviderMemoryPrepareInput
          | null
          | undefined = pendingMemoryAdmissions.get(threadId),
      ) => {
        const clearPreparedInput = () => {
          // Each explicit prepare publishes a distinct object. Cleanup from an
          // older open must leave a later admission (and its rotation input) intact.
          const pending = pendingMemoryAdmissions.get(threadId);
          if (pending !== undefined && pending !== admissionToClear) return;
          memoryPrepareInputs.delete(threadId);
          if (pending === admissionToClear) pendingMemoryAdmissions.delete(threadId);
        };
        return mcpCredentialId === undefined
          ? mcpSessionRegistry.revokeThread(threadId).pipe(
              Effect.tap(() => mcpSessions.clear(threadId)),
              Effect.tap(() => Effect.sync(clearPreparedInput)),
            )
          : mcpSessionRegistry.revokeProviderSession(mcpCredentialId).pipe(
              Effect.tap(() =>
                Effect.gen(function* () {
                  if ((yield* mcpSessions.read(threadId))?.providerSessionId === mcpCredentialId) {
                    yield* mcpSessions.clear(threadId);
                    clearPreparedInput();
                  }
                }),
              ),
            );
      };

      const publishToSubscribers = (
        subscribers: Ref.Ref<
          ReadonlyMap<number, Queue.Queue<ProviderSessionEventSignal, Cause.Done>>
        >,
        signal: ProviderSessionEventSignal,
      ) =>
        Ref.get(subscribers).pipe(
          Effect.flatMap((current) =>
            Effect.forEach(current.values(), (queue) => Queue.offer(queue, signal), {
              discard: true,
            }),
          ),
        );

      const failSubscribers = Effect.fn("ProviderSessionManager.failSubscribers")(function* (
        entry: LiveSessionEntry,
        detail: string,
      ) {
        const error = new ProviderAdapter.ProviderAdapterEventStreamError({
          driver: entry.runtime.driver,
          providerSessionId: entry.runtime.providerSessionId,
          cause: detail,
        });
        const subscribers = yield* Ref.getAndSet(entry.eventSubscribers, new Map());
        yield* Effect.forEach(
          subscribers.values(),
          (queue) =>
            Queue.offer(queue, {
              type: "failure",
              cause: Cause.fail(error),
            }),
          { discard: true },
        );
      });

      // Server shutdown interrupts subscribers rather than ending them: a
      // cleanly ended stream without a terminal fails its run, while an
      // interrupted one leaves run settlement to restart recovery.
      const interruptSubscribers = Effect.fn("ProviderSessionManager.interruptSubscribers")(
        function* (entry: LiveSessionEntry) {
          const subscribers = yield* Ref.getAndSet(entry.eventSubscribers, new Map());
          yield* Effect.forEach(
            subscribers.values(),
            (queue) => Queue.clear(queue).pipe(Effect.andThen(Queue.interrupt(queue))),
            { discard: true },
          );
        },
      );

      // Server shutdown intentionally clears them; a provider-announced Stop
      // must let consumers drain them before the stream completes.
      const endSubscribers = Effect.fn("ProviderSessionManager.endSubscribers")(function* (
        entry: LiveSessionEntry,
      ) {
        const subscribers = yield* Ref.getAndSet(entry.eventSubscribers, new Map());
        yield* Effect.forEach(subscribers.values(), (queue) => Queue.end(queue), {
          discard: true,
        });
      });

      const cancelIdleFiber = (fiber: Fiber.Fiber<void, never> | null) =>
        fiber === null
          ? Effect.void
          : (options.beforeIdleFiberInterrupt ?? Effect.void).pipe(
              Effect.andThen(Fiber.interrupt(fiber)),
              Effect.ignore,
            );

      const writeProviderSessionEvents = Effect.fn(
        "ProviderSessionManager.writeProviderSessionEvents",
      )(function* (input: {
        readonly runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
        readonly threadIds: Iterable<ThreadId>;
        readonly type: "provider-session.attached" | "provider-session.updated";
        readonly payload: OrchestrationV2ProviderSession;
      }) {
        const now = yield* DateTime.now;
        const events = yield* Effect.forEach(input.threadIds, (threadId) =>
          Effect.gen(function* () {
            return {
              id: yield* idAllocator.allocate.event({
                threadId,
                providerSessionId: input.runtime.providerSessionId,
              }),
              type: input.type,
              threadId,
              driver: input.runtime.driver,
              providerInstanceId: input.runtime.instanceId,
              occurredAt: now,
              payload: input.payload,
            } satisfies OrchestrationV2DomainEvent;
          }),
        );
        if (events.length > 0) {
          yield* eventSink.write({ events });
        }
      });

      const writeReleasedSessionEvents = Effect.fn(
        "ProviderSessionManager.writeReleasedSessionEvents",
      )(function* (input: {
        readonly entry: LiveSessionEntry;
        readonly reason: ProviderSessionReleaseReason;
        readonly detail?: string;
      }) {
        if (
          input.entry.runtime.providerSession.capabilities.sessions.executionLocation === "cloud" &&
          input.reason === "server_shutdown"
        )
          return;
        const now = yield* DateTime.now;
        const payload: OrchestrationV2ProviderSession = {
          ...input.entry.runtime.providerSession,
          status: releaseStatusFor(input.reason),
          updatedAt: now,
          lastError:
            input.reason === "runtime_error" ? (input.detail ?? "Provider runtime failed.") : null,
        };
        yield* writeProviderSessionEvents({
          runtime: input.entry.runtime,
          threadIds: input.entry.attachedThreadIds,
          type: "provider-session.updated",
          payload,
        });
      });

      const writeReleasedRuntimeRequestEvents = Effect.fn(
        "ProviderSessionManager.writeReleasedRuntimeRequestEvents",
      )(function* (input: {
        readonly entry: LiveSessionEntry;
        readonly reason: ProviderSessionReleaseReason;
        readonly releasedAt: DateTime.Utc;
      }) {
        const providerSessionId = input.entry.runtime.providerSessionId;
        const now = yield* DateTime.now;
        const status = releasedRuntimeRequestStatusFor(input.reason);
        const reason =
          input.reason === "runtime_error"
            ? "Provider session failed before this runtime request was resolved."
            : "Provider session was closed before this runtime request was resolved.";

        const events: Array<OrchestrationV2DomainEvent> = [];
        for (const threadId of input.entry.attachedThreadIds) {
          const projection = yield* projectionStore.getThreadRecords(
            threadId,
            ["runtimeRequests", "nodes", "turnItems"],
            { turnItemTypes: ["approval_request", "user_input_request"] },
          );
          const releasedRequests = projection.runtimeRequests.filter(
            (request) =>
              request.status === "pending" &&
              request.responseCapability.type === "live" &&
              request.responseCapability.providerSessionId === providerSessionId &&
              DateTime.isLessThanOrEqualTo(request.createdAt, input.releasedAt),
          );

          for (const request of releasedRequests) {
            events.push({
              id: yield* idAllocator.allocate.event({
                threadId,
                providerSessionId,
              }),
              type: "runtime-request.updated",
              threadId,
              nodeId: request.nodeId,
              driver: input.entry.runtime.driver,
              occurredAt: now,
              payload: {
                ...request,
                status,
                responseCapability: {
                  type: "not_resumable",
                  reason,
                },
                resolvedAt: now,
              },
            });

            const requestNode = projection.nodes.find((node) => node.id === request.nodeId);
            if (requestNode !== undefined) {
              events.push({
                id: yield* idAllocator.allocate.event({
                  threadId,
                  providerSessionId,
                }),
                type: "node.updated",
                threadId,
                ...(requestNode.runId === null ? {} : { runId: requestNode.runId }),
                nodeId: requestNode.id,
                driver: input.entry.runtime.driver,
                occurredAt: now,
                payload: {
                  ...requestNode,
                  status: input.reason === "runtime_error" ? "failed" : "cancelled",
                  completedAt: now,
                },
              });
            }

            const turnItem = projection.turnItems.find(
              (item) =>
                (item.type === "approval_request" || item.type === "user_input_request") &&
                item.requestId === request.id,
            );
            if (turnItem !== undefined) {
              events.push({
                id: yield* idAllocator.allocate.event({
                  threadId,
                  providerSessionId,
                }),
                type: "turn-item.updated",
                threadId,
                ...(turnItem.runId === null ? {} : { runId: turnItem.runId }),
                ...(turnItem.nodeId === null ? {} : { nodeId: turnItem.nodeId }),
                driver: input.entry.runtime.driver,
                occurredAt: now,
                payload: {
                  ...turnItem,
                  status: input.reason === "runtime_error" ? "failed" : "cancelled",
                  completedAt: now,
                  updatedAt: now,
                },
              });
            }
          }
        }

        if (events.length > 0) {
          yield* eventSink.write({ events });
        }
      });

      // Read tasks as soon as the session leaves the live map, before a replacement reports its own.
      // Keep OpenCode's roster: its background subagents share a server and can outlive the session.
      const readReleasedBackgroundTasks = Effect.fn(
        "ProviderSessionManager.readReleasedBackgroundTasks",
      )(
        function* (input: {
          readonly entry: LiveSessionEntry;
          readonly reason: ProviderSessionReleaseReason;
          readonly detachedThreadId?: ThreadId;
        }) {
          if (
            input.reason === "server_shutdown" ||
            input.entry.runtime.backgroundTasksEndWithProcess !== true
          ) {
            return [];
          }
          const providerSessionId = input.entry.runtime.providerSessionId;
          const threadIds = new Set(input.entry.attachedThreadIds);
          if (input.detachedThreadId !== undefined) threadIds.add(input.detachedThreadId);
          const released = [];
          for (const threadId of threadIds) {
            const projection = yield* projectionStore.getThreadRecords(threadId, [
              "providerThreads",
            ]);
            for (const providerThread of projection.providerThreads) {
              const tasks = providerThread.pendingBackgroundTasks ?? [];
              if (providerThread.providerSessionId !== providerSessionId || tasks.length === 0) {
                continue;
              }
              released.push({
                threadId,
                providerSessionId,
                providerThreadId: providerThread.id,
                taskIds: new Set(tasks.map((task) => task.taskId)),
              });
            }
          }
          return released;
        },
        (effect, input) =>
          effect.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.provider-session-release-roster-read-failed", {
                providerSessionId: input.entry.runtime.providerSessionId,
                cause,
              }).pipe(Effect.as([])),
            ),
          ),
      );
      type ReleasedBackgroundTasks = Effect.Success<
        ReturnType<typeof readReleasedBackgroundTasks>
      >[number];

      // Dead processes cannot report task endings; stale rosters keep threads Waiting.
      const writeReleasedBackgroundWorkEvents = (
        released: ReadonlyArray<ReleasedBackgroundTasks>,
      ) =>
        Effect.forEach(
          released,
          ({ threadId, providerSessionId, providerThreadId, taskIds }) =>
            Effect.gen(function* () {
              for (let attempt = 0; attempt < 3; attempt++) {
                const projection = yield* projectionStore.getThreadRecords(threadId, [
                  "providerThreads",
                ]);
                const providerThread = projection.providerThreads.find(
                  (candidate) => candidate.id === providerThreadId,
                );
                const tasks = providerThread?.pendingBackgroundTasks ?? [];
                const remaining = tasks.filter((task) => !taskIds.has(task.taskId));
                if (providerThread === undefined || remaining.length === tasks.length) return;
                const now = yield* DateTime.now;
                const { committed } = yield* eventSink.writeIfProviderThreadUnchanged({
                  expected: providerThread,
                  events: [
                    {
                      id: yield* idAllocator.allocate.event({ threadId, providerSessionId }),
                      type: "provider-thread.updated",
                      threadId,
                      driver: providerThread.driver,
                      providerInstanceId: providerThread.providerInstanceId,
                      occurredAt: now,
                      payload: {
                        ...providerThread,
                        pendingBackgroundTasks: remaining,
                        updatedAt: now,
                      },
                    },
                  ],
                });
                if (committed) return;
              }
              yield* Effect.logWarning(
                "orchestration-v2.provider-session-release-roster-conflict",
                {
                  providerSessionId,
                  providerThreadId,
                },
              );
            }),
          { discard: true },
        );

      const writeReleaseRecords = (input: {
        readonly entry: LiveSessionEntry;
        readonly reason: ProviderSessionReleaseReason;
        readonly detail?: string;
        readonly releasedBackgroundTasks: ReadonlyArray<ReleasedBackgroundTasks>;
        readonly releasedAt: DateTime.Utc;
        readonly replaced: boolean;
      }) =>
        Effect.all(
          [
            input.replaced
              ? Effect.succeed(Exit.void)
              : Effect.exit(writeReleasedSessionEvents(input)),
            Effect.exit(
              writeReleasedRuntimeRequestEvents(input).pipe(
                input.entry.requestEventPermit.withPermits(1),
              ),
            ),
            Effect.exit(writeReleasedBackgroundWorkEvents(input.releasedBackgroundTasks)),
          ],
          { concurrency: 1 },
        ).pipe(Effect.flatMap(Exit.asVoidAll));

      // Retry after removal from the live map; later releases cannot clear stale ready sessions and approvals.
      const retryReleaseRecords = (
        input: Omit<Parameters<typeof writeReleaseRecords>[0], "replaced">,
      ) => {
        const providerSessionId = input.entry.runtime.providerSessionId;
        const attempt = Effect.gen(function* () {
          const exit = yield* Effect.exit(
            sessionOpen.withLock(
              providerSessionId,
              Effect.gen(function* () {
                const replaced = (yield* Ref.get(sessions)).has(sessionKey(providerSessionId));
                yield* writeReleaseRecords({ ...input, replaced });
              }),
            ),
          );
          if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return yield* exit;
          yield* Effect.logWarning("orchestration-v2.provider-session-release-records-failed", {
            providerSessionId,
            cause: exit.cause,
          });
          // SQL commit failures are defects; retry every cause except interruption.
          return yield* Effect.fail(exit.cause);
        });
        return attempt.pipe(
          Effect.retry({
            schedule: Schedule.exponential("1 second").pipe(
              Schedule.modifyDelay(({ duration }) =>
                Effect.succeed(Duration.min(duration, Duration.seconds(30))),
              ),
            ),
          }),
          Effect.delay("1 second"),
          FiberSet.run(releaseRecordRetries),
        );
      };

      const logReleaseFailure =
        (providerSessionId: ProviderSessionId) =>
        <E, R>(release: Effect.Effect<void, E, R>) =>
          release.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.provider-session-release-failed", {
                providerSessionId,
                cause,
              }),
            ),
          );

      // A request the event pump is persisting for this runtime lands before
      // the cutoff, and once the entry is gone the pump persists no more for
      // it.
      const removeLiveEntry = Effect.fn("ProviderSessionManager.removeLiveEntry")(
        function* (input: {
          readonly providerSessionId: ProviderSessionId;
          readonly onlyIfIdleGeneration?: number;
        }): Effect.fn.Return<readonly [Option.Option<LiveSessionEntry>, DateTime.Utc]> {
          const key = sessionKey(input.providerSessionId);
          const candidate = (yield* Ref.get(sessions)).get(key);
          if (candidate === undefined) {
            return [Option.none<LiveSessionEntry>(), yield* DateTime.now] as const;
          }
          const removed = yield* Effect.zip(
            Ref.modify(sessions, (current) => {
              const existing = current.get(key);
              if (existing !== candidate) {
                return [existing === undefined ? "gone" : "changed", current] as const;
              }
              if (
                input.onlyIfIdleGeneration !== undefined &&
                (existing.busyTurns.size > 0 ||
                  existing.idleGeneration !== input.onlyIfIdleGeneration)
              ) {
                return ["kept", current] as const;
              }
              const updated = new Map(current);
              updated.delete(key);
              return ["removed", updated] as const;
            }),
            DateTime.now,
          ).pipe(candidate.requestEventPermit.withPermits(1));
          const [outcome, releasedAt] = removed;
          if (outcome === "changed") return yield* removeLiveEntry(input);
          return [
            outcome === "removed" ? Option.some(candidate) : Option.none<LiveSessionEntry>(),
            releasedAt,
          ] as const;
        },
      );

      const {
        closeWithin: closeScopeWithin,
        trackRelease,
        awaitPendingReleases,
      } = makeScopeCloser(RELEASE_SCOPE_CLOSE_TIMEOUT_MS);

      const releaseEntryNow = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly reason: ProviderSessionReleaseReason;
        readonly detail?: string;
        readonly detachedThreadId?: ThreadId;
        readonly cancelIdleFiber?: boolean;
        readonly onlyIfIdleGeneration?: number;
        readonly gracefulSubscribers?: boolean;
      }) =>
        Effect.acquireUseRelease(
          removeLiveEntry(input),
          ([entry, releasedAt]) =>
            Option.match(entry, {
              onNone: () => Effect.void,
              onSome: (entry) =>
                Effect.gen(function* () {
                  const releasedBackgroundTasks = yield* readReleasedBackgroundTasks({
                    entry,
                    reason: input.reason,
                    ...(input.detachedThreadId === undefined
                      ? {}
                      : { detachedThreadId: input.detachedThreadId }),
                  });
                  if (input.cancelIdleFiber !== false) {
                    yield* cancelIdleFiber(entry.idleFiber);
                  }
                  if (input.gracefulSubscribers === true) {
                    yield* endSubscribers(entry);
                  } else if (input.reason === "server_shutdown") {
                    yield* interruptSubscribers(entry);
                  } else {
                    yield* failSubscribers(
                      entry,
                      input.detail ?? `Provider session released: ${input.reason}.`,
                    );
                  }
                  const closeExit = yield* closeScopeWithin(entry.scope, {
                    providerSessionId: input.providerSessionId,
                    reason: input.reason,
                  });
                  const records = {
                    entry,
                    reason: input.reason,
                    ...(input.detail === undefined ? {} : { detail: input.detail }),
                    releasedBackgroundTasks,
                    releasedAt,
                  };
                  const observationOnlyShutdown =
                    input.reason === "server_shutdown" &&
                    entry.runtime.providerSession.capabilities.sessions.executionLocation ===
                      "cloud";
                  const recorded = yield* Effect.exit(
                    observationOnlyShutdown
                      ? Effect.void
                      : writeReleaseRecords({ ...records, replaced: false }),
                  );
                  if (Exit.isFailure(recorded)) {
                    yield* retryReleaseRecords(records);
                    return yield* recorded;
                  }
                  if (Option.isSome(closeExit) && Exit.isFailure(closeExit.value)) {
                    return yield* Effect.failCause(closeExit.value.cause);
                  }
                }).pipe(
                  withMetrics({
                    counter: providerSessionsTotal,
                    attributes: {
                      provider: entry.runtime.driver,
                      operation: "release",
                      reason: input.reason,
                    },
                  }),
                ),
            }),
          ([entry]) =>
            Option.match(entry, {
              onNone: () => Effect.void,
              onSome: (entry) =>
                // Revoke recorded credentials after process death, except those held by live replacements.
                Ref.get(sessions).pipe(
                  Effect.flatMap((current) =>
                    Effect.forEach(
                      entry.mcpCredentialIdByThread,
                      ([threadId, mcpCredentialId]) => {
                        // Only holders of this credential may prevent its revocation; stale credentials must not leak it.
                        const heldElsewhere =
                          isMcpCredentialReserved(threadId, mcpCredentialId) ||
                          Array.from(current.values()).some(
                            (other) =>
                              other !== entry &&
                              (other.attachedThreadIds.has(threadId) ||
                                other.mcpCredentialIdByThread.get(threadId) === mcpCredentialId),
                          );
                        return heldElsewhere
                          ? Effect.void
                          : clearMcpSession(threadId, mcpCredentialId);
                      },
                      { discard: true },
                    ),
                  ),
                ),
            }),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.fail(
              new ProviderSessionReleaseError({
                providerSessionId: input.providerSessionId,
                reason: input.reason,
                cause,
              }),
            ),
          ),
        );
      const releaseEntry = (input: Parameters<typeof releaseEntryNow>[0]) =>
        trackRelease(releaseEntryNow(input));

      const releaseIfStillIdle = Effect.fn("ProviderSessionManager.releaseIfStillIdle")(
        function* (input: {
          readonly providerSessionId: ProviderSessionId;
          readonly generation: number;
        }): Effect.fn.Return<void> {
          const current = yield* Ref.get(sessions);
          const key = sessionKey(input.providerSessionId);
          const entry = current.get(key);
          if (
            entry === undefined ||
            entry.busyTurns.size > 0 ||
            entry.idleGeneration !== input.generation
          ) {
            return;
          }
          // Capture runtime identity before yielding; replacements can reuse the session id.
          const probedRuntime = entry.runtime;
          const hasPendingWork =
            probedRuntime.hasPendingBackgroundWork === undefined
              ? false
              : yield* probedRuntime.hasPendingBackgroundWork.pipe(
                  Effect.catchCause(() => Effect.succeed(false)),
                );
          if (hasPendingWork) {
            const now = yield* Clock.currentTimeMillis;
            const pinnedSinceMs = entry.pinnedSinceMs ?? now;
            if (now - pinnedSinceMs < maxIdlePinMs) {
              const shouldContinuePin = yield* Ref.modify(sessions, (latest) => {
                const latestEntry = latest.get(key);
                if (
                  latestEntry === undefined ||
                  latestEntry.busyTurns.size > 0 ||
                  latestEntry.idleGeneration !== input.generation ||
                  latestEntry.runtime !== probedRuntime
                ) {
                  return [false, latest] as const;
                }
                const updated = new Map(latest);
                updated.set(key, { ...latestEntry, pinnedSinceMs });
                return [true, updated] as const;
              });
              if (!shouldContinuePin) {
                return;
              }
              yield* Effect.logInfo("orchestration-v2.driver-session.idle-release-deferred", {
                providerSessionId: input.providerSessionId,
                pinnedForMs: now - pinnedSinceMs,
              });
              // Recheck on this fiber; scheduleIdleReleaseInternal would interrupt it and self-deadlock.
              yield* Effect.sleep(Duration.millis(idleTimeoutMs));
              return yield* releaseIfStillIdle(input);
            }
            yield* Effect.logWarning("orchestration-v2.driver-session.idle-release-pin-expired", {
              providerSessionId: input.providerSessionId,
              pinnedForMs: now - pinnedSinceMs,
            });
          }
          // Adapter probes yield; guard busyTurns and idleGeneration atomically when removing the entry.
          yield* releaseEntry({
            providerSessionId: input.providerSessionId,
            reason: "idle_timeout",
            cancelIdleFiber: false,
            onlyIfIdleGeneration: input.generation,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.driver-session.idle-release-failed", {
                providerSessionId: input.providerSessionId,
                cause,
              }),
            ),
          );
        },
      );

      const withActivityError = <A, E, R>(
        providerSessionId: ProviderSessionId,
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, ProviderSessionActivityError, R> =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.fail(
              new ProviderSessionActivityError({
                providerSessionId,
                cause,
              }),
            ),
          ),
        );

      // Provider activity restarts the pin budget, so background work that keeps
      // reporting progress (a long Claude workflow) is never cut off; only work
      // that went silent for maxIdlePinMs is released. This runs for every
      // provider event, so keep it untraced.
      const scheduleIdleReleaseInternal = Effect.fnUntraced(function* (
        providerSessionId: ProviderSessionId,
        options?: { readonly providerActivity?: boolean },
      ) {
        const key = sessionKey(providerSessionId);
        const current = yield* Ref.get(sessions);
        const entry = current.get(key);
        if (entry === undefined || entry.busyTurns.size > 0) {
          return;
        }

        yield* cancelIdleFiber(entry.idleFiber);
        const generation = entry.idleGeneration + 1;
        const idleFiber = yield* Effect.sleep(Duration.millis(idleTimeoutMs)).pipe(
          Effect.andThen(releaseIfStillIdle({ providerSessionId, generation })),
          Effect.forkIn(layerScope),
        );
        const lastActivityAtMs = yield* Clock.currentTimeMillis;
        yield* Ref.update(sessions, (latest) => {
          const latestEntry = latest.get(key);
          if (latestEntry === undefined || latestEntry.busyTurns.size > 0) {
            return latest;
          }
          const updated = new Map(latest);
          updated.set(key, {
            ...latestEntry,
            idleGeneration: generation,
            idleFiber,
            lastActivityAtMs,
            ...(options?.providerActivity === true ? { pinnedSinceMs: null } : {}),
          });
          return updated;
        });
      });

      const scheduleIdleRelease = (providerSessionId: ProviderSessionId) =>
        withActivityError(providerSessionId, scheduleIdleReleaseInternal(providerSessionId));

      const touchActivity = (
        providerSessionId: ProviderSessionId,
        options?: { readonly providerActivity?: boolean },
      ) =>
        withActivityError(
          providerSessionId,
          Effect.gen(function* () {
            const lastActivityAtMs = yield* Clock.currentTimeMillis;
            yield* Ref.update(sessions, (current) => {
              const entry = current.get(sessionKey(providerSessionId));
              if (entry === undefined) {
                return current;
              }
              const updated = new Map(current);
              updated.set(sessionKey(providerSessionId), {
                ...entry,
                lastActivityAtMs,
              });
              return updated;
            });
            yield* scheduleIdleReleaseInternal(providerSessionId, options);
          }),
        );

      const attachThread = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
      }) =>
        withActivityError(
          input.providerSessionId,
          Ref.modify(sessions, (current) => {
            const entry = current.get(sessionKey(input.providerSessionId));
            if (entry === undefined || entry.attachedThreadIds.has(input.threadId)) {
              return [undefined, current] as const;
            }
            const updated = new Map(current);
            updated.set(sessionKey(input.providerSessionId), {
              ...entry,
              attachedThreadIds: new Set([...entry.attachedThreadIds, input.threadId]),
            });
            return [entry.runtime, updated] as const;
          }),
        );

      const removeThreadAttachment = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
        readonly runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }) =>
        Ref.update(sessions, (current) => {
          const key = sessionKey(input.providerSessionId);
          const entry = current.get(key);
          if (
            entry === undefined ||
            entry.runtime !== input.runtime ||
            !entry.attachedThreadIds.has(input.threadId)
          ) {
            return current;
          }
          const attachedThreadIds = new Set(entry.attachedThreadIds);
          attachedThreadIds.delete(input.threadId);
          const loadedProviderThreadKeyByThread = new Map(entry.loadedProviderThreadKeyByThread);
          loadedProviderThreadKeyByThread.delete(input.threadId);
          const updated = new Map(current);
          updated.set(key, {
            ...entry,
            attachedThreadIds,
            loadedProviderThreadKeyByThread,
          });
          return updated;
        });

      const isProviderThreadLoaded = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
        readonly providerThreadKey: string;
      }) =>
        Ref.get(sessions).pipe(
          Effect.map(
            (current) =>
              current
                .get(sessionKey(input.providerSessionId))
                ?.loadedProviderThreadKeyByThread.get(input.threadId) === input.providerThreadKey,
          ),
        );

      const markProviderThreadLoaded = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
        readonly providerThreadKey: string;
      }) =>
        Ref.update(sessions, (current) => {
          const key = sessionKey(input.providerSessionId);
          const entry = current.get(key);
          if (entry === undefined) {
            return current;
          }
          const loadedProviderThreadKeyByThread = new Map(entry.loadedProviderThreadKeyByThread);
          loadedProviderThreadKeyByThread.set(input.threadId, input.providerThreadKey);
          const updated = new Map(current);
          updated.set(key, { ...entry, loadedProviderThreadKeyByThread });
          return updated;
        });

      const ensureThreadAttached = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
        readonly providerInstanceId: ProviderInstanceId;
      }) =>
        Effect.suspend(() => {
          let attachedTo: ProviderAdapter.ProviderAdapterV2SessionRuntime | undefined;
          let preparedForCleanup: PreparedMcpCredential | undefined;
          let reservationDropped = false;
          const dropReservation = () => {
            if (!reservationDropped && preparedForCleanup?.mcpCredentialId !== undefined) {
              reservationDropped = true;
              dropMcpCredentialReservation(input.threadId, preparedForCleanup.mcpCredentialId);
            }
          };
          // Lock attach through rollback so concurrent attaches cannot observe an attachment about to be undone.
          const attach = Effect.gen(function* () {
            const attached = yield* attachThread(input).pipe(
              // Record without interruption so cleanup undoes only this call's attachment.
              Effect.tap((runtime) => Effect.sync(() => (attachedTo = runtime))),
              Effect.uninterruptible,
            );
            if (attached !== undefined) {
              const prepared = yield* prepareMcpSession(
                { threadId: input.threadId, providerInstanceId: input.providerInstanceId },
                true,
              );
              preparedForCleanup = prepared;
              if (prepared.mcpCredentialId !== undefined) {
                const mcpCredentialId = prepared.mcpCredentialId;
                yield* Ref.update(sessions, (current) => {
                  const key = sessionKey(input.providerSessionId);
                  const entry = current.get(key);
                  if (entry === undefined) return current;
                  const mcpCredentialIdByThread = new Map(entry.mcpCredentialIdByThread);
                  mcpCredentialIdByThread.set(input.threadId, mcpCredentialId);
                  const updated = new Map(current);
                  updated.set(key, { ...entry, mcpCredentialIdByThread });
                  return updated;
                });
              }
              const entry = (yield* Ref.get(sessions)).get(sessionKey(input.providerSessionId));
              if (entry !== undefined) {
                yield* withActivityError(
                  input.providerSessionId,
                  writeProviderSessionEvents({
                    runtime: entry.runtime,
                    threadIds: [input.threadId],
                    type: "provider-session.attached",
                    payload: entry.runtime.providerSession,
                  }),
                );
              }
            }
          }).pipe(
            Effect.onError(() =>
              attachedTo === undefined
                ? Effect.void
                : removeThreadAttachment({ ...input, runtime: attachedTo }).pipe(
                    Effect.andThen(
                      Effect.suspend(() => {
                        dropReservation();
                        // Other live processes hold reused MCP credentials; revocation would break their clients.
                        if (preparedForCleanup?.issued !== true) return Effect.void;
                        const mcpCredentialId = preparedForCleanup.mcpCredentialId;
                        const attachedRuntime = attachedTo;
                        return Ref.get(sessions).pipe(
                          Effect.flatMap((current) =>
                            (mcpCredentialId !== undefined &&
                              isMcpCredentialReserved(input.threadId, mcpCredentialId)) ||
                            Array.from(current.values()).some(
                              (other) =>
                                other.runtime !== attachedRuntime &&
                                (other.attachedThreadIds.has(input.threadId) ||
                                  (mcpCredentialId !== undefined &&
                                    other.mcpCredentialIdByThread.get(input.threadId) ===
                                      mcpCredentialId)),
                            )
                              ? Effect.void
                              : clearMcpSession(input.threadId, mcpCredentialId),
                          ),
                        );
                      }),
                    ),
                  ),
            ),
          );
          return threadAttachment
            .withLock(threadAttachmentKey(input), attach)
            .pipe(Effect.ensuring(Effect.sync(dropReservation)));
        });

      const markBusy = (
        providerSessionId: ProviderSessionId,
        turnKey: string,
        threadId: ThreadId,
      ) =>
        withActivityError(
          providerSessionId,
          Effect.gen(function* () {
            const key = sessionKey(providerSessionId);
            const now = yield* Clock.currentTimeMillis;
            const idleFiber = yield* Ref.modify(sessions, (current) => {
              const entry = current.get(key);
              if (entry === undefined) {
                return [null, current] as const;
              }
              const updated = new Map(current);
              updated.set(key, {
                ...entry,
                busyTurns: new Set(entry.busyTurns).add(turnKey),
                busyTurnByThread: new Map(entry.busyTurnByThread).set(threadId, turnKey),
                idleFiber: null,
                lastActivityAtMs: now,
                pinnedSinceMs: null,
              });
              return [entry.idleFiber, updated] as const;
            });
            yield* cancelIdleFiber(idleFiber);
          }),
        );

      const markIdle = (
        providerSessionId: ProviderSessionId,
        providerThreadId: ProviderThreadId,
        runOrdinal: number,
      ) =>
        withActivityError(
          providerSessionId,
          Effect.gen(function* () {
            const key = sessionKey(providerSessionId);
            const now = yield* Clock.currentTimeMillis;
            yield* Ref.update(sessions, (current) => {
              const entry = current.get(key);
              if (entry === undefined) {
                return current;
              }
              const busyTurns = new Set(entry.busyTurns);
              busyTurns.delete(busyTurnKey(providerThreadId, runOrdinal));
              const updated = new Map(current);
              updated.set(key, {
                ...entry,
                busyTurns,
                busyTurnByThread: new Map(
                  Array.from(entry.busyTurnByThread).filter(
                    ([, key]) => key !== busyTurnKey(providerThreadId, runOrdinal),
                  ),
                ),
                lastActivityAtMs: now,
              });
              return updated;
            });
            yield* scheduleIdleReleaseInternal(providerSessionId);
            yield* scheduleThreadUnload(providerSessionId, providerThreadId);
          }),
        );

      const hasBusyTurn = (entry: LiveSessionEntry, providerThreadId: ProviderThreadId) => {
        const prefix = busyTurnPrefix(providerThreadId);
        for (const turnKey of entry.busyTurns) {
          if (turnKey.startsWith(prefix)) return true;
        }
        return false;
      };

      const updateIdleThreadUnload = (
        providerSessionId: ProviderSessionId,
        threadId: ThreadId,
        update: (current: IdleThreadUnload | undefined) => IdleThreadUnload | undefined,
      ) =>
        Ref.modify(sessions, (current) => {
          const key = sessionKey(providerSessionId);
          const entry = current.get(key);
          if (entry === undefined) return [undefined, current] as const;
          const previous = entry.idleThreadUnloads.get(threadId);
          const next = update(previous);
          const idleThreadUnloads = new Map(entry.idleThreadUnloads);
          if (next === undefined) idleThreadUnloads.delete(threadId);
          else idleThreadUnloads.set(threadId, next);
          const updated = new Map(current);
          updated.set(key, { ...entry, idleThreadUnloads });
          return [previous, updated] as const;
        });

      /**
       * Called before the thread is resumed or given a turn, so an unload
       * cannot land between a resume that found the thread loaded and the turn
       * that relies on it.
       */
      const holdThreadLoaded = Effect.fn("ProviderSessionManager.holdThreadLoaded")(
        function* (input: {
          readonly providerSessionId: ProviderSessionId;
          readonly threadId: ThreadId;
          readonly providerThread: OrchestrationV2ProviderThread;
        }) {
          const entry = (yield* Ref.get(sessions)).get(sessionKey(input.providerSessionId));
          if (
            entry === undefined ||
            !entry.supportsMultipleProviderThreads ||
            entry.exposedRuntime.unloadThread === undefined ||
            input.providerThread.nativeThreadRef === null
          ) {
            return;
          }
          const previous = yield* updateIdleThreadUnload(
            input.providerSessionId,
            input.threadId,
            (current) => ({
              providerThread: input.providerThread,
              generation: (current?.generation ?? 0) + 1,
              fiber: null,
            }),
          );
          yield* cancelIdleFiber(previous?.fiber ?? null);
        },
      );

      const scheduleThreadUnload = Effect.fn("ProviderSessionManager.scheduleThreadUnload")(
        function* (providerSessionId: ProviderSessionId, providerThreadId: ProviderThreadId) {
          const entry = (yield* Ref.get(sessions)).get(sessionKey(providerSessionId));
          if (entry === undefined || hasBusyTurn(entry, providerThreadId)) return;
          const tracked = Array.from(entry.idleThreadUnloads).find(
            ([, pending]) => pending.providerThread.id === providerThreadId,
          );
          if (tracked === undefined) return;
          const [threadId, pending] = tracked;
          const generation = pending.generation + 1;
          const fiber = yield* Effect.sleep(Duration.millis(idleTimeoutMs)).pipe(
            Effect.andThen(unloadIdleThread({ providerSessionId, threadId, generation })),
            Effect.forkIn(layerScope),
          );
          const previous = yield* updateIdleThreadUnload(providerSessionId, threadId, (current) =>
            current?.generation === pending.generation
              ? { ...current, generation, fiber }
              : current,
          );
          yield* cancelIdleFiber(
            previous?.generation === pending.generation ? previous.fiber : fiber,
          );
        },
      );

      const unloadIdleThread = Effect.fn("ProviderSessionManager.unloadIdleThread")(
        function* (input: {
          readonly providerSessionId: ProviderSessionId;
          readonly threadId: ThreadId;
          readonly generation: number;
        }): Effect.fn.Return<void> {
          const outcome = yield* threadAttachment.withLock(
            threadAttachmentKey(input),
            Effect.gen(function* () {
              const key = sessionKey(input.providerSessionId);
              const entry = (yield* Ref.get(sessions)).get(key);
              const pending = entry?.idleThreadUnloads.get(input.threadId);
              const unloadThread = entry?.exposedRuntime.unloadThread;
              if (
                entry === undefined ||
                pending === undefined ||
                pending.generation !== input.generation ||
                unloadThread === undefined ||
                !entry.attachedThreadIds.has(input.threadId) ||
                hasBusyTurn(entry, pending.providerThread.id)
              ) {
                return "skipped" as const;
              }
              // Unloading kills background terminals; keep threads with pending work loaded.
              const hasPendingWork =
                entry.runtime.hasPendingBackgroundWorkForThread === undefined
                  ? false
                  : yield* entry.runtime
                      .hasPendingBackgroundWorkForThread(pending.providerThread)
                      .pipe(Effect.catchCause(() => Effect.succeed(false)));
              if (hasPendingWork) return "deferred" as const;
              const unloading = yield* Ref.modify(sessions, (current) => {
                const latest = current.get(key);
                if (
                  latest?.runtime !== entry.runtime ||
                  latest.idleThreadUnloads.get(input.threadId)?.generation !== input.generation
                ) {
                  return [false, current] as const;
                }
                const loadedProviderThreadKeyByThread = new Map(
                  latest.loadedProviderThreadKeyByThread,
                );
                loadedProviderThreadKeyByThread.delete(input.threadId);
                const idleThreadUnloads = new Map(latest.idleThreadUnloads);
                idleThreadUnloads.delete(input.threadId);
                const updated = new Map(current);
                updated.set(key, {
                  ...latest,
                  loadedProviderThreadKeyByThread,
                  idleThreadUnloads,
                });
                return [true, updated] as const;
              });
              if (!unloading) return "skipped" as const;
              yield* unloadThread({ providerThread: pending.providerThread }).pipe(
                Effect.timeout(UNLOAD_THREAD_TIMEOUT_MS),
                Effect.catchCause((cause) =>
                  Effect.logWarning("orchestration-v2.driver-session.idle-unload-failed", {
                    providerSessionId: input.providerSessionId,
                    threadId: input.threadId,
                    providerThreadId: pending.providerThread.id,
                    cause,
                  }),
                ),
              );
              return "unloaded" as const;
            }),
          );
          // Wait outside the lock so the next attach is not blocked.
          if (outcome === "deferred") {
            yield* Effect.sleep(Duration.millis(idleTimeoutMs));
            return yield* unloadIdleThread(input);
          }
        },
      );

      const observeActivity = (
        providerSessionId: ProviderSessionId,
        activity: Effect.Effect<void, ProviderSessionActivityError>,
      ) =>
        activity.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.driver-session.activity-failed", {
              providerSessionId,
              cause,
            }),
          ),
        );

      const makeEventSubscription = Effect.fn("ProviderSessionManager.makeEventSubscription")(
        function* (
          subscribers: Ref.Ref<
            ReadonlyMap<number, Queue.Queue<ProviderSessionEventSignal, Cause.Done>>
          >,
        ): Effect.fn.Return<ProviderAdapter.ProviderAdapterV2EventSubscription> {
          const queue = yield* Queue.unbounded<ProviderSessionEventSignal, Cause.Done>();
          const subscriberId = yield* Ref.getAndUpdate(nextSubscriberId, (value) => value + 1);
          yield* Ref.update(subscribers, (current) => {
            const updated = new Map(current);
            updated.set(subscriberId, queue);
            return updated;
          });
          const close = Ref.modify(subscribers, (current) => {
            if (!current.has(subscriberId)) {
              return [false, current] as const;
            }
            const updated = new Map(current);
            updated.delete(subscriberId);
            return [true, updated] as const;
          }).pipe(
            Effect.flatMap((removed) =>
              removed
                ? Queue.clear(queue).pipe(Effect.andThen(Queue.end(queue)), Effect.asVoid)
                : Effect.void,
            ),
          );
          const events = Stream.fromQueue(queue).pipe(
            Stream.mapEffect((signal) =>
              signal.type === "event"
                ? Effect.succeed(signal.event)
                : Effect.failCause(signal.cause),
            ),
            Stream.ensuring(close),
          );
          return { events, close } satisfies ProviderAdapter.ProviderAdapterV2EventSubscription;
        },
      );

      const decorateRuntime = (
        runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
        eventSubscribers: Ref.Ref<
          ReadonlyMap<number, Queue.Queue<ProviderSessionEventSignal, Cause.Done>>
        >,
      ): ProviderAdapter.ProviderAdapterV2SessionRuntime => {
        const providerSessionId = runtime.providerSessionId;
        const subscribeEvents = makeEventSubscription(eventSubscribers);
        const turnMetrics = (operation: string, model?: string) =>
          withMetrics({
            counter: providerTurnsTotal,
            ...(operation === "send" ? { timer: providerTurnDuration } : {}),
            attributes: {
              provider: runtime.driver,
              operation,
              modelFamily: normalizeModelMetricLabel(model),
            },
          });
        const trackTurn = (
          input: Pick<
            ProviderAdapter.ProviderAdapterV2TurnInput,
            "threadId" | "providerThread" | "runOrdinal"
          >,
          operation: Effect.Effect<void, ProviderAdapter.ProviderAdapterV2Error>,
        ) =>
          observeActivity(
            providerSessionId,
            ensureThreadAttached({
              providerSessionId,
              threadId: input.threadId,
              providerInstanceId: runtime.instanceId,
            }),
          ).pipe(
            // A start that fails or is stopped may never emit turn.terminal,
            // so it clears its own turn or the session never goes idle. If
            // the adapter emits the terminal anyway, clearing the same turn
            // again changes nothing, so another thread's turn on a shared
            // session stays busy either way.
            Effect.andThen(
              holdThreadLoaded({
                providerSessionId,
                threadId: input.threadId,
                providerThread: input.providerThread,
              }),
            ),
            Effect.andThen(
              Effect.acquireUseRelease(
                observeActivity(
                  providerSessionId,
                  markBusy(
                    providerSessionId,
                    busyTurnKey(input.providerThread.id, input.runOrdinal),
                    input.threadId,
                  ),
                ),
                () => operation,
                (_, exit) =>
                  Exit.isFailure(exit)
                    ? observeActivity(
                        providerSessionId,
                        markIdle(providerSessionId, input.providerThread.id, input.runOrdinal),
                      )
                    : Effect.void,
              ),
            ),
          );
        return {
          ...runtime,
          subscribeEvents,
          events: Stream.unwrap(
            subscribeEvents.pipe(Effect.map((subscription) => subscription.events)),
          ),
          ensureThread: (input) =>
            observeActivity(
              providerSessionId,
              ensureThreadAttached({
                providerSessionId,
                threadId: input.threadId,
                providerInstanceId: runtime.instanceId,
              }),
            ).pipe(
              Effect.andThen(runtime.ensureThread(input)),
              Effect.tap((providerThread) =>
                markProviderThreadLoaded({
                  providerSessionId,
                  threadId: input.threadId,
                  providerThreadKey: providerThreadLoadKey({
                    providerThread,
                    modelSelection: input.modelSelection,
                    runtimePolicy: input.runtimePolicy,
                  }),
                }),
              ),
            ),
          resumeThread: (input) => {
            const threadId = input.threadId ?? input.providerThread.appThreadId;
            if (threadId === null || threadId === undefined) {
              return runtime.resumeThread(input);
            }
            const providerThreadKey = providerThreadLoadKey({
              providerThread: input.providerThread,
              ...(input.modelSelection === undefined
                ? {}
                : { modelSelection: input.modelSelection }),
              ...(input.runtimePolicy === undefined ? {} : { runtimePolicy: input.runtimePolicy }),
            });
            return observeActivity(
              providerSessionId,
              ensureThreadAttached({
                providerSessionId,
                threadId,
                providerInstanceId: runtime.instanceId,
              }),
            ).pipe(
              Effect.andThen(
                holdThreadLoaded({
                  providerSessionId,
                  threadId,
                  providerThread: input.providerThread,
                }),
              ),
              Effect.andThen(
                isProviderThreadLoaded({ providerSessionId, threadId, providerThreadKey }),
              ),
              Effect.flatMap((loaded) =>
                loaded ? Effect.succeed(input.providerThread) : runtime.resumeThread(input),
              ),
              Effect.tap((providerThread) =>
                markProviderThreadLoaded({
                  providerSessionId,
                  threadId,
                  providerThreadKey: providerThreadLoadKey({
                    providerThread,
                    ...(input.modelSelection === undefined
                      ? {}
                      : { modelSelection: input.modelSelection }),
                    ...(input.runtimePolicy === undefined
                      ? {}
                      : { runtimePolicy: input.runtimePolicy }),
                  }),
                }),
              ),
            );
          },
          forkThread: (input) =>
            observeActivity(
              providerSessionId,
              ensureThreadAttached({
                providerSessionId,
                threadId: input.targetThreadId,
                providerInstanceId: runtime.instanceId,
              }),
            ).pipe(
              Effect.andThen(runtime.forkThread(input)),
              Effect.tap((providerThread) =>
                markProviderThreadLoaded({
                  providerSessionId,
                  threadId: input.targetThreadId,
                  providerThreadKey: providerThreadLoadKey({
                    providerThread,
                    ...(input.modelSelection === undefined
                      ? {}
                      : { modelSelection: input.modelSelection }),
                    ...(input.runtimePolicy === undefined
                      ? {}
                      : { runtimePolicy: input.runtimePolicy }),
                  }),
                }),
              ),
            ),
          startTurn: (input) =>
            trackTurn(
              input,
              runtime.startTurn(input).pipe(turnMetrics("send", input.modelSelection.model)),
            ),
          ...(runtime.resumeTurn === undefined
            ? {}
            : {
                resumeTurn: (input) => trackTurn(input, runtime.resumeTurn!(input)),
              }),
          steerTurn: (input) =>
            observeActivity(providerSessionId, touchActivity(providerSessionId)).pipe(
              Effect.andThen(runtime.steerTurn(input).pipe(turnMetrics("steer"))),
            ),
          interruptTurn: (input) =>
            observeActivity(providerSessionId, touchActivity(providerSessionId)).pipe(
              Effect.andThen(runtime.interruptTurn(input).pipe(turnMetrics("interrupt"))),
            ),
          respondToRuntimeRequest: (input) =>
            observeActivity(providerSessionId, touchActivity(providerSessionId)).pipe(
              Effect.andThen(
                runtime
                  .respondToRuntimeRequest(input)
                  .pipe(turnMetrics("runtime-request-response")),
              ),
            ),
        };
      };

      const persistProviderSessionUpdate = Effect.fn(
        "ProviderSessionManager.persistProviderSessionUpdate",
      )(
        function* (
          entry: LiveSessionEntry,
          event: Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { readonly type: "provider_session.updated" }
          >,
        ) {
          const current = (yield* Ref.get(sessions)).get(
            sessionKey(entry.runtime.providerSessionId),
          );
          if (current?.runtime !== entry.runtime) {
            return;
          }
          yield* writeProviderSessionEvents({
            runtime: entry.runtime,
            threadIds: current.attachedThreadIds,
            type: "provider-session.updated",
            payload: event.providerSession,
          });
        },
        (effect, entry, _event) =>
          effect.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.driver-session.status-persist-failed", {
                providerSessionId: entry.runtime.providerSessionId,
                cause,
              }),
            ),
          ),
      );

      const startEventPump = (entry: LiveSessionEntry) => {
        let stoppedByProvider = false;
        return entry.runtime.events.pipe(
          Stream.runForEach((event) => {
            if (shutdownSignal.received) return Effect.void;
            // Live output bypasses persistence and subscribers so floods cannot delay domain events.
            if (event.type === "command_output.delta") {
              return commandOutput.append(event);
            }
            const releaseLiveOutput =
              event.type === "turn_item.updated" &&
              event.turnItem.type === "command_execution" &&
              !isOrchestrationV2WorkActive(event.turnItem.status)
                ? commandOutput.finish({
                    threadId: event.turnItem.threadId,
                    itemId: event.turnItem.id,
                  })
                : Effect.void;
            if (
              event.type === "provider_session.updated" &&
              event.providerSession.status === "stopped"
            ) {
              stoppedByProvider = true;
            }
            return observeActivity(
              entry.runtime.providerSessionId,
              event.type === "turn.terminal"
                ? markIdle(
                    entry.runtime.providerSessionId,
                    event.providerThreadId,
                    event.runOrdinal,
                  )
                : touchActivity(entry.runtime.providerSessionId, { providerActivity: true }),
            ).pipe(
              Effect.andThen(
                event.type === "provider_session.updated"
                  ? persistProviderSessionUpdate(entry, event)
                  : Effect.void,
              ),
              Effect.andThen(
                Effect.gen(function* () {
                  if (
                    event.type === "provider_thread.updated" &&
                    event.providerThread.status === "error"
                  ) {
                    const threadId = event.providerThread.appThreadId;
                    yield* Ref.update(sessions, (sessions) => {
                      const key = sessionKey(entry.runtime.providerSessionId);
                      const latest = sessions.get(key);
                      if (latest?.runtime !== entry.runtime || threadId === null) return sessions;
                      const loadedProviderThreadKeyByThread = new Map(
                        latest.loadedProviderThreadKeyByThread,
                      );
                      loadedProviderThreadKeyByThread.delete(threadId);
                      return new Map(sessions).set(key, {
                        ...latest,
                        loadedProviderThreadKeyByThread,
                      });
                    });
                  }
                  // Some providers can block before a run subscriber exists
                  // (project trust, login, or session-switch hooks). Persist
                  // their runless request artifacts directly so the normal GOAT
                  // request UI can answer them and unblock session setup.
                  const threadId = sessionScopedRuntimeRequestThreadId(event);
                  if (threadId !== undefined) {
                    yield* Effect.gen(function* () {
                      const current = (yield* Ref.get(sessions)).get(
                        sessionKey(entry.runtime.providerSessionId),
                      );
                      if (current?.runtime !== entry.runtime) return;
                      yield* providerEventIngestor
                        .ingestNormalized({
                          providerSessionId: entry.runtime.providerSessionId,
                          providerInstanceId: entry.runtime.instanceId,
                          threadId,
                          event,
                        })
                        .pipe(
                          Effect.mapError(
                            (cause) =>
                              new ProviderAdapter.ProviderAdapterEventStreamError({
                                driver: entry.runtime.driver,
                                providerSessionId: entry.runtime.providerSessionId,
                                cause,
                              }),
                          ),
                        );
                    }).pipe(entry.requestEventPermit.withPermits(1));
                    return;
                  }
                  yield* publishToSubscribers(entry.eventSubscribers, { type: "event", event });
                  yield* releaseLiveOutput;
                }),
              ),
            );
          }),
          Effect.exit,
          Effect.flatMap((exit) =>
            Effect.gen(function* () {
              if (shutdownSignal.received) return;
              const current = (yield* Ref.get(sessions)).get(
                sessionKey(entry.runtime.providerSessionId),
              );
              if (current?.runtime !== entry.runtime) {
                return;
              }
              if (stoppedByProvider && Exit.isSuccess(exit)) {
                yield* releaseEntry({
                  providerSessionId: entry.runtime.providerSessionId,
                  reason: "manual_shutdown",
                  gracefulSubscribers: true,
                }).pipe(logReleaseFailure(entry.runtime.providerSessionId));
                return;
              }
              // Subscribers read an interrupt as server shutdown, so keep it for that.
              const cause =
                Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
                  ? exit.cause
                  : Cause.fail(
                      new ProviderAdapter.ProviderAdapterEventStreamError({
                        driver: entry.runtime.driver,
                        providerSessionId: entry.runtime.providerSessionId,
                        cause: "Provider event stream ended unexpectedly.",
                      }),
                    );
              yield* publishToSubscribers(entry.eventSubscribers, {
                type: "failure",
                cause,
              });
              yield* Ref.set(entry.eventSubscribers, new Map());
              yield* releaseEntry({
                providerSessionId: entry.runtime.providerSessionId,
                reason: "runtime_error",
                detail: Cause.pretty(cause),
              }).pipe(logReleaseFailure(entry.runtime.providerSessionId));
            }),
          ),
          Effect.forkIn(layerScope),
        );
      };

      // Shutdown must fit the launcher's 5 s deadline with up to 15 sessions.
      const sessionScopes = yield* Scope.make("parallel");
      const shutdown = Effect.gen(function* () {
        const activeSessions = [...(yield* Ref.get(sessions)).values()];
        yield* Effect.forEach(
          activeSessions,
          (entry) =>
            releaseEntry({
              providerSessionId: entry.runtime.providerSessionId,
              reason: "server_shutdown",
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("orchestration-v2.driver-session.shutdown-release-failed", {
                  providerSessionId: entry.runtime.providerSessionId,
                  cause,
                }),
              ),
            ),
          { concurrency: "unbounded", discard: true },
        );
        yield* awaitPendingReleases;
      });
      yield* Effect.addFinalizer(() =>
        shutdown.pipe(
          Effect.ensuring(closeScopeWithin(sessionScopes, { reason: "server_shutdown" })),
        ),
      );

      if (memoryRotations !== undefined) {
        yield* memoryRotations.pipe(
          Stream.runForEach(() =>
            Effect.forEach(
              Array.from(memoryPrepareInputs.keys()),
              (threadId) =>
                Effect.gen(function* () {
                  const input = memoryPrepareInputs.get(threadId);
                  if (!input || (yield* mcpSessions.read(threadId)) === undefined) return;
                  const prepared = yield* prepareMcpSession(input, "stored");
                  if (prepared.mcpCredentialId)
                    dropMcpCredentialReservation(threadId, prepared.mcpCredentialId);
                }),
              { discard: true },
            ),
          ),
          Effect.forkScoped,
        );
      }

      return ProviderSessionManagerV2.of({
        currentMemoryPolicy,
        memoryAccessInputs: (threadId, providerInstanceId) =>
          Effect.gen(function* () {
            const prepared = memoryPrepareInputs.get(threadId);
            // A valid current projection cannot retroactively admit a denied
            // prepare. Check its session identity before consulting execution policy.
            if (
              prepared?.providerInstanceId !== providerInstanceId ||
              !prepared.destinationUsable ||
              prepared.providerSessionId === undefined
            )
              return undefined;
            const entry = (yield* Ref.get(sessions)).get(sessionKey(prepared.providerSessionId));
            if (
              entry?.runtime.instanceId !== providerInstanceId ||
              !entry.attachedThreadIds.has(threadId)
            )
              return undefined;
            // Use execution's current authority, including registry expiry and
            // revocation, rather than reconstructing it from prepare metadata.
            const policy = yield* currentMemoryPolicy(threadId);
            if (policy.grant === "none" || memoryPrepareInputs.get(threadId) !== prepared)
              return undefined;
            return { ...prepared, currentMemoryGrant: policy.grant };
          }),
        mcpCredentialRotations: Option.isSome(admission)
          ? admission.value.rotations
          : Stream.fromPubSub(credentialRotations),
        prepareMcpSession: (input) =>
          Effect.gen(function* () {
            const prepared = yield* prepareMcpSession(input);
            pendingMemoryAdmissions.set(input.threadId, { ...input });
            if (prepared.mcpCredentialId)
              dropMcpCredentialReservation(input.threadId, prepared.mcpCredentialId);
          }),
        shutdown,
        open: (input) =>
          Effect.suspend(() => {
            // Consume before waiting for the open lock or doing any preflight I/O.
            // Failure/interrupt discards this call's admission; retries need prepare.
            const admission = pendingMemoryAdmissions.get(input.threadId);
            pendingMemoryAdmissions.delete(input.threadId);
            return sessionOpen.withLock(
              input.providerSessionId,
              Effect.gen(function* () {
                const cwd = input.runtimePolicy.cwd;
                if (cwd !== null) {
                  const workspaceIsDirectory = yield* fileSystem.stat(cwd).pipe(
                    Effect.map((stat) => stat.type === "Directory"),
                    Effect.catch((error) => Effect.succeed(error.reason._tag !== "NotFound")),
                  );
                  if (!workspaceIsDirectory) {
                    return yield* new ProviderWorkspaceMissingError({
                      threadId: input.threadId,
                      cwd,
                    });
                  }
                }
                const key = sessionKey(input.providerSessionId);
                const existing = (yield* Ref.get(sessions)).get(key);
                if (existing !== undefined) {
                  const attached = existing.attachedThreadIds.has(input.threadId);
                  if (!attached && !existing.supportsMultipleProviderThreads) {
                    return yield* new ProviderSessionOpenError({
                      instanceId: input.modelSelection.instanceId,
                      providerSessionId: input.providerSessionId,
                      cause: `Provider ${existing.runtime.driver} does not support attaching multiple app threads to one session.`,
                    });
                  }
                  // Joining a shared session is a new session for this thread.
                  if (!attached) yield* agentScope.clear(input.threadId);
                  const prepared = yield* prepareMcpSession(
                    openPrepareInput(input, existing.runtime.instanceId),
                    admission ?? false,
                  );
                  if (prepared.mcpCredentialId)
                    dropMcpCredentialReservation(input.threadId, prepared.mcpCredentialId);
                  yield* ensureThreadAttached({
                    providerSessionId: input.providerSessionId,
                    threadId: input.threadId,
                    providerInstanceId: existing.runtime.instanceId,
                  });
                  const preparedInput = memoryPrepareInputs.get(input.threadId);
                  if (preparedInput !== undefined)
                    memoryPrepareInputs.set(input.threadId, {
                      ...preparedInput,
                      providerSessionId: input.providerSessionId,
                    });
                  yield* touchActivity(input.providerSessionId);
                  return existing.exposedRuntime;
                }

                const sessionScope = yield* Scope.fork(sessionScopes);
                if (Option.isSome(codexRoutes))
                  yield* codexRoutes.value.reserveUse(input.modelSelection.instanceId).pipe(
                    Effect.provideService(Scope.Scope, sessionScope),
                    Effect.onError(() => Scope.close(sessionScope, Exit.void)),
                    Effect.mapError(
                      (cause) =>
                        new ProviderSessionOpenError({
                          instanceId: input.modelSelection.instanceId,
                          providerSessionId: input.providerSessionId,
                          cause,
                        }),
                    ),
                  );
                return yield* Effect.gen(function* () {
                  const adapter = yield* registry.get(input.modelSelection.instanceId).pipe(
                    Effect.onError(() => Scope.close(sessionScope, Exit.void)),
                    Effect.mapError(
                      (cause) =>
                        new ProviderSessionOpenError({
                          instanceId: input.modelSelection.instanceId,
                          providerSessionId: input.providerSessionId,
                          cause,
                        }),
                    ),
                  );
                  const prepared = yield* prepareMcpSession(
                    openPrepareInput(input, input.modelSelection.instanceId),
                    admission ?? false,
                  );
                  const mcpCredentialId = prepared.mcpCredentialId;
                  // The reservation from prepare protects the credential (which
                  // eager adapters bake into the provider process during
                  // openSession) from racing releases until this session's entry
                  // is recorded below. Dropped exactly once on every path.
                  let reservationDropped = mcpCredentialId === undefined;
                  const dropReservation = Effect.sync(() => {
                    if (!reservationDropped && mcpCredentialId !== undefined) {
                      reservationDropped = true;
                      dropMcpCredentialReservation(input.threadId, mcpCredentialId);
                    }
                  });
                  // The previous session's agent scope must not explain this
                  // session's failures, even when this provider runs without one.
                  yield* agentScope.clear(input.threadId);
                  const runtime = yield* adapter
                    .openSession({
                      threadId: input.threadId,
                      providerSessionId: input.providerSessionId,
                      modelSelection: input.modelSelection,
                      runtimePolicy: input.runtimePolicy,
                      ...(input.resumeFromSession === undefined
                        ? {}
                        : { resumeFromSession: input.resumeFromSession }),
                      ...(input.initialNativeThreadId === undefined
                        ? {}
                        : { initialNativeThreadId: input.initialNativeThreadId }),
                      ...(input.initialProviderItemIdentityVersion === undefined
                        ? {}
                        : {
                            initialProviderItemIdentityVersion:
                              input.initialProviderItemIdentityVersion,
                          }),
                    })
                    .pipe(
                      Effect.provideService(Scope.Scope, sessionScope),
                      // Any failure, including a Stop that interrupts a slow
                      // handshake, stops the provider process this open started.
                      // The session cleanup runs first, and the close is
                      // time-boxed: this runs under the session's open lock, so an
                      // adapter finalizer that never finishes must not hold the
                      // interrupter, the lock, or later opens.
                      Effect.onError(() =>
                        dropReservation.pipe(
                          // Clear only a session this open freshly set up: a reused
                          // one is held by another live provider process and must
                          // survive this open's failure.
                          Effect.andThen(
                            prepared.issued
                              ? clearMcpSession(input.threadId, mcpCredentialId, admission ?? null)
                              : Effect.void,
                          ),
                        ),
                      ),
                      Effect.mapError(
                        (cause) =>
                          new ProviderSessionOpenError({
                            instanceId: input.modelSelection.instanceId,
                            providerSessionId: input.providerSessionId,
                            cause,
                          }),
                      ),
                      withMetrics({
                        counter: providerSessionsTotal,
                        attributes: { provider: adapter.driver, operation: "open" },
                      }),
                    );
                  const eventSubscribers = yield* Ref.make<
                    ReadonlyMap<number, Queue.Queue<ProviderSessionEventSignal, Cause.Done>>
                  >(new Map());
                  const exposedRuntime = decorateRuntime(runtime, eventSubscribers);
                  const now = yield* Clock.currentTimeMillis;
                  const entry: LiveSessionEntry = {
                    attachedThreadIds: new Set([input.threadId]),
                    loadedProviderThreadKeyByThread: new Map(),
                    mcpCredentialIdByThread:
                      mcpCredentialId === undefined
                        ? new Map()
                        : new Map([[input.threadId, mcpCredentialId]]),
                    supportsMultipleProviderThreads:
                      runtime.providerSession.capabilities.sessions
                        .supportsMultipleProviderThreadsPerSession,
                    runtime,
                    exposedRuntime,
                    eventSubscribers,
                    requestEventPermit: yield* Semaphore.make(1),
                    scope: sessionScope,
                    idleGeneration: 0,
                    busyTurns: new Set(),
                    busyTurnByThread: new Map(),
                    lastActivityAtMs: now,
                    idleFiber: null,
                    pinnedSinceMs: null,
                    idleThreadUnloads: new Map(),
                  };
                  yield* Ref.update(sessions, (current) => {
                    const updated = new Map(current);
                    updated.set(key, entry);
                    return updated;
                  });
                  const preparedInput = memoryPrepareInputs.get(input.threadId);
                  if (preparedInput !== undefined)
                    memoryPrepareInputs.set(input.threadId, {
                      ...preparedInput,
                      providerSessionId: input.providerSessionId,
                    });
                  // The entry now guards the credential via its recorded id, so
                  // the pre-open reservation can be dropped.
                  yield* dropReservation;
                  yield* withActivityError(
                    input.providerSessionId,
                    writeProviderSessionEvents({
                      runtime,
                      threadIds: [input.threadId],
                      type: "provider-session.attached",
                      payload: runtime.providerSession,
                    }),
                  ).pipe(
                    // Released on interrupt too: this entry has no event pump or
                    // idle timer yet, so nothing else would ever release it.
                    Effect.onError((cause) =>
                      releaseEntry(
                        Cause.hasInterruptsOnly(cause)
                          ? {
                              providerSessionId: input.providerSessionId,
                              reason: "manual_shutdown",
                              detail: "The provider session start was interrupted.",
                            }
                          : {
                              providerSessionId: input.providerSessionId,
                              reason: "runtime_error",
                              detail: "Failed to persist the provider-session attachment.",
                            },
                      ).pipe(logReleaseFailure(input.providerSessionId)),
                    ),
                  );
                  yield* startEventPump(entry);
                  yield* scheduleIdleRelease(input.providerSessionId);
                  return exposedRuntime;
                }).pipe(
                  Effect.onError(() =>
                    closeScopeWithin(sessionScope, {
                      providerSessionId: input.providerSessionId,
                      reason: "open_failed",
                    }),
                  ),
                );
              }),
            );
          }),
        isLive: (providerSessionId) =>
          Ref.get(sessions).pipe(
            Effect.map((current) => current.has(sessionKey(providerSessionId))),
          ),
        get: Effect.fn("ProviderSessionManager.get")(
          function* (providerSessionId) {
            const entry = (yield* Ref.get(sessions)).get(sessionKey(providerSessionId));
            if (entry === undefined) {
              return Option.none<ProviderAdapter.ProviderAdapterV2SessionRuntime>();
            }
            yield* touchActivity(providerSessionId);
            return Option.some(entry.exposedRuntime);
          },
          (effect, providerSessionId) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderSessionLookupError({
                    providerSessionId,
                    cause,
                  }),
              ),
            ),
        ),
        close: (providerSessionId) =>
          releaseEntry({ providerSessionId, reason: "manual_shutdown" }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderSessionCloseError({
                  providerSessionId,
                  cause,
                }),
            ),
          ),
        closeInstance: Effect.fn("ProviderSessionManager.closeInstance")(
          function* (instanceId) {
            const active = [...(yield* Ref.get(sessions)).values()].filter(
              (entry) => entry.runtime.instanceId === instanceId,
            );
            const outcomes = yield* Effect.forEach(
              active,
              (entry) =>
                releaseEntry({
                  providerSessionId: entry.runtime.providerSessionId,
                  reason: "manual_shutdown",
                  detail: `Provider instance ${instanceId} logged out.`,
                }).pipe(Effect.exit),
              { concurrency: "unbounded" },
            );
            const failure = outcomes.find(Exit.isFailure);
            if (failure !== undefined && Exit.isFailure(failure)) {
              return yield* Effect.failCause(failure.cause);
            }
          },
          (effect, instanceId) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderSessionCloseError({
                    providerSessionId: ProviderSessionId.make(
                      `provider-session:provider-instance:${instanceId}`,
                    ),
                    cause,
                  }),
              ),
            ),
        ),
        release: releaseEntry,
        detach: Effect.fn("ProviderSessionManager.detach")(
          function* (input) {
            const key = sessionKey(input.providerSessionId);
            const currentEntry = (yield* Ref.get(sessions)).get(key);
            let detachedProviderThreads: ReadonlyArray<OrchestrationV2ProviderThread> = [];
            if (currentEntry?.supportsMultipleProviderThreads === true) {
              const projection = yield* Effect.option(
                projectionStore.getThreadRecords(input.threadId, [
                  "providerThreads",
                  "providerTurns",
                ]),
              );
              if (Option.isSome(projection)) {
                const providerThreads = new Map(
                  projection.value.providerThreads
                    .filter((thread) => thread.providerSessionId === input.providerSessionId)
                    .map((thread) => [thread.id, thread] as const),
                );
                detachedProviderThreads = [...providerThreads.values()];
                const activeTurns = projection.value.providerTurns.filter(
                  (turn) => turn.status === "running" && providerThreads.has(turn.providerThreadId),
                );
                yield* Effect.forEach(
                  activeTurns,
                  (turn) =>
                    currentEntry.exposedRuntime
                      .interruptTurn({
                        providerThread: providerThreads.get(turn.providerThreadId)!,
                        providerTurnId: turn.id,
                      })
                      .pipe(
                        Effect.catchCause((cause) =>
                          Effect.logWarning(
                            "orchestration-v2.driver-session.detach-interrupt-failed",
                            {
                              providerSessionId: input.providerSessionId,
                              threadId: input.threadId,
                              providerTurnId: turn.id,
                              cause,
                            },
                          ),
                        ),
                      ),
                  { concurrency: 1, discard: true },
                );
              }
            }
            const detachResult = yield* Ref.modify(sessions, (current) => {
              const entry = current.get(key);
              if (entry === undefined || !entry.attachedThreadIds.has(input.threadId)) {
                return [
                  Option.none<{
                    readonly entry: LiveSessionEntry;
                    readonly idleUnloadFiber: Fiber.Fiber<void, never> | null;
                  }>(),
                  current,
                ] as const;
              }
              const attachedThreadIds = new Set(entry.attachedThreadIds);
              attachedThreadIds.delete(input.threadId);
              const loadedProviderThreadKeyByThread = new Map(
                entry.loadedProviderThreadKeyByThread,
              );
              loadedProviderThreadKeyByThread.delete(input.threadId);
              const mcpCredentialIdByThread =
                input.revokeMcpCredential === true
                  ? (() => {
                      const pruned = new Map(entry.mcpCredentialIdByThread);
                      pruned.delete(input.threadId);
                      return pruned;
                    })()
                  : entry.mcpCredentialIdByThread;
              const idleThreadUnloads = new Map(entry.idleThreadUnloads);
              idleThreadUnloads.delete(input.threadId);
              const updatedEntry = {
                ...entry,
                attachedThreadIds,
                loadedProviderThreadKeyByThread,
                mcpCredentialIdByThread,
                idleThreadUnloads,
              };
              const updated = new Map(current);
              updated.set(key, updatedEntry);
              return [
                Option.some({
                  entry: updatedEntry,
                  idleUnloadFiber: entry.idleThreadUnloads.get(input.threadId)?.fiber ?? null,
                }),
                updated,
              ] as const;
            });
            if (Option.isSome(detachResult)) {
              yield* cancelIdleFiber(detachResult.value.idleUnloadFiber);
            }
            const detached = Option.map(detachResult, (result) => result.entry);
            // Plain detaches preserve credentials held by live shared providers across workspace handoffs.
            if (input.revokeMcpCredential === true) {
              yield* clearMcpSession(input.threadId);
            }
            if (Option.isNone(detached)) {
              return;
            }
            if (
              detached.value.attachedThreadIds.size === 0 &&
              !detached.value.supportsMultipleProviderThreads
            ) {
              yield* releaseEntry({
                providerSessionId: input.providerSessionId,
                reason: "manual_shutdown",
                ...(input.detail === undefined ? {} : { detail: input.detail }),
                detachedThreadId: input.threadId,
              });
              return;
            }
            const unloadThread = detached.value.exposedRuntime.unloadThread;
            if (detached.value.supportsMultipleProviderThreads && unloadThread !== undefined) {
              // Serialize unload with attachment so attached threads stay loaded and later attaches resume after unload.
              yield* threadAttachment.withLock(
                threadAttachmentKey(input),
                Effect.gen(function* () {
                  const entry = (yield* Ref.get(sessions)).get(key);
                  if (
                    entry?.runtime !== detached.value.runtime ||
                    entry.attachedThreadIds.has(input.threadId)
                  ) {
                    return;
                  }
                  yield* Effect.forEach(
                    detachedProviderThreads.filter((thread) => thread.nativeThreadRef !== null),
                    (providerThread) =>
                      unloadThread({ providerThread }).pipe(
                        Effect.timeout(UNLOAD_THREAD_TIMEOUT_MS),
                        Effect.catchCause((cause) =>
                          Effect.logWarning(
                            "orchestration-v2.driver-session.detach-unload-failed",
                            {
                              providerSessionId: input.providerSessionId,
                              threadId: input.threadId,
                              providerThreadId: providerThread.id,
                              cause,
                            },
                          ),
                        ),
                      ),
                    { concurrency: 1, discard: true },
                  );
                }),
              );
            }
            yield* scheduleIdleRelease(input.providerSessionId);
          },
          (effect, input) =>
            effect.pipe(
              Effect.catchCause((cause) =>
                Effect.fail(
                  new ProviderSessionReleaseError({
                    providerSessionId: input.providerSessionId,
                    reason: "manual_shutdown",
                    cause,
                  }),
                ),
              ),
            ),
        ),
      } satisfies ProviderSessionManagerV2Shape);
    }),
  );

export const layer = layerWithOptions();
