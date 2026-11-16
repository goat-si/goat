import type { MemorySnapshotPolicy } from "../memory/MemorySnapshot.ts";
import {
  ModelSelection,
  type AuthEnvironmentScope,
  type MemoryTaskGrantCeiling,
  type RunId,
  type ScreenBindingHints,
  type TurnCapability,
  type NodeId,
  OrchestrationV2ProviderSession,
  ProviderInstanceId,
  type ProviderInteractionMode,
  ProviderSessionId,
  ThreadId,
  type ProviderThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import type {
  ProviderSessionManagerV2Error,
  ProviderSessionReleaseReason,
} from "./ProviderSessionManagerErrors.ts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";

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
  readonly screenBindingHints?: ScreenBindingHints;
}

/** What opening a provider session for a turn admits; the same for a new or a shared session. */
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
    readonly screenBindingHints?: ScreenBindingHints;
    readonly resumeFromSession?: OrchestrationV2ProviderSession;
    readonly initialNativeThreadId?: string;
    readonly initialProviderItemIdentityVersion?: 2;
    /** Set for a new turn: a process that predates its model is restarted when idle, or refused. */
    readonly startsTurn?: boolean;
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
  /** Ends a turn start's catalog-restart reservation once that start attempt has exited. */
  readonly settleTurnStart: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) => Effect.Effect<void>;
  /**
   * Releases the session unless, at the moment of removal, a turn other than run `runOrdinal`'s
   * on `ownProviderThreadIds` is busy on it. Checked atomically with turn starts. Succeeds with
   * whether it was released.
   */
  readonly releaseUnlessBusy: (input: {
    readonly providerSessionId: ProviderSessionId;
    readonly ownProviderThreadIds: ReadonlyArray<ProviderThreadId>;
    readonly runOrdinal: number;
    readonly reason: ProviderSessionReleaseReason;
    readonly detail?: string;
  }) => Effect.Effect<boolean, ProviderSessionManagerV2Error>;
  /**
   * Other threads with a run or background work on this session's shared process; empty when
   * it serves one thread.
   */
  readonly otherWorkingThreads: (input: {
    readonly providerSessionId: ProviderSessionId;
    readonly threadId: ThreadId;
  }) => Effect.Effect<ReadonlyArray<ThreadId>>;
}
