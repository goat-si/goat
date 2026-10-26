import type { McpCredentialRotation } from "../orchestration-v2/ProviderSessionManager.ts";
import * as MemoryDerivedCache from "../memory/MemoryDerivedCache.ts";
import * as Layer from "effect/Layer";

import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CodexAdapterV2 from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CursorAgentSdk from "@goat/provider-cursor/server/CursorAgentSdk";
import * as CursorSdk from "@goat/provider-cursor/server/CursorSdk";
import * as CursorKeychain from "@goat/provider-cursor/server/CursorKeychain";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@goat/provider-core/server/ProviderContinuationRequests";

import type { ThreadId } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import type { MemorySnapshotPolicy } from "../memory/MemorySnapshot.ts";
import type { McpProviderSessionConfig } from "@goat/provider-core/server/mcpSession";

/** Breaks the adapter/manager construction cycle; authority remains manager-owned. */
export class ProviderMemoryAdmission extends Context.Service<
  ProviderMemoryAdmission,
  {
    readonly bind: (
      read: (threadId: ThreadId) => Effect.Effect<MemorySnapshotPolicy>,
      attached: (config: McpProviderSessionConfig) => Effect.Effect<boolean>,
    ) => Effect.Effect<void>;
    readonly currentPolicy: (threadId: ThreadId) => Effect.Effect<MemorySnapshotPolicy>;
    readonly fence: (
      config: McpProviderSessionConfig | undefined,
    ) => Effect.Effect<McpProviderSessionConfig | undefined>;
    readonly rotations: Stream.Stream<McpCredentialRotation>;
    readonly rotated: (event: McpCredentialRotation) => Effect.Effect<void>;
  }
>()("goat/provider/ProviderOrchestrationAdapterInfrastructure/ProviderMemoryAdmission") {}

export const layerMemoryAdmission = Layer.effect(
  ProviderMemoryAdmission,
  Effect.gen(function* () {
    const rotations = yield* PubSub.unbounded<McpCredentialRotation>();
    let read: (threadId: ThreadId) => Effect.Effect<MemorySnapshotPolicy> = () =>
      Effect.succeed({ grant: "none", policyEpoch: 0 });
    let attached: (config: McpProviderSessionConfig) => Effect.Effect<boolean> = () =>
      Effect.succeed(false);
    const currentPolicy = (threadId: ThreadId) => Effect.suspend(() => read(threadId));
    return ProviderMemoryAdmission.of({
      bind: (next, isAttached) =>
        Effect.sync(() => {
          read = next;
          attached = isAttached;
        }),
      currentPolicy,
      fence: (config) =>
        config === undefined
          ? Effect.succeed(undefined)
          : Effect.suspend(() => attached(config)).pipe(
              Effect.flatMap((valid) =>
                valid
                  ? currentPolicy(config.threadId).pipe(
                      Effect.flatMap((policy) =>
                        Effect.suspend(() => attached(config)).pipe(
                          Effect.map((stillAttached) =>
                            stillAttached
                              ? {
                                  ...config,
                                  grantedScopes: (config.grantedScopes ?? []).filter(
                                    (scope) =>
                                      (scope !== "memory:read" && scope !== "memory:write") ||
                                      (scope === "memory:read" && policy.grant !== "none") ||
                                      (scope === "memory:write" && policy.grant === "read_write"),
                                  ),
                                }
                              : undefined,
                          ),
                        ),
                      ),
                    )
                  : Effect.succeed(undefined),
              ),
            ),
      rotations: Stream.fromPubSub(rotations),
      rotated: (event) => PubSub.publish(rotations, event).pipe(Effect.asVoid),
    });
  }),
);

export type ProviderOrchestrationAdapterInfrastructure =
  | ClaudeAdapterV2.ClaudeAgentSdkQueryRunner
  | CodexAdapterV2.CodexAppServerClientFactory
  | CursorAgentSdk.CursorAgentSdkRunner
  | CursorSdk.CursorSdk
  | CursorKeychain.CursorKeychain
  | IdAllocator.IdAllocatorV2
  | MemoryDerivedCache.MemoryDerivedCache;

/** Reuse the continuation worker's exact layer reference so memoization shares one queue. */
export const layer = Layer.mergeAll(
  MemoryDerivedCache.layer,
  ClaudeAdapterV2.layerQueryRunner,
  CodexAdapterV2.layerAppServerClientFactory,
  CursorAgentSdk.layer.pipe(Layer.provideMerge(CursorSdk.layer)),
  CursorKeychain.layer,
  IdAllocator.layer,
  ProviderContinuationRequests.layer,
);
