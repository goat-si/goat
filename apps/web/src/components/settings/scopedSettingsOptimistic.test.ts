import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ProjectId } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import { planScopedSettingsPatch, type ScopedSettingsEnvironment } from "./scopedSettings";
import {
  applyPendingScopedWrites,
  reconcilePendingScopedWrites,
  settlePendingScopedWrite,
  type PendingScopedWrite,
} from "./scopedSettingsOptimistic";

it("replans pending project changes and retires only writes covered by the echo", () => {
  const environmentId = EnvironmentId.make("pending-test");
  const projectId = ProjectId.make("pending-project");
  const environment: ScopedSettingsEnvironment = {
    environmentId,
    label: "Test",
    connection: { phase: "connected" },
    serverConfig: {
      settings: DEFAULT_SERVER_SETTINGS,
      environment: { capabilities: { projectSettingsOverrides: true } },
    },
  };
  const scope = {
    kind: "project",
    members: [{ id: projectId, environmentId }],
    environmentIds: [environmentId],
    label: "Project",
  } as unknown as Parameters<typeof planScopedSettingsPatch>[0];
  const first = {};
  const second = {};
  const writes: PendingScopedWrite[] = [
    {
      save: first,
      environmentId,
      environments: [environment],
      plan: (environments) =>
        planScopedSettingsPatch(scope, environments, { defaultAutoPull: true }),
    },
    {
      save: second,
      environmentId,
      environments: [environment],
      plan: (environments) =>
        planScopedSettingsPatch(scope, environments, { enableAgentBrowserAccess: false }),
    },
  ];
  const projected = applyPendingScopedWrites([environment], writes)[0]!.serverConfig!.settings;
  expect(projected.projectSettingsOverrides[projectId]).toMatchObject({
    defaultAutoPull: true,
    enableAgentBrowserAccess: false,
  });
  const afterFailure = settlePendingScopedWrite(writes, first, environmentId);
  const failedProjection = applyPendingScopedWrites([environment], afterFailure)[0]!.serverConfig!
    .settings;
  expect(failedProjection.projectSettingsOverrides[projectId]).toMatchObject({
    enableAgentBrowserAccess: false,
  });
  expect(failedProjection.projectSettingsOverrides[projectId]?.defaultAutoPull).toBeUndefined();

  const firstSaved = applyPendingScopedWrites([environment], [writes[0]!])[0]!.serverConfig!
    .settings;
  const completedFirst = settlePendingScopedWrite(writes, first, environmentId, firstSaved);
  const completedBoth = settlePendingScopedWrite(completedFirst, second, environmentId, projected);
  const oldEcho = {
    ...environment,
    serverConfig: { ...environment.serverConfig!, settings: firstSaved },
  };
  expect(reconcilePendingScopedWrites(completedBoth, [oldEcho])).toHaveLength(2);
  expect(
    applyPendingScopedWrites([oldEcho], completedBoth)[0]!.serverConfig!.settings
      .projectSettingsOverrides[projectId],
  ).toMatchObject({ defaultAutoPull: true, enableAgentBrowserAccess: false });
  const finalEcho = {
    ...environment,
    serverConfig: { ...environment.serverConfig!, settings: projected },
  };
  expect(reconcilePendingScopedWrites(completedBoth, [finalEcho])).toEqual([]);
});

it("retires a matching echo even when an unrelated setting changed", () => {
  const environmentId = EnvironmentId.make("concurrent-echo");
  const environment: ScopedSettingsEnvironment = {
    environmentId,
    label: "Test",
    connection: { phase: "connected" },
    serverConfig: { settings: DEFAULT_SERVER_SETTINGS },
  };
  const scope = {
    kind: "environment",
    environmentId,
    environmentIds: [environmentId],
    members: [],
    label: "Test",
  } as const;
  const save = {};
  const plan = (environments: readonly ScopedSettingsEnvironment[]) =>
    planScopedSettingsPatch(scope, environments, { defaultAutoPull: true });
  const writes: PendingScopedWrite[] = [{ save, environmentId, environments: [environment], plan }];
  const saved = { ...DEFAULT_SERVER_SETTINGS, defaultAutoPull: true };
  const settled = settlePendingScopedWrite(writes, save, environmentId, saved);
  const echo = {
    ...environment,
    serverConfig: {
      settings: { ...saved, enableProviderUpdateChecks: !saved.enableProviderUpdateChecks },
    },
  };
  expect(reconcilePendingScopedWrites(settled, [echo])).toEqual([]);
});

it("retires a matching project echo when another project setting changed", () => {
  const environmentId = EnvironmentId.make("project-concurrent-echo");
  const projectId = ProjectId.make("project");
  const environment: ScopedSettingsEnvironment = {
    environmentId,
    label: "Test",
    connection: { phase: "connected" },
    serverConfig: {
      settings: DEFAULT_SERVER_SETTINGS,
      environment: { capabilities: { projectSettingsOverrides: true } },
    },
  };
  const scope = {
    kind: "project",
    members: [{ id: projectId, environmentId }],
    environmentIds: [environmentId],
    label: "Project",
  } as unknown as Parameters<typeof planScopedSettingsPatch>[0];
  const save = {};
  const plan = (environments: readonly ScopedSettingsEnvironment[]) =>
    planScopedSettingsPatch(scope, environments, { defaultAutoPull: true });
  const writes: PendingScopedWrite[] = [{ save, environmentId, environments: [environment], plan }];
  const saved = {
    ...DEFAULT_SERVER_SETTINGS,
    projectSettingsOverrides: { [projectId]: { defaultAutoPull: true } },
  };
  const settled = settlePendingScopedWrite(writes, save, environmentId, saved);
  const echo = {
    ...environment,
    serverConfig: {
      ...environment.serverConfig!,
      settings: {
        ...saved,
        projectSettingsOverrides: {
          [projectId]: { defaultAutoPull: true, enableAgentBrowserAccess: false },
        },
      },
    },
  };
  expect(reconcilePendingScopedWrites(settled, [echo])).toEqual([]);
});
