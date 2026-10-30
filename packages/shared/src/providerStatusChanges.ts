import type {
  ServerConfigProviderStatusChangesPayload,
  ServerProvider,
  ServerProviderStatusChange,
} from "@goat/contracts";
import * as Equal from "effect/Equal";

/** What turns `previous` into `next`, or undefined when there is nothing to send. */
export function diffProviderStatuses(
  previous: ReadonlyArray<ServerProvider>,
  next: ReadonlyArray<ServerProvider>,
): ServerConfigProviderStatusChangesPayload | undefined {
  const before = new Map(previous.map((provider) => [provider.instanceId, provider] as const));
  const providers = next.flatMap((provider): ServerProviderStatusChange[] => {
    const old = before.get(provider.instanceId);
    if (old === undefined) return [provider];
    if (Equal.equals(old, provider)) return [];
    const { models, skills, slashCommands, ...fields } = provider;
    return [
      {
        ...fields,
        ...(Equal.equals(old.models, models) ? {} : { models }),
        ...(Equal.equals(old.skills, skills) ? {} : { skills }),
        ...(Equal.equals(old.slashCommands, slashCommands) ? {} : { slashCommands }),
      },
    ];
  });
  const sameOrder =
    previous.length === next.length &&
    next.every((provider, index) => previous[index]?.instanceId === provider.instanceId);
  if (providers.length === 0 && sameOrder) return undefined;
  return {
    instanceIds: next.map((provider) => provider.instanceId),
    changedInstanceIds: providers.map((provider) => provider.instanceId),
    providers,
  };
}

/**
 * False when a changed provider did not decode here, or a change omits the lists of a provider
 * `previous` lacks; only a full list can rebuild those.
 */
export function canApplyProviderStatusChanges(
  previous: ReadonlyArray<ServerProvider>,
  changes: ServerConfigProviderStatusChangesPayload,
): boolean {
  const known = new Set(previous.map((provider) => provider.instanceId));
  const decoded = new Set(changes.providers.map((provider) => provider.instanceId));
  return (
    changes.changedInstanceIds.every((instanceId) => decoded.has(instanceId)) &&
    changes.providers.every(
      (change) =>
        known.has(change.instanceId) ||
        (change.models !== undefined &&
          change.skills !== undefined &&
          change.slashCommands !== undefined),
    )
  );
}

/** Unchanged providers and lists keep their objects, so memoized views skip them. */
export function applyProviderStatusChanges(
  previous: ReadonlyArray<ServerProvider>,
  changes: ServerConfigProviderStatusChangesPayload,
): ReadonlyArray<ServerProvider> {
  const before = new Map(previous.map((provider) => [provider.instanceId, provider] as const));
  const changed = new Map(changes.providers.map((provider) => [provider.instanceId, provider]));
  const sentChanged = new Set(changes.changedInstanceIds);
  return changes.instanceIds.flatMap((instanceId): ServerProvider[] => {
    const old = before.get(instanceId);
    const change = changed.get(instanceId);
    // A change this client could not decode leaves the list, as it would from a full list.
    if (change === undefined) return old === undefined || sentChanged.has(instanceId) ? [] : [old];
    return [
      {
        ...change,
        models: change.models ?? old?.models ?? [],
        skills: change.skills ?? old?.skills ?? [],
        slashCommands: change.slashCommands ?? old?.slashCommands ?? [],
      },
    ];
  });
}
