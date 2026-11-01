import { DEFAULT_SERVER_SETTINGS, ProjectReadFileError, type ProjectScript } from "@goat/contracts";
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
    readFile: (request: { environmentId: string; input: { cwd: string; relativePath: string } }) =>
      `${request.environmentId}:${request.input.cwd}/${request.input.relativePath}`,
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (key: string | null) => {
    const entry = key ? mocks.files[key] : undefined;
    return {
      data: entry?.data ?? null,
      cause: entry?.cause ?? null,
      isPending: key !== null && entry === undefined,
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

/** Servers without allowMissing report an absent file only through the read error's cause. */
function missingOnOlderServer(path: string) {
  mocks.files[path] = {
    data: null,
    cause: new ProjectReadFileError({
      cwd: "/repo",
      relativePath: path.slice(path.lastIndexOf("/") + 1),
      failure: "operation_failed",
      operation: "realpath-target",
      cause: Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }),
    }),
  };
}

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
    goatFile("local:/repo/goat.json", setupFile);
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
    mocks.files["local:/repo/goat.json"] = {
      data: { contents: "", truncated: false, exists: false },
    };
    goatFile("local:/repo/t3.json", setupFile);
    render([member("local")], [environment("local", {})]);
    expect(container.textContent).toContain("Repository setup from t3.json");
  });

  it("falls back to t3.json and reports a missing file on a server that only returns ENOENT", () => {
    missingOnOlderServer("local:/repo/goat.json");
    goatFile("local:/repo/t3.json", setupFile);
    render([member("local")], [environment("local", {})]);
    expect(container.textContent).toContain("Repository setup from t3.json");

    missingOnOlderServer("local:/repo/t3.json");
    render([member("local")], [environment("local", {})]);
    expect(container.textContent).toContain("This checkout has no goat.json or t3.json.");
    expect(buttons("Turn off actions for this project")).toHaveLength(0);
  });

  it("reads each checkout's repository file from its own environment", () => {
    goatFile("local:/repo/goat.json", setupFile);
    mocks.files["remote:/repo/goat.json"] = {
      data: { contents: "", truncated: false, exists: false },
    };
    mocks.files["remote:/repo/t3.json"] = {
      data: { contents: "", truncated: false, exists: false },
    };
    render(
      [member("local"), member("remote")],
      [environment("local", {}), environment("remote", {})],
    );
    expect(container.textContent).toContain("Repository setup from goat.json");
    expect(container.textContent).toContain("This checkout has no goat.json or t3.json.");
    expect(buttons("Turn off actions for this project")).toHaveLength(1);
  });

  it("ignores repository actions when goat.json is invalid, even with a valid t3.json", () => {
    mocks.files["local:/repo/goat.json"] = {
      data: { contents: "{", truncated: false, exists: true },
    };
    goatFile("local:/repo/t3.json", setupFile);
    render([member("local")], [environment("local", {})]);
    expect(container.textContent).toContain("goat.json is invalid");
    expect(container.textContent).not.toContain("Install");
    expect(buttons("Turn off actions for this project")).toHaveLength(0);
  });

  it("does not read repository files without filesystem read access", () => {
    mocks.readScope = new Set();
    goatFile("local:/repo/goat.json", setupFile);
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
