import { DEFAULT_SERVER_SETTINGS, type ProjectScript } from "@goat/contracts";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { Children, mocks } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    updateSettings: vi.fn(),
    alert: vi.fn(),
    writeScope: new Set<string>(),
    readScope: new Set<string>(),
    files: {} as Record<string, { data: unknown; cause?: unknown }>,
  },
}));

vi.mock("react-native", () => ({ View: Children }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: mocks.alert }));
vi.mock("./components/SettingsSection", () => ({ SettingsSection: Children }));
vi.mock("./components/SettingsActionRow", () => ({
  SettingsActionRow: (props: {
    label: string;
    description?: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button disabled={props.disabled} aria-description={props.description} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { updateSettings: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.updateSettings }));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    scope === "settings:write" && mocks.writeScope.has(environmentId),
  useEnvironmentScope: (environmentId: string, scope: string) =>
    (scope === "settings:write" ? mocks.writeScope : mocks.readScope).has(environmentId),
}));
vi.mock("../../state/projects", () => ({
  projectEnvironment: {
    readFile: (request: { input: { cwd: string; relativePath: string } }) => request.input,
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (input: { cwd: string; relativePath: string } | null) => {
    const entry = input ? mocks.files[`${input.cwd}/${input.relativePath}`] : undefined;
    return {
      data: entry?.data ?? null,
      cause: entry?.cause ?? null,
      isPending: input !== null && entry === undefined,
    };
  },
}));

import { ProjectActionsSettings } from "./ProjectActionsSettings";

const lint: ProjectScript = {
  id: "lint",
  name: "Lint",
  command: "vp lint",
  icon: "lint",
  runOnWorktreeCreate: false,
};

function environment(
  environmentId: string,
  // Plain project ids stand in for branded ProjectId keys.
  settings: Record<string, unknown>,
  projectSettingsOverrides = true,
) {
  return {
    environmentId,
    label: environmentId === "local" ? "Local" : "Remote",
    connection: { phase: "connected" },
    serverConfig: {
      settings: { ...DEFAULT_SERVER_SETTINGS, projectSettingsFolded: true, ...settings },
      environment: { capabilities: { projectSettingsOverrides } },
    },
  } as never;
}

function member(environmentId: string, id = "project", workspaceRoot = "/repo") {
  return { environmentId, id, workspaceRoot, scripts: [], title: "Repo" } as never;
}

function goatFile(path: string, scripts: readonly object[]) {
  mocks.files[path] = {
    data: { contents: JSON.stringify({ scripts }), truncated: false, exists: true },
  };
}

const setupFile = [{ name: "Install", command: "vp i", runOnWorktreeCreate: true }];

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  mocks.writeScope = new Set(["local", "remote"]);
  mocks.readScope = new Set(["local", "remote"]);
  mocks.files = {};
  mocks.alert.mockReset();
  mocks.updateSettings.mockReset();
  mocks.updateSettings.mockResolvedValue(AsyncResult.success(undefined));
});

afterEach(() => {
  act(() => root.unmount());
});

function render(members: readonly never[], environments: readonly never[]) {
  act(() => root.render(<ProjectActionsSettings members={members} environments={environments} />));
}

function buttons(label: string) {
  return Array.from(container.querySelectorAll("button")).filter(
    (element) => element.textContent === label,
  );
}

function button(label: string) {
  const [result] = buttons(label);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}

describe("ProjectActionsSettings", () => {
  it("turns off inherited actions with an empty override and restores inheritance, keeping other project overrides", async () => {
    const overrides = { project: { defaultAutoPull: true } };
    render(
      [member("local")],
      [
        environment("local", {
          defaultProjectScripts: [lint],
          projectSettingsOverrides: overrides,
        }),
      ],
    );
    expect(container.textContent).toContain("Lint");
    expect(container.textContent).toContain("Inherited from environment defaults");

    await act(async () => button("Turn off actions for this project").click());
    expect(mocks.updateSettings).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: {
        patch: {
          projectSettingsOverrides: {
            project: { defaultAutoPull: true, defaultProjectScripts: [] },
          },
        },
      },
    });

    render(
      [member("local")],
      [
        environment("local", {
          defaultProjectScripts: [lint],
          projectSettingsOverrides: {
            project: { defaultAutoPull: true, defaultProjectScripts: [] },
          },
        }),
      ],
    );
    expect(container.textContent).toContain("Actions are turned off for this project.");
    expect(container.textContent).not.toContain("vp lint");

    await act(async () => button("Use inherited actions").click());
    expect(mocks.updateSettings).toHaveBeenLastCalledWith({
      environmentId: "local",
      input: { patch: { projectSettingsOverrides: { project: { defaultAutoPull: true } } } },
    });
  });

  it("removes the whole override record when the empty action list was its only key", async () => {
    render(
      [member("local")],
      [
        environment("local", {
          projectSettingsOverrides: { project: { defaultProjectScripts: [] } },
        }),
      ],
    );
    await act(async () => button("Use inherited actions").click());
    expect(mocks.updateSettings).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: { patch: { projectSettingsOverrides: { project: null } } },
    });
  });

  it("labels a legacy null override as inherited and lets it be turned off", async () => {
    render(
      [member("local")],
      [
        environment("local", {
          projectSettingsFolded: false,
          projectScriptOverrides: { project: null },
          defaultProjectScripts: [lint],
        }),
      ],
    );
    expect(container.textContent).toContain("Inherited from environment defaults");
    await act(async () => button("Turn off actions for this project").click());
    expect(mocks.updateSettings).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: { patch: { projectSettingsOverrides: { project: { defaultProjectScripts: [] } } } },
    });
  });

  it("shows repository setup from goat.json for an unconfigured project and turns it off", async () => {
    goatFile("/repo/goat.json", setupFile);
    render([member("local")], [environment("local", {})]);
    expect(container.textContent).toContain("Install (setup)");
    expect(container.textContent).toContain("Repository setup from goat.json");

    await act(async () => button("Turn off actions for this project").click());
    expect(mocks.updateSettings).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: { patch: { projectSettingsOverrides: { project: { defaultProjectScripts: [] } } } },
    });
  });

  it("reads t3.json only when goat.json is absent", () => {
    mocks.files["/repo/goat.json"] = {
      data: { contents: "", truncated: false, exists: false },
    };
    goatFile("/repo/t3.json", setupFile);
    render([member("local")], [environment("local", {})]);
    expect(container.textContent).toContain("Repository setup from t3.json");
  });

  it("ignores repository actions when goat.json is invalid, even with a valid t3.json", () => {
    mocks.files["/repo/goat.json"] = { data: { contents: "{", truncated: false, exists: true } };
    goatFile("/repo/t3.json", setupFile);
    render([member("local")], [environment("local", {})]);
    expect(container.textContent).toContain("goat.json is invalid");
    expect(container.textContent).not.toContain("Install");
    expect(buttons("Turn off actions for this project")).toHaveLength(0);
  });

  it("does not read repository files without filesystem read access", () => {
    mocks.readScope = new Set();
    goatFile("/repo/goat.json", setupFile);
    render([member("local")], [environment("local", {})]);
    expect(container.textContent).toContain("cannot read this checkout's repository actions");
    expect(container.textContent).not.toContain("Install");
  });

  it("writes only the checkout whose action was turned off", async () => {
    const overrides = { other: { defaultAutoPull: true } };
    render(
      [member("local", "project", "/repo"), member("local", "other", "/repo-2")],
      [
        environment("local", {
          defaultProjectScripts: [lint],
          projectSettingsOverrides: overrides,
        }),
      ],
    );
    expect(container.textContent).toContain("/repo-2");
    const [, secondCheckout] = buttons("Turn off actions for this project");
    await act(async () => secondCheckout!.click());
    expect(mocks.updateSettings).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: {
        patch: {
          projectSettingsOverrides: { other: { defaultAutoPull: true, defaultProjectScripts: [] } },
        },
      },
    });
  });

  it("never writes to an environment outside the selected members", async () => {
    render(
      [member("remote")],
      [
        environment("local", { defaultProjectScripts: [lint] }),
        environment("remote", { defaultProjectScripts: [lint] }),
      ],
    );
    await act(async () => button("Turn off actions for this project").click());
    expect(mocks.updateSettings).toHaveBeenCalledOnce();
    expect(mocks.updateSettings.mock.calls[0]![0].environmentId).toBe("remote");
  });

  it("refuses to write without the settings write permission", async () => {
    mocks.writeScope = new Set();
    render([member("local")], [environment("local", { defaultProjectScripts: [lint] })]);
    const turnOff = button("Turn off actions for this project");
    expect(turnOff.disabled).toBe(true);
    expect(turnOff.getAttribute("aria-description")).toBe(
      "This connection cannot change environment settings.",
    );
    await act(async () => turnOff.click());
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it("refuses to write to a server without project overrides", async () => {
    render([member("local")], [environment("local", { defaultProjectScripts: [lint] }, false)]);
    const turnOff = button("Turn off actions for this project");
    expect(turnOff.disabled).toBe(true);
    expect(turnOff.getAttribute("aria-description")).toBe(
      "Update this environment's server to change project actions.",
    );
    await act(async () => turnOff.click());
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });
});
