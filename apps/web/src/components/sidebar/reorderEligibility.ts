import type { EnvironmentServerConfig } from "@goat/client-runtime/connection";
import { scopeThreadRef, scopedThreadKey } from "@goat/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@goat/contracts";
export function resolveSidebarReorderableThreadKeys(input: {
  readonly threads: ReadonlyArray<{ environmentId: EnvironmentId; id: ThreadId }>;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, Pick<EnvironmentServerConfig, "environment">>;
  readonly connectedEnvironmentIds: readonly EnvironmentId[];
}) {
  const connectedEnvironmentIds = new Set(input.connectedEnvironmentIds);
  const draggableThreadKeys = new Set<string>();
  const activeReorderableThreadKeys = new Set<string>();

  for (const thread of input.threads) {
    // Config is cached for offline rendering, so its presence does not make a row writable.
    if (
      !connectedEnvironmentIds.has(thread.environmentId) ||
      !input.serverConfigs.has(thread.environmentId)
    ) {
      continue;
    }

    const capabilities = input.serverConfigs.get(thread.environmentId)?.environment.capabilities;
    const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    if (capabilities?.threadActiveReorder === true) activeReorderableThreadKeys.add(threadKey);
    if (capabilities?.threadPinning === true && capabilities.threadPinReorder === true)
      draggableThreadKeys.add(threadKey);
  }

  return { draggableThreadKeys, activeReorderableThreadKeys };
}
