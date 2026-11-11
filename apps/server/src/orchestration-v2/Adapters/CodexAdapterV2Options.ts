import type {
  CodexSettings,
  ProviderInstanceId,
  ProviderSetupError,
  ServerProviderCompatibilityAdvisory,
  ServerProviderModel,
  ThreadId,
} from "@goat/contracts";
import type * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import type * as ProviderContinuationRequests from "@goat/provider-core/server/ProviderContinuationRequests";
import type { ManagedServerProvider } from "@goat/provider-core/server/snapshot";
import type * as Crypto from "effect/Crypto";
import type * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

import type { ServerConfig } from "../../config.ts";
import type * as MemorySnapshot from "../../memory/MemorySnapshot.ts";
import type { CodexEffectiveRuntime } from "../../provider/CodexManagedRuntime.ts";
import type { CodexAppServerClientFactoryShape } from "./CodexAppServerClientFactory.ts";

export interface CodexAdapterV2Options {
  /** L5 binds committed snapshot authority, including snapshot-only sessions. */
  readonly currentMemoryPolicy?: (
    threadId: ThreadId,
  ) => Effect.Effect<MemorySnapshot.MemorySnapshotPolicy>;
  /** L5 supplies the manager's scoped credential publication stream. */
  readonly mcpCredentialRotations?: Stream.Stream<{
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
  }>;
  readonly instanceId: ProviderInstanceId;
  readonly settings: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly sessionConfigKey?: string;
  readonly clientFactory: CodexAppServerClientFactoryShape;
  readonly onUsageLimits?: ManagedServerProvider["applyUsageLimits"];
  readonly resolveRuntime?: Effect.Effect<CodexEffectiveRuntime, ProviderSetupError, Scope.Scope>;
  readonly compatibility?: (
    version: string,
  ) => Effect.Effect<ServerProviderCompatibilityAdvisory | undefined>;
  /** The models GOAT offers for this instance; sessions use it to spot models added after their process started. */
  readonly offeredModels?: Effect.Effect<ReadonlyArray<ServerProviderModel>>;
  readonly crypto: Crypto.Crypto;
  readonly fileSystem: FileSystem.FileSystem;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly serverConfig: ServerConfig["Service"];
  /** Omitting this leaves late completions projection-only. */
  readonly continuationRequests?: {
    readonly offer: (
      request: ProviderContinuationRequests.ProviderContinuationRequest,
    ) => Effect.Effect<void>;
  };
}

/** What a Codex driver adds to the adapter it builds. */
export type CodexAdapterV2Hooks = Pick<
  CodexAdapterV2Options,
  "onUsageLimits" | "resolveRuntime" | "compatibility" | "offeredModels"
>;
