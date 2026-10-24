import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ProjectScript,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@goat/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@goat/shared/keybindings";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import type { GoatProjectFileState } from "../../hooks/useGoatProjectFileScripts";
import type { ReactNode } from "react";

const state = vi.hoisted(() => ({
  settings: {} as ServerSettings,
  file: {} as GoatProjectFileState,
  members: 1,
  storedScripts: [] as readonly ProjectScript[],
  allowed: true,
  supported: true,
  updateSettings: vi.fn(),
  upsertKeybinding: vi.fn(),
  removeKeybinding: vi.fn(),
  readFile: vi.fn(),
  selectScope: vi.fn(),
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => state.allowed,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => [],
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      updateSettings: "updateSettings",
      upsertKeybinding: "upsertKeybinding",
      removeKeybinding: "removeKeybinding",
    } as unknown as typeof actual.serverEnvironment,
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: "updateSettings" | "upsertKeybinding" | "removeKeybinding") =>
    state[command]) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: [environment()] })) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => {
    const members = Array.from({ length: state.members }, (_, i) => ({
      id: ProjectId.make(`project-${i}`),
      environmentId,
      workspaceRoot: `/checkout-${i}`,
      physicalProjectKey: `checkout-${i}`,
      scripts: state.storedScripts,
    }));
    const targets = members.map((member) => ({
      environmentId,
      projectId: member.id,
      settings: state.settings,
    }));
    return {
      scope: { kind: "project", members },
      targets,
      target: targets[0],
      search: {},
      selectScope: state.selectScope,
    };
  }) as never,
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettingsWriteAllowed: () => state.allowed,
}));
vi.mock(import("../../hooks/useGoatProjectFileScripts"), () => ({
  useGoatProjectFileState: (id, cwd) => {
    state.readFile(id, cwd);
    return state.file;
  },
}));
// Scope/permission inheritance has its own coverage; keep this suite on action rendering and persisted writes.
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsSection: (({ children }: { children: ReactNode }) => (
    <section>{children}</section>
  )) as never,
  SettingsRow: ({ title, description, control, children }) => (
    <div>
      <h3>{title}</h3>
      <div>{description}</div>
      {control}
      {children}
    </div>
  ),
}));
import { ProjectActionsSettings } from "./ProjectActionsSettings";
const environmentId = EnvironmentId.make("remote");
function environment() {
  return {
    environmentId,
    serverConfig: {
      settings: state.settings,
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
      environment: { capabilities: { projectSettingsOverrides: state.supported } },
    },
  };
}
const setupScript = {
  name: "Prepare checkout",
  command: "node setup.js",
  runOnWorktreeCreate: true,
  async: false,
  runAsCheck: true,
};
function setup(settings: Partial<ServerSettings> = {}) {
  state.settings = {
    ...DEFAULT_SERVER_SETTINGS,
    projectSettingsFolded: true,
    defaultProjectScripts: [],
    ...settings,
  };
  state.file = {
    status: "valid",
    relativePath: "goat.json",
    scripts: [setupScript],
    file: { scripts: [setupScript] },
  };
  state.members = 1;
  state.storedScripts = [];
  state.allowed = true;
  state.supported = true;
  vi.clearAllMocks();
  state.updateSettings.mockImplementation(
    async ({ input }: { input: { patch: ServerSettingsPatch } }) => {
      const patch = input.patch.projectSettingsOverrides;
      if (patch) {
        const overrides = { ...state.settings.projectSettingsOverrides };
        for (const [id, value] of Object.entries(patch)) {
          if (value === null) delete overrides[ProjectId.make(id)];
          else overrides[ProjectId.make(id)] = value;
        }
        state.settings = { ...state.settings, projectSettingsOverrides: overrides };
      }
      return AsyncResult.success(undefined);
    },
  );
  state.removeKeybinding.mockResolvedValue(AsyncResult.success(undefined));
}

it("lists the effective file setup read-only with its source and roles", async () => {
  setup();
  await using screen = await render(<ProjectActionsSettings />);
  await expect.element(screen.getByText("Prepare checkout", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("from goat.json", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("runOnWorktreeCreate", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("async: false", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("check", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("node setup.js", { exact: true })).toBeVisible();
  expect(screen.container.querySelector('[aria-label="Edit Prepare checkout"]')).toBeNull();
  expect(screen.container.textContent).not.toContain("No actions configured.");
});
it("disables file setup with an empty project override and restores inheritance by keyboard", async () => {
  setup();
  await using screen = await render(<ProjectActionsSettings />);
  await userEvent.click(
    screen.getByRole("button", { name: "Disable repository actions for this project" }),
  );
  await vi.waitFor(() =>
    expect(state.updateSettings).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        patch: { projectSettingsOverrides: { "project-0": { defaultProjectScripts: [] } } },
      },
    }),
  );
  await screen.rerender(<ProjectActionsSettings />);
  await expect
    .element(screen.getByText("Repository actions are disabled for this project.", { exact: true }))
    .toBeVisible();
  expect(screen.container.textContent).not.toContain("Prepare checkout");
  const restore = screen.getByRole("button", { name: "Use inherited actions" });
  await userEvent.tab();
  // Focus the native control to exercise its keyboard activation without depending on other rows' tab order.
  (restore.element() as HTMLButtonElement).focus();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(state.updateSettings).toHaveBeenLastCalledWith({
      environmentId,
      input: { patch: { projectSettingsOverrides: { "project-0": null } } },
    }),
  );
  await screen.rerender(<ProjectActionsSettings />);
  await expect.element(screen.getByText("Prepare checkout", { exact: true })).toBeVisible();
});
it.each(["project", "defaults", "legacy-null", "legacy-empty", "stored"] as const)(
  "hides file actions when %s takes precedence",
  async (source) => {
    const action = {
      id: "custom",
      name: "Custom",
      command: "echo custom",
      icon: "play" as const,
      runOnWorktreeCreate: false,
    };
    setup(
      source === "project"
        ? {
            projectSettingsOverrides: {
              [ProjectId.make("project-0")]: { defaultProjectScripts: [action] },
            },
          }
        : source === "defaults"
          ? { defaultProjectScripts: [action] }
          : source === "stored"
            ? { projectSettingsFolded: false }
            : {
                projectSettingsFolded: false,
                projectScriptOverrides: {
                  [ProjectId.make("project-0")]: source === "legacy-null" ? null : [],
                },
              },
    );
    if (source === "stored") state.storedScripts = [action];
    await using screen = await render(<ProjectActionsSettings />);
    expect(screen.container.textContent).not.toContain("Prepare checkout");
    expect(screen.container.textContent).not.toContain("from goat.json");
    await expect
      .element(screen.getByRole("button", { name: "Disable repository actions for this project" }))
      .not.toBeInTheDocument();
    if (source === "project" || source === "defaults" || source === "stored")
      await expect.element(screen.getByText("Custom", { exact: true })).toBeVisible();
  },
);
it("labels a legacy file and the default async setup role", async () => {
  setup();
  const { async: _, ...script } = setupScript;
  state.file = {
    ...state.file,
    relativePath: "t3.json",
    file: { scripts: [script] },
    scripts: [script],
  };
  await using screen = await render(<ProjectActionsSettings />);
  await expect.element(screen.getByText("from t3.json", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("async: true", { exact: true })).toBeVisible();
});
it.each(["loading", "missing", "invalid"] as const)(
  "shows the %s file state without a misleading empty list",
  async (status) => {
    setup();
    state.file = { status, relativePath: "goat.json", file: null, scripts: [] };
    await using screen = await render(<ProjectActionsSettings />);
    await expect
      .element(
        screen.getByText(
          status === "loading"
            ? "Loading repository actions…"
            : status === "missing"
              ? "No goat.json or t3.json found in this checkout."
              : "goat.json is invalid",
          { exact: true },
        ),
      )
      .toBeVisible();
    expect(screen.container.textContent).not.toContain("No actions configured.");
  },
);
it("only inspects and disables file actions after selecting one checkout", async () => {
  setup();
  state.members = 2;
  await using screen = await render(<ProjectActionsSettings />);
  await expect
    .element(
      screen.getByText("Choose one checkout to inspect repository actions.", { exact: true }),
    )
    .toBeVisible();
  expect(state.readFile.mock.calls.every(([, cwd]) => cwd === null)).toBe(true);
  expect(screen.container.textContent).not.toContain("Prepare checkout");
  expect(screen.container.textContent).not.toContain("Disable repository actions for this project");
  await userEvent.click(screen.getByRole("button", { name: "/checkout-0" }));
  expect(state.selectScope).toHaveBeenCalledWith({ checkout: "checkout-0" });
  state.members = 1;
  await screen.rerender(<ProjectActionsSettings />);
  await userEvent.click(
    screen.getByRole("button", { name: "Disable repository actions for this project" }),
  );
  await vi.waitFor(() =>
    expect(state.updateSettings).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        patch: { projectSettingsOverrides: { "project-0": { defaultProjectScripts: [] } } },
      },
    }),
  );
});
it.each(["permission", "older-server"] as const)(
  "prevents repository writes for %s",
  async (reason) => {
    setup();
    state.allowed = reason !== "permission";
    state.supported = reason !== "older-server";
    await using screen = await render(<ProjectActionsSettings />);
    await expect
      .element(screen.getByRole("button", { name: "Disable repository actions for this project" }))
      .toBeDisabled();
    expect(state.updateSettings).not.toHaveBeenCalled();
  },
);

it("does not advertise non-setup declarations as automatic actions", async () => {
  setup();
  state.file = {
    ...state.file,
    scripts: [{ ...setupScript, runOnWorktreeCreate: false }],
    file: { scripts: [{ ...setupScript, runOnWorktreeCreate: false }] },
  };
  await using screen = await render(<ProjectActionsSettings />);
  await expect
    .element(screen.getByText("No worktree setup action in goat.json.", { exact: true }))
    .toBeVisible();
  expect(screen.container.textContent).not.toContain("Prepare checkout");
});
it("lists only the first setup declaration that the server would run", async () => {
  setup();
  state.file = {
    ...state.file,
    file: { scripts: [setupScript, { ...setupScript, name: "Second setup" }] },
  };
  await using screen = await render(<ProjectActionsSettings />);
  await expect.element(screen.getByText("Prepare checkout", { exact: true })).toBeVisible();
  expect(screen.container.textContent).not.toContain("Second setup");
});
