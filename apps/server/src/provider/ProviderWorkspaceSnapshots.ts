import type { ServerProvider } from "@goat/contracts";
import type { ProviderWorkspaceSnapshot } from "@goat/provider-core/server/driver";
import * as Equal from "effect/Equal";

const MAX_WORKSPACE_SNAPSHOTS_PER_PROVIDER = 16;

function workspaceModelDifferences(
  machineModels: ServerProvider["models"],
  workspaceModels: ServerProvider["models"] | undefined,
) {
  if (workspaceModels === undefined) return {};
  const machine = new Map(machineModels.map((model) => [model.slug, model]));
  const listed = new Set(workspaceModels.map((model) => model.slug));
  const models = workspaceModels.filter((model) => {
    const known = machine.get(model.slug);
    return known === undefined || !Equal.equals(known, model);
  });
  const removedModels = machineModels
    .filter((model) => !listed.has(model.slug))
    .map((model) => model.slug);
  return {
    ...(models.length === 0 ? {} : { models }),
    ...(removedModels.length === 0 ? {} : { removedModels }),
  };
}

export function dropProviderWorkspaceSnapshot(
  provider: ServerProvider,
  cwd: string,
): ServerProvider {
  return provider.workspaceSnapshots?.some((snapshot) => snapshot.cwd === cwd)
    ? {
        ...provider,
        workspaceSnapshots: provider.workspaceSnapshots.filter((snapshot) => snapshot.cwd !== cwd),
      }
    : provider;
}

export function upsertProviderWorkspaceSnapshot(
  provider: ServerProvider,
  cwd: string,
  scopedSnapshot: ProviderWorkspaceSnapshot,
): ServerProvider {
  const previousSnapshot = provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd);
  const optionDescriptors = scopedSnapshot.optionDescriptors ?? previousSnapshot?.optionDescriptors;
  const { models, removedModels } = scopedSnapshot.workspaceModelsPending
    ? { models: previousSnapshot?.models, removedModels: previousSnapshot?.removedModels }
    : workspaceModelDifferences(provider.models, scopedSnapshot.workspaceModels);
  const workspaceSnapshot = {
    cwd,
    checkedAt: scopedSnapshot.checkedAt,
    slashCommands: scopedSnapshot.slashCommandsPending
      ? (previousSnapshot?.slashCommands ?? scopedSnapshot.slashCommands)
      : scopedSnapshot.slashCommands,
    ...(scopedSnapshot.slashCommandsPending ? { slashCommandsPending: true } : {}),
    skills: scopedSnapshot.skills,
    ...(optionDescriptors === undefined ? {} : { optionDescriptors }),
    ...(models === undefined ? {} : { models }),
    ...(removedModels === undefined ? {} : { removedModels }),
    ...(scopedSnapshot.workspaceModelsPending ? { modelsPending: true } : {}),
  } satisfies NonNullable<ServerProvider["workspaceSnapshots"]>[number];
  return {
    ...provider,
    workspaceSnapshots: [
      ...(provider.workspaceSnapshots ?? []).filter((snapshot) => snapshot.cwd !== cwd),
      workspaceSnapshot,
    ].slice(-MAX_WORKSPACE_SNAPSHOTS_PER_PROVIDER),
  };
}
