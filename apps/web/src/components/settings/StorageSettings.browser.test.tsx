import { act, render } from "../../../test/render";
import { RegistryProvider } from "@effect/atom-react";
import { DEFAULT_SERVER_SETTINGS, type StorageCleanupReport } from "@goat/contracts";
import { type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  settings: {} as typeof DEFAULT_SERVER_SETTINGS,
  run: vi.fn(),
  respond: vi.fn(),
  update: vi.fn(),
  report: null as StorageCleanupReport | null,
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const report = Atom.make(() => ({ _tag: "Success", value: state.report, waiting: false }));
  const allowed = Atom.make(true);
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      storageCleanupReport: (() => report) as never,
      respondWorktreeCleanupPreview: {
        ...actual.serverEnvironment.respondWorktreeCleanupPreview,
        permissionAtom: () => allowed,
      },
      updateSettings: { ...actual.serverEnvironment.updateSettings, permissionAtom: () => allowed },
      runStorageCleanup: {
        ...actual.serverEnvironment.runStorageCleanup,
        permissionAtom: () => allowed,
      },
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { label: string }) =>
    command.label.includes("respond-worktree")
      ? state.respond
      : command.label.includes("update-settings")
        ? state.update
        : state.run) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => {
    const environment = {
      environmentId: "env",
      label: "Build workstation",
      serverConfig: {
        settings: state.settings,
        environment: {
          capabilities: {
            storageCleanup: true,
            storageCleanupRun: true,
            settledWorktreeCleanup: true,
          },
        },
      },
    };
    return {
      scope: { kind: "environment" },
      environments: [environment],
      connectedEnvironments: [environment],
      targets: [],
      target: null,
    };
  }) as never,
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => state.settings) as never,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => vi.fn(),
  useClearScopedSettings: () => vi.fn(),
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsPageContainer: (({ children }: { children: ReactNode }) => children) as never,
  SettingsRow: ({ title, description, control, children }) => (
    <div>
      <h3>{title}</h3>
      {description}
      {control}
      {children}
    </div>
  ),
  SettingResetButton: (() => null) as never,
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: vi.fn() } };
});

import { StorageSettingsPanel } from "./StorageSettings";

function setup() {
  state.settings = {
    ...DEFAULT_SERVER_SETTINGS,
    storageCleanup: {
      ...DEFAULT_SERVER_SETTINGS.storageCleanup,
      worktreeKeepWhen: "uncommitted-changes",
      worktreeKeepRecent: null,
      worktreeOnArchive: false,
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeOnMerge: false,
      worktreeOnDelete: false,
      worktreeUnchanged: false,
      browserArtifactsAfterDays: null,
      logsAfterDays: null,
    },
    projectSettingsOverrides: {},
  };
  state.report = null;
  state.run.mockReset();
  state.respond.mockReset();
  state.update.mockReset();
}

const panel = () => (
  <RegistryProvider>
    <StorageSettingsPanel />
  </RegistryProvider>
);
const deleteButton = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Delete now",
  )!;

it("keeps cleanup disabled when settled retention and all other rules are off", async () => {
  setup();
  await using screen = await render(panel());
  const button = deleteButton(screen.container);

  expect(button.disabled).toBe(true);
  await act(async () => button.click());
  expect(state.run).not.toHaveBeenCalled();
});

it("confirms a cleanup preview and turns off its rules", async () => {
  setup();
  state.report = {
    trigger: "automatic",
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:00:00Z",
    entries: [],
    counts: { removed: 0, kept: 0, failed: 0 },
    omittedCount: 0,
    bytesFreed: 0,
    worktreePreview: {
      id: "preview-1",
      plannedCount: 4,
      startedAt: "2026-01-01T00:00:00Z",
      seenAt: null,
      activatesAt: null,
      requiresConfirmation: true,
    },
  };
  await using screen = await render(panel());
  expect(screen.container.textContent).toContain("GOAT will clean up 4 worktrees");
  await screen.getByRole("button", { name: "Clean up now" }).click();
  expect(state.respond).toHaveBeenCalledWith({
    environmentId: "env",
    input: { previewId: "preview-1", response: "confirm" },
  });
  await screen.getByRole("button", { name: "Turn off" }).click();
  expect(state.update).toHaveBeenCalledWith({
    environmentId: "env",
    input: {
      patch: {
        storageCleanup: {
          worktreeKeepRecent: null,
          worktreeAfterDays: null,
          worktreeOnArchive: false,
        },
      },
    },
  });
});

it("labels planned worktrees as awaiting cleanup", async () => {
  setup();
  state.report = {
    trigger: "automatic",
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:00:00Z",
    entries: [
      {
        kind: "worktree",
        outcome: "kept",
        reason: "kept",
        path: "/tmp/work",
        projectPath: null,
        threadId: null,
        threadTitle: null,
        bytes: null,
        files: null,
        planned: true,
      },
    ],
    counts: { removed: 0, kept: 1, failed: 0 },
    omittedCount: 0,
    bytesFreed: 0,
  };
  await using screen = await render(panel());
  await screen.getByText("Last run").click();
  expect(screen.container.textContent).toContain("Will be cleaned up");
});
