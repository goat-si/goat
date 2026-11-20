import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ServerSettings,
} from "@goat/contracts";
import { applyServerSettingsPatch } from "@goat/shared/serverSettings";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  context: null as unknown,
  environment: null as unknown,
  persist: vi.fn(),
}));
vi.mock(import("./SettingsScopeContext"), () => ({
  useSettingsScope: () => state.context as never,
  useOptionalSettingsScope: () => state.context as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.persist) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
  useEnvironmentsWithScope: () =>
    new Set([(state.environment as { environmentId: EnvironmentId }).environmentId]),
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  readEnvironment: () => state.environment as never,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SettingsRow: ({ title, control }: { title: React.ReactNode; control?: React.ReactNode }) => (
    <div>
      <h3>{title}</h3>
      {control}
    </div>
  ),
}));
vi.mock(import("./AgentWorkspaceTerminalSettings"), () => ({
  AgentWorkspaceTerminalSettings: () => <></>,
}));
vi.mock(import("./BlockedBrowserHostsSetting"), () => ({
  BlockedBrowserHostsSetting: () => <></>,
}));

import { useUpdateScopedSettings } from "./useScopedSettings";
import { AgentToolsSettings } from "./AgentToolsSettings";

function SettingsWrites() {
  const save = useUpdateScopedSettings();
  return (
    <button
      type="button"
      onClick={() => {
        save({ defaultAutoPull: true });
        save({ enableAgentBrowserAccess: false });
      }}
    >
      Save both
    </button>
  );
}

function FirstSettingsWrite() {
  const save = useUpdateScopedSettings();
  return (
    <button type="button" onClick={() => save({ defaultAutoPull: true })}>
      Save first
    </button>
  );
}

it("serializes project changes and replans from the prior save before its echo arrives", async () => {
  const environmentId = EnvironmentId.make("queue-test");
  const projectId = ProjectId.make("project-test");
  const settings = { ...DEFAULT_SERVER_SETTINGS, projectSettingsOverrides: {} };
  const environment = {
    environmentId,
    label: "Test",
    connection: { phase: "connected" },
    serverConfig: { settings, environment: { capabilities: { projectSettingsOverrides: true } } },
  };
  const member = { id: projectId, environmentId };
  state.environment = environment;
  state.context = {
    scope: {
      kind: "project",
      members: [member],
      environmentIds: [environmentId],
      label: "Project",
    },
    environments: [environment],
    deviceOnly: false,
  };
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let announceFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    announceFirst = resolve;
  });
  let announceSecond!: () => void;
  const secondFinished = new Promise<void>((resolve) => {
    announceSecond = resolve;
  });
  let stored: ServerSettings = settings;
  state.persist
    .mockReset()
    .mockImplementation(
      async ({ input }: { input: { patch: Parameters<typeof applyServerSettingsPatch>[1] } }) => {
        const call = state.persist.mock.calls.length;
        if (call === 1) {
          announceFirst();
          await firstReleased;
        }
        stored = applyServerSettingsPatch(stored, input.patch);
        if (call === 2) announceSecond();
        return { _tag: "Success", value: stored };
      },
    );
  await using screen = await render(<SettingsWrites />);
  await userEvent.click(screen.getByRole("button", { name: "Save both" }));
  await firstStarted;
  expect(state.persist).toHaveBeenCalledTimes(1);
  releaseFirst();
  await secondFinished;
  expect(stored.projectSettingsOverrides[projectId]).toMatchObject({
    defaultAutoPull: true,
    enableAgentBrowserAccess: false,
  });
});

it("serializes built-in skill changes with other project settings", async () => {
  const environmentId = EnvironmentId.make("skill-queue-test");
  const projectId = ProjectId.make("skill-project");
  const settings = { ...DEFAULT_SERVER_SETTINGS, projectSettingsOverrides: {} };
  const environment = {
    environmentId,
    label: "Test",
    connection: { phase: "connected" },
    serverConfig: {
      settings,
      environment: {
        capabilities: {
          projectSettingsOverrides: true,
          devDisciplineSkill: true,
          builtInSkills: ["goat-discipline", "goat-docs"],
        },
      },
    },
  };
  const scope = {
    kind: "project",
    members: [{ id: projectId, environmentId }],
    environmentIds: [environmentId],
    label: "Project",
  };
  state.environment = environment;
  state.context = {
    scope,
    environments: [environment],
    connectedEnvironments: [environment],
    targets: [{ environmentId, projectId, settings }],
    target: null,
    deviceOnly: false,
  };
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let announceFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    announceFirst = resolve;
  });
  let announceSecond!: () => void;
  const secondFinished = new Promise<void>((resolve) => {
    announceSecond = resolve;
  });
  let stored: ServerSettings = settings;
  state.persist
    .mockReset()
    .mockImplementation(
      async ({ input }: { input: { patch: Parameters<typeof applyServerSettingsPatch>[1] } }) => {
        const call = state.persist.mock.calls.length;
        if (call === 1) {
          announceFirst();
          await firstReleased;
        }
        stored = applyServerSettingsPatch(stored, input.patch);
        if (call === 2) announceSecond();
        return { _tag: "Success", value: stored };
      },
    );
  await using screen = await render(
    <>
      <FirstSettingsWrite />
      <AgentToolsSettings />
    </>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Save first" }));
  await firstStarted;
  await userEvent.click(screen.getByRole("combobox", { name: "Development discipline" }));
  await userEvent.click(screen.getByRole("option", { name: "Off", exact: true }));
  expect(state.persist).toHaveBeenCalledTimes(1);
  releaseFirst();
  await secondFinished;
  expect(stored.projectSettingsOverrides[projectId]).toMatchObject({
    defaultAutoPull: true,
    builtInSkills: { "goat-discipline": { enabled: false } },
  });
});
