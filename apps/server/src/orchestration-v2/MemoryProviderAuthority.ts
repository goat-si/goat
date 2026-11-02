import type { ThreadId, ProviderSessionId } from "@goat/contracts";
import type { McpProviderSessionConfig } from "@goat/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Projection from "./ProjectionStore.ts";
import type * as Registry from "../mcp/McpSessionRegistry.ts";
import type * as Settings from "../serverSettings.ts";
import type { MemorySnapshotPolicy } from "../memory/MemorySnapshot.ts";
import type { ProviderMemoryPrepareInput } from "./ProviderSessionManager.ts";

type Prepared = ProviderMemoryPrepareInput & {
  readonly destinationUsable: boolean;
  readonly providerSessionId?: ProviderSessionId | undefined;
};
// Reprepares may clone equivalent metadata without changing its authority.
const prepareAuthority = (prepared: Prepared) =>
  JSON.stringify({
    providerInstanceId: prepared.providerInstanceId,
    providerSessionId: prepared.providerSessionId,
    destinationUsable: prepared.destinationUsable,
    memoryGrantCeiling: prepared.memoryGrantCeiling,
    readOnly: prepared.readOnly,
    dispatchScopes: prepared.dispatchScopes,
  });

export const makeMemoryProviderAuthority = (input: {
  readonly policy: Option.Option<Settings.MemoryProviderCommittedPolicy["Service"]>;
  readonly readConfig: (threadId: ThreadId) => Effect.Effect<McpProviderSessionConfig | undefined>;
  readonly registry: Registry.McpSessionRegistry["Service"];
  readonly projection: Projection.ProjectionStoreV2["Service"];
  readonly prepared: (threadId: ThreadId) => Prepared | undefined;
  readonly attached: (
    config: McpProviderSessionConfig,
    prepared: Prepared,
  ) => Effect.Effect<boolean>;
}) => {
  const references = Effect.fn("MemoryProviderAuthority.references")(function* (
    config: McpProviderSessionConfig,
    prepared: Prepared,
    expectedPrepare = prepareAuthority(prepared),
  ) {
    const current = yield* input.readConfig(config.threadId);
    const latestPrepared = input.prepared(config.threadId);
    if (
      !latestPrepared ||
      prepareAuthority(latestPrepared) !== expectedPrepare ||
      config.providerInstanceId !== prepared.providerInstanceId ||
      current?.providerSessionId !== config.providerSessionId ||
      current.credentialGeneration !== config.credentialGeneration ||
      current.providerInstanceId !== config.providerInstanceId
    )
      return false;
    if (!(yield* input.attached(config, prepared))) return false;
    const latest = yield* input.readConfig(config.threadId);
    const finalPrepared = input.prepared(config.threadId);
    return (
      finalPrepared !== undefined &&
      prepareAuthority(finalPrepared) === expectedPrepare &&
      latest?.providerSessionId === config.providerSessionId &&
      latest.credentialGeneration === config.credentialGeneration &&
      latest.providerInstanceId === config.providerInstanceId
    );
  });
  const currentAttachment = Effect.fn("MemoryProviderAuthority.currentAttachment")(function* (
    config: McpProviderSessionConfig,
  ) {
    const prepared = input.prepared(config.threadId);
    if (!prepared) return undefined;
    const holds = Effect.fn("MemoryProviderAuthority.holds")(function* () {
      const current = yield* input.readConfig(config.threadId);
      const latest = input.prepared(config.threadId);
      return (
        current?.providerSessionId === config.providerSessionId &&
        current.credentialGeneration === config.credentialGeneration &&
        current.providerInstanceId === config.providerInstanceId &&
        latest !== undefined &&
        latest.providerInstanceId === config.providerInstanceId &&
        latest.providerInstanceId === prepared.providerInstanceId &&
        (yield* input.attached(config, latest))
      );
    });
    if (!(yield* holds())) return undefined;
    const thread = yield* input.projection.getThread(config.threadId).pipe(Effect.option);
    if (
      Option.isNone(thread) ||
      thread.value.deletedAt !== null ||
      thread.value.archivedAt !== null ||
      thread.value.providerInstanceId !== prepared.providerInstanceId ||
      !(yield* holds())
    )
      return undefined;
    const latest = input.prepared(config.threadId);
    return latest?.providerInstanceId === prepared.providerInstanceId &&
      (yield* references(config, latest))
      ? latest
      : undefined;
  });
  const isCurrentAttachment = (config: McpProviderSessionConfig) =>
    currentAttachment(config).pipe(Effect.map((prepared) => prepared !== undefined));
  const currentMemoryPolicy = Effect.fn("MemoryProviderAuthority.currentMemoryPolicy")(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<MemorySnapshotPolicy> {
    const committed = Option.isSome(input.policy) ? yield* input.policy.value.read : undefined;
    const denied = { grant: "none" as const, policyEpoch: committed?.epoch ?? 0 };
    if (!committed?.policyReady || !committed.enableAgentMemoryAccess) return denied;
    const currentConfig = yield* input.readConfig(threadId);
    if (!currentConfig) return denied;
    const config = { ...currentConfig };
    const registryPolicy = () =>
      input.registry.currentMemoryPolicy?.(config.providerSessionId) ??
      Effect.sync(() => undefined);
    const policy = yield* registryPolicy();
    if (!policy || policy.grant === "none" || policy.policyEpoch !== committed.epoch) return denied;
    const prepared = yield* currentAttachment(config);
    if (!prepared) return denied;
    const expectedPrepare = prepareAuthority(prepared);
    const finalAuthority = Effect.gen(function* () {
      const current = Option.isSome(input.policy) ? yield* input.policy.value.read : undefined;
      if (
        !current?.policyReady ||
        !current.enableAgentMemoryAccess ||
        current.epoch !== policy.policyEpoch ||
        !(yield* references(config, prepared, expectedPrepare))
      )
        return false;
      const registry = yield* registryPolicy();
      if (
        registry?.grant !== policy.grant ||
        registry.policyEpoch !== policy.policyEpoch ||
        !(yield* references(config, prepared, expectedPrepare))
      )
        return false;
      const latest = Option.isSome(input.policy) ? yield* input.policy.value.read : undefined;
      return (
        !!latest?.policyReady &&
        latest.enableAgentMemoryAccess &&
        latest.epoch === policy.policyEpoch
      );
    });
    return { ...policy, finalAuthority };
  });
  return { isCurrentAttachment, currentMemoryPolicy };
};
