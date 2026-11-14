import { act, render, type Screen } from "../../../test/render";
import { RegistryProvider } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  type StorageCleanupReport,
  WORKTREE_CLEANUP_OFF,
} from "@goat/contracts";
import { type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "~/index.css";

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
  useUpdateScopedSettings: () => state.update,
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
  expect(screen.container.textContent).toContain("4 worktrees match the cleanup rules below.");
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
        storageCleanup: WORKTREE_CLEANUP_OFF,
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

const rule = "Delete old browser artifacts";
const ruleSwitch = (screen: Screen) => screen.getByRole("switch", { name: rule });
const daysInput = (screen: Screen) => screen.getByLabelText(`${rule} in days`);
const saves = () => state.update.mock.calls.map(([patch]) => patch.storageCleanup);
const failSave = (index: number) => act(() => state.update.mock.calls[index]?.[1]?.onFailed?.());
const withSavedAge = (days: number) => {
  state.settings = {
    ...state.settings,
    storageCleanup: { ...state.settings.storageCleanup, browserArtifactsAfterDays: days },
  };
};

it("saves a newly enabled retention rule only once its age is committed", async () => {
  setup();
  await using screen = await render(panel());
  await userEvent.click(ruleSwitch(screen));
  expect(state.update).not.toHaveBeenCalled();
  await expect.element(ruleSwitch(screen)).toBeChecked();
  await expect.element(daysInput(screen)).toHaveFocus();

  await userEvent.fill(daysInput(screen), "30");
  await userEvent.keyboard("{Enter}");
  expect(saves()).toEqual([{ browserArtifactsAfterDays: 30 }]);
  await expect.element(ruleSwitch(screen)).toBeChecked();
});

it("discards a retention draft on Escape, on leaving it untouched, or when switched back off", async () => {
  setup();
  await using screen = await render(panel());
  await userEvent.click(ruleSwitch(screen));
  await expect.element(daysInput(screen)).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(ruleSwitch(screen)).not.toBeChecked();

  await userEvent.click(ruleSwitch(screen));
  await expect.element(daysInput(screen)).toHaveFocus();
  await userEvent.click(screen.getByRole("heading", { name: rule }));
  await expect.element(ruleSwitch(screen)).not.toBeChecked();

  await userEvent.click(ruleSwitch(screen));
  await userEvent.fill(daysInput(screen), "30");
  await userEvent.click(ruleSwitch(screen));
  await expect.element(daysInput(screen)).not.toBeInTheDocument();
  await expect.element(ruleSwitch(screen)).not.toBeChecked();
  expect(state.update).not.toHaveBeenCalled();
});

it("saves an edited draft when focus leaves its row, not when it reaches the switch", async () => {
  setup();
  await using screen = await render(panel());
  await userEvent.click(ruleSwitch(screen));
  await userEvent.fill(daysInput(screen), "30");
  await userEvent.tab();
  await expect.element(ruleSwitch(screen)).toHaveFocus();
  expect(state.update).not.toHaveBeenCalled();
  await userEvent.tab();
  expect(saves()).toEqual([{ browserArtifactsAfterDays: 30 }]);
});

it("saves a stepped first age only once it is committed", async () => {
  setup();
  await using screen = await render(panel());
  await userEvent.click(ruleSwitch(screen));
  await userEvent.click(screen.getByRole("button", { name: `Increase ${rule}` }));
  await userEvent.keyboard("{ArrowUp}");
  await expect.element(daysInput(screen)).toHaveValue("10");
  expect(state.update).not.toHaveBeenCalled();
  await userEvent.keyboard("{Enter}");
  expect(saves()).toEqual([{ browserArtifactsAfterDays: 10 }]);
});

it("does not save the draft age when Enter is pressed on invalid text", async () => {
  setup();
  await using screen = await render(panel());
  await userEvent.click(ruleSwitch(screen));
  await userEvent.fill(daysInput(screen), "+");
  await userEvent.keyboard("{Enter}");
  expect(state.update).not.toHaveBeenCalled();
});

it("switching an edited saved rule off never saves its age afterwards", async () => {
  setup();
  withSavedAge(30);
  await using screen = await render(panel());
  await userEvent.click(daysInput(screen));
  await userEvent.keyboard("{Control>}a{/Control}40");
  await userEvent.click(ruleSwitch(screen));
  await expect.element(ruleSwitch(screen)).not.toBeChecked();
  await userEvent.click(screen.getByRole("heading", { name: rule }));
  expect(saves()).toEqual([{ browserArtifactsAfterDays: null }]);
});

it("returns a newly enabled retention rule to off when its first save fails", async () => {
  setup();
  await using screen = await render(panel());
  await userEvent.click(ruleSwitch(screen));
  await expect.element(daysInput(screen)).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(saves()).toEqual([{ browserArtifactsAfterDays: 8 }]);

  await failSave(0);
  await expect.element(ruleSwitch(screen)).not.toBeChecked();
});

it("keeps a newer pending age open when an older first save fails", async () => {
  setup();
  await using screen = await render(panel());
  await userEvent.click(ruleSwitch(screen));
  for (const age of ["30", "60"]) {
    await userEvent.fill(daysInput(screen), age);
    await userEvent.keyboard("{Enter}");
  }
  expect(saves()).toHaveLength(2);

  await failSave(0);
  await expect.element(daysInput(screen)).toHaveValue("60");
  await expect.element(ruleSwitch(screen)).toBeChecked();
});

it("restores a saved age on failure without overwriting newer submissions or edits", async () => {
  setup();
  withSavedAge(30);
  await using screen = await render(panel());
  await userEvent.fill(daysInput(screen), "40");
  await userEvent.keyboard("{Enter}");
  await failSave(0);
  await expect.element(daysInput(screen)).toHaveValue("30");
  await userEvent.fill(daysInput(screen), "40");
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(daysInput(screen), "60");
  await userEvent.keyboard("{Enter}");
  await failSave(1);
  await expect.element(daysInput(screen)).toHaveValue("60");
  await userEvent.fill(daysInput(screen), "70");
  await failSave(2);
  await expect.element(daysInput(screen)).toHaveValue("70");
});
