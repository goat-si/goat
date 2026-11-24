import { ProviderDriverKind, type ServerProvider } from "@goat/contracts";
import * as Equal from "effect/Equal";

import {
  mergeProviderModels,
  shouldRetainMissingOpenCodeMetadata,
} from "./ProviderModelRetention.ts";

import { MAX_WORKSPACE_SNAPSHOTS_PER_PROVIDER } from "./ProviderWorkspaceSnapshots.ts";

/** Antigravity health checks only initialize; preserve previously verified Google auth across restarts. */
const carrySavedAntigravityAccount = (
  previousProvider: ServerProvider,
  nextProvider: ServerProvider,
): Pick<ServerProvider, "auth" | "status"> | undefined => {
  const antigravity = ProviderDriverKind.make("antigravity");
  if (
    nextProvider.driver !== antigravity ||
    previousProvider.driver !== antigravity ||
    !nextProvider.enabled ||
    nextProvider.auth.status !== "unknown" ||
    previousProvider.auth.status !== "authenticated" ||
    (nextProvider.auth.type !== undefined &&
      nextProvider.auth.type !== previousProvider.auth.type) ||
    (!nextProvider.installed && nextProvider.status !== "warning")
  ) {
    return undefined;
  }
  const status =
    nextProvider.installed && nextProvider.status === "warning" ? "ready" : nextProvider.status;
  return { auth: previousProvider.auth, status };
};

export function sameWorkspaceCatalogBasis(
  previous: ServerProvider | undefined,
  next: ServerProvider,
): boolean {
  return (
    previous !== undefined &&
    previous.installed === next.installed &&
    previous.version === next.version &&
    previous.installedVersion === next.installedVersion &&
    Equal.equals(previous.slashCommands, next.slashCommands) &&
    Equal.equals(previous.skills, next.skills)
  );
}

export function invalidateChangedWorkspaceCatalog(
  previous: ServerProvider | undefined,
  provider: ServerProvider,
): ServerProvider {
  if (
    !previous ||
    !provider.workspaceSnapshots?.length ||
    sameWorkspaceCatalogBasis(previous, provider)
  ) {
    return provider;
  }
  const { workspaceSnapshots: _stale, ...machine } = provider;
  return machine;
}

export const mergeProviderSnapshot = (
  previousProvider: ServerProvider | undefined,
  nextProvider: ServerProvider,
): ServerProvider => {
  if (!previousProvider) {
    return nextProvider;
  }
  const savedAccount = carrySavedAntigravityAccount(previousProvider, nextProvider);
  const {
    message: _uncheckedMessage,
    modelsRetained: _retained,
    ...nextWithoutMessage
  } = nextProvider;
  const { modelsRetained: _nextRetained, ...nextWithoutRetained } = nextProvider;
  const models = mergeProviderModels(nextProvider, previousProvider.models, nextProvider.models);
  const status = savedAccount?.status ?? nextProvider.status;
  const retained =
    nextProvider.enabled &&
    nextProvider.installed &&
    (status === "error" || status === "warning") &&
    nextProvider.auth.status !== "unauthenticated" &&
    models.length > 0 &&
    (previousProvider.status === "ready" ||
      (previousProvider.modelsRetained === true &&
        previousProvider.checkedAt === nextProvider.checkedAt));
  // Folder catalogs were compared with the old machine catalog, so every folder rescans.
  const previousWorkspaceSnapshots = Equal.equals(models, previousProvider.models)
    ? previousProvider.workspaceSnapshots
    : previousProvider.workspaceSnapshots?.map((snapshot) => ({
        ...snapshot,
        modelsPending: true,
      }));
  const nextWorkspaceSnapshots = nextProvider.workspaceSnapshots;
  const workspaceSnapshots =
    nextWorkspaceSnapshots === undefined ||
    !nextProvider.enabled ||
    nextProvider.auth.status === "unauthenticated" ||
    (!nextProvider.installed && nextProvider.status === "error")
      ? (nextWorkspaceSnapshots ?? previousWorkspaceSnapshots)
      : [
          ...(previousWorkspaceSnapshots ?? []).filter(
            ({ cwd }) => !nextWorkspaceSnapshots.some((snapshot) => snapshot.cwd === cwd),
          ),
          ...nextWorkspaceSnapshots,
        ].slice(-MAX_WORKSPACE_SNAPSHOTS_PER_PROVIDER);
  return {
    ...(savedAccount?.status === "ready" ? nextWithoutMessage : nextWithoutRetained),
    ...savedAccount,
    models,
    ...(retained ? { modelsRetained: true } : {}),
    ...(workspaceSnapshots === undefined ? {} : { workspaceSnapshots }),
    ...(nextProvider.workspaceRescannedAt === undefined &&
    previousProvider.workspaceRescannedAt !== undefined
      ? { workspaceRescannedAt: previousProvider.workspaceRescannedAt }
      : {}),
    ...(shouldRetainMissingOpenCodeMetadata(nextProvider)
      ? {
          slashCommands:
            nextProvider.slashCommands.length === 0
              ? previousProvider.slashCommands
              : nextProvider.slashCommands,
          skills: nextProvider.skills.length === 0 ? previousProvider.skills : nextProvider.skills,
        }
      : {}),
  };
};
