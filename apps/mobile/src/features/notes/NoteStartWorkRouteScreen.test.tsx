import type { ComponentProps, ReactNode } from "react";
import { act, useInsertionEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { RegistryContext } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import type { MenuProps } from "../../components/ui/Menu.types";
import { ProviderInstanceId } from "@goat/contracts";
import type { AtomCommandResult } from "@goat/client-runtime/state/runtime";
import type { ModelOption } from "../../lib/modelOptions";
import * as Cause from "effect/Cause";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    models: [] as ModelOption[],
    guarded: false,
    dismissed: vi.fn(),
    blocked: vi.fn(),
    start: vi.fn(),
    targets: vi.fn<(target: unknown) => Promise<AtomCommandResult<unknown, unknown>>>(),
    projects: vi.fn<(target: unknown) => Promise<AtomCommandResult<unknown, unknown>>>(),
  },
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("react-native", () => ({ View: Children }));
vi.mock("@react-navigation/native", () => {
  const navigation = {
    goBack: () => {
      if (mocks.guarded) mocks.blocked();
      else mocks.dismissed();
    },
  };
  return {
    useNavigation: () => navigation,
    // The installed hook registers its synchronous removal guard in an insertion effect.
    usePreventRemove: (enabled: boolean) =>
      useInsertionEffect(() => {
        mocks.guarded = enabled;
        return () => {
          mocks.guarded = false;
        };
      }, [enabled]),
  };
});
vi.mock("../../components/ui/AppBar", () => ({
  AppBar: ({ onBack }: { onBack: () => void }) => <button onClick={onBack}>Back</button>,
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../state/entities", () => ({ useEnvironmentServerConfig: () => null }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => crypto.randomUUID() }));
vi.mock("../../lib/modelOptions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/modelOptions")>()),
  buildModelOptions: () => mocks.models,
}));
vi.mock("../../components/ui/Menu", () => ({
  Menu: ({ actions, children, onPressAction, accessibilityLabel }: MenuProps) => (
    <>
      {children}
      <select
        aria-label={accessibilityLabel}
        onChange={(event) => onPressAction?.({ nativeEvent: { event: event.target.value } })}
      >
        {actions
          .flatMap((action) => action.subactions ?? [action])
          .map((action) => (
            <option key={action.id} value={action.id} disabled={action.attributes?.disabled}>
              {action.title}
            </option>
          ))}
      </select>
    </>
  ),
}));
vi.mock("./rpc/queries", () => {
  const query = (run: typeof mocks.targets) => {
    const family = Atom.family((key: string) =>
      Atom.make(
        Effect.promise(() => run(JSON.parse(key))).pipe(
          Effect.flatMap((result) =>
            result._tag === "Success"
              ? Effect.succeed(result.value)
              : Effect.failCause(result.cause),
          ),
        ),
      ),
    );
    return (target: unknown) => family(JSON.stringify(target));
  };
  return {
    notesQueries: {
      workTargets: query(mocks.targets),
      workTargetProjects: query(mocks.projects),
    },
  };
});
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: {
    label: string;
    disabled?: boolean;
    selected?: boolean;
    onPress: () => void;
  }) => (
    <button disabled={props.disabled} aria-pressed={props.selected} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("./notes-state", () => ({
  notesCommandOptions: {},
  notesError: String,
  useNotesPermissions: () => true,
}));
vi.mock("./rpc/notes", () => ({
  notesRpc: {
    workTargets: mocks.targets,
    workTargetProjects: mocks.projects,
    startWork: mocks.start,
  },
}));

import { NoteStartWorkRouteScreen } from "./NoteStartWorkRouteScreen";

let registry: AtomRegistry.AtomRegistry;
let root: Root;
let container: HTMLDivElement;
let nextPath = 0;
function button(label: string) {
  const found = Array.from(container.querySelectorAll("button")).find(
    (entry) => entry.textContent === label || entry.textContent === `${label} · Selected`,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function selectMenu(label: string, value: string) {
  const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function render() {
  const props = {
    route: { params: { environmentId: "hub", path: `launch-${nextPath++}.md` } },
  } satisfies ComponentProps<typeof NoteStartWorkRouteScreen>;
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <NoteStartWorkRouteScreen {...props} />
      </RegistryContext.Provider>,
    ),
  );
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  registry = AtomRegistry.make();
  mocks.models = [];
  container = document.createElement("div");
  root = createRoot(container);
  mocks.guarded = false;
  mocks.dismissed.mockReset();
  mocks.blocked.mockReset();
  mocks.start.mockReset();
  mocks.projects.mockReset();
  mocks.targets.mockReset().mockResolvedValue(
    AsyncResult.success({
      hub: { projects: [{ projectId: "project", title: "Project" }] },
      hosts: [],
    }),
  );
});
afterEach(() => {
  act(() => root.unmount());
  registry.dispose();
});

describe("start work completion navigation", () => {
  it("blocks back while launching and dismisses after success disables the committed guard", async () => {
    const result = Promise.withResolvers<ReturnType<typeof AsyncResult.success<object>>>();
    mocks.start.mockReturnValue(result.promise);
    await render();
    act(() => button("Start work").click());
    act(() => button("Back").click());
    expect(mocks.blocked).toHaveBeenCalledOnce();
    expect(mocks.dismissed).not.toHaveBeenCalled();
    await act(async () => result.resolve(AsyncResult.success({})));
    expect(mocks.dismissed).toHaveBeenCalledOnce();
    expect(mocks.blocked).toHaveBeenCalledOnce();
    expect(mocks.start).toHaveBeenCalledOnce();
  });

  it("keeps a failed launch open and reuses its request on a successful retry", async () => {
    mocks.start
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("offline"))))
      .mockResolvedValueOnce(AsyncResult.success({}));
    await render();
    await act(async () => button("Start work").click());
    expect(mocks.dismissed).not.toHaveBeenCalled();
    expect(mocks.guarded).toBe(false);
    await act(async () => button("Retry this attempt").click());
    expect(mocks.start.mock.calls[1]).toEqual(mocks.start.mock.calls[0]);
    expect(mocks.dismissed).toHaveBeenCalledOnce();
    expect(mocks.blocked).not.toHaveBeenCalled();
  });

  it("releases the navigation guard after a rejected launch and retries the captured request", async () => {
    const result = Promise.withResolvers<ReturnType<typeof AsyncResult.success<object>>>();
    mocks.start.mockReturnValueOnce(result.promise).mockResolvedValueOnce(AsyncResult.success({}));
    await render();
    act(() => button("Start work").click());
    expect(mocks.guarded).toBe(true);
    expect(button("Starting…").disabled).toBe(true);

    await act(async () => result.reject(new Error("Connection lost")));
    expect(container.textContent).toContain("Connection lost");
    expect(mocks.guarded).toBe(false);
    expect(mocks.dismissed).not.toHaveBeenCalled();
    expect(button("Retry this attempt").disabled).toBe(false);

    await act(async () => button("Retry this attempt").click());
    expect(mocks.start.mock.calls[1]).toEqual(mocks.start.mock.calls[0]);
    expect(mocks.dismissed).toHaveBeenCalledOnce();
    expect(mocks.blocked).not.toHaveBeenCalled();
  });
});

describe("start work node selection", () => {
  const remote = { host: "remote", label: "Remote host" };
  const projects = { projects: [{ path: "/remote/project", title: "Remote project" }] };
  beforeEach(() => {
    mocks.targets.mockResolvedValue(
      AsyncResult.success({
        hub: { projects: [{ projectId: "project", title: "Project" }] },
        hosts: [remote],
      }),
    );
    mocks.start.mockResolvedValue(AsyncResult.success({}));
  });

  it("keeps the selected remote project launchable when reselecting the current host", async () => {
    mocks.projects.mockResolvedValue(AsyncResult.success(projects));
    await render();
    await selectMenu("Node", "host:remote");
    await selectMenu("Node", "host:remote");
    expect(mocks.projects).toHaveBeenCalledOnce();
    expect(button("Start work").disabled).toBe(false);
    expect(container.textContent).not.toContain("Loading projects…");
    await act(async () => button("Start work").click());
    expect(mocks.start).toHaveBeenCalledWith({
      environmentId: "hub",
      input: expect.objectContaining({
        target: { type: "host", host: "remote", projectPath: "/remote/project" },
      }),
    });
  });

  it("can launch on the hub after leaving a remote host with projects still loading", async () => {
    const result = Promise.withResolvers<ReturnType<typeof AsyncResult.success<typeof projects>>>();
    mocks.projects.mockReturnValue(result.promise);
    await render();
    await selectMenu("Node", "host:remote");
    expect(button("Start work").disabled).toBe(true);
    expect(container.textContent).toContain("Loading projects…");
    await selectMenu("Node", "this-hub");
    expect(button("Start work").disabled).toBe(false);
    expect(container.textContent).not.toContain("Loading projects…");
    await act(async () => result.resolve(AsyncResult.success(projects)));
    expect(button("Start work").disabled).toBe(false);
    await act(async () => button("Start work").click());
    expect(mocks.start).toHaveBeenCalledWith({
      environmentId: "hub",
      input: expect.objectContaining({ target: { type: "hub", projectId: "project" } }),
    });
  });
});

describe("start work target query states", () => {
  it("shows loading and keeps Start work disabled until hub targets settle", async () => {
    const result = Promise.withResolvers<ReturnType<typeof AsyncResult.success<object>>>();
    mocks.targets.mockReturnValue(result.promise);
    await render();
    expect(container.textContent).toContain("Loading projects…");
    expect(button("Start work").disabled).toBe(true);
    await act(async () =>
      result.resolve(
        AsyncResult.success({
          hub: {
            projects: [
              { projectId: "demo", title: "Demo" },
              { projectId: "server", title: "Server" },
            ],
          },
          hosts: [],
        }),
      ),
    );
    expect(container.textContent).not.toContain("Loading projects…");
    expect(button("Demo")).toBeDefined();
    expect(button("Server")).toBeDefined();
    expect(button("Start work").disabled).toBe(false);
  });

  it("shows an error and reloads hub targets instead of leaving Project blank", async () => {
    mocks.targets.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("Hub unavailable"))),
    );
    await render();
    expect(container.textContent).toContain("Hub unavailable");
    expect(button("Start work").disabled).toBe(true);
    await act(async () => button("Reload targets").click());
    expect(mocks.targets).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("Hub unavailable");
    expect(button("Project")).toBeDefined();
    expect(button("Start work").disabled).toBe(false);
  });

  it("disables launch while Reload refreshes a previously successful target list", async () => {
    const result = Promise.withResolvers<ReturnType<typeof AsyncResult.success<object>>>();
    await render();
    expect(button("Start work").disabled).toBe(false);
    mocks.targets.mockReturnValueOnce(result.promise);
    await act(async () => button("Reload targets").click());
    expect(container.textContent).not.toContain("Loading projects…");
    expect(button("Project")).toBeDefined();
    expect(button("Start work").disabled).toBe(true);
    await act(async () =>
      result.resolve(AsyncResult.success({ hub: { projects: [] }, hosts: [] })),
    );
    expect(container.textContent).toContain("No projects available on this node.");
    expect(button("Start work").disabled).toBe(true);
    expect(container.textContent).not.toContain("Loading projects…");
  });

  it("shows the empty state only after a successful empty targets response", async () => {
    mocks.targets.mockResolvedValue(AsyncResult.success({ hub: { projects: [] }, hosts: [] }));
    await render();
    expect(container.textContent).toContain("No projects available on this node.");
    expect(container.textContent).not.toContain("Loading projects…");
    expect(button("Start work").disabled).toBe(true);
  });
});

describe("compact start work model picker", () => {
  beforeEach(() => {
    mocks.models = Array.from({ length: 60 }, (_, index) => ({
      key: `model-${index}`,
      label: `Model ${index}`,
      subtitle: "",
      providerKey: "codex",
      providerLabel: "Codex",
      providerDriver: "codex",
      isDefault: index === 0,
      isLegacy: false,
      isUnavailable: index === 59,
      capabilities: null,
      selection: { instanceId: ProviderInstanceId.make("codex"), model: `model-${index}` },
    }));
    mocks.start.mockResolvedValue(AsyncResult.success({}));
  });
  async function selectModel(key: string) {
    await selectMenu("Model", key);
  }

  it("keeps 60 models in the picker and launches with the selected model", async () => {
    await render();
    expect(button("Hub default")).toBeDefined();
    expect(
      Array.from(container.querySelectorAll("button")).some((entry) =>
        entry.textContent?.startsWith("Codex ·"),
      ),
    ).toBe(false);
    expect(button("Start work").disabled).toBe(false);
    await selectModel("model-3");
    expect(button("Codex · Model 3")).toBeDefined();
    await act(async () => button("Start work").click());
    expect(mocks.start.mock.calls[0]![0].input.modelSelection).toEqual(mocks.models[3]!.selection);
  });

  it("returns to Hub default and omits a model override from the launch", async () => {
    await render();
    await selectModel("model-2");
    await selectModel("hub-default");
    expect(button("Hub default")).toBeDefined();
    await act(async () => button("Start work").click());
    expect(mocks.start.mock.calls[0]![0].input).not.toHaveProperty("modelSelection");
  });

  it("rejects unavailable models and freezes the chosen model across a failed attempt", async () => {
    mocks.start.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("offline"))));
    await render();
    await selectModel("model-59");
    expect(button("Hub default")).toBeDefined();
    await selectModel("model-1");
    await act(async () => button("Start work").click());
    expect(button("Codex · Model 1").disabled).toBe(true);
    await selectModel("model-2");
    expect(button("Codex · Model 1")).toBeDefined();
    await act(async () => button("Retry this attempt").click());
    expect(mocks.start.mock.calls[1]).toEqual(mocks.start.mock.calls[0]);
  });
});

describe("remote start work target errors", () => {
  it("surfaces a rejected remote lookup and reloads it without a blank Project section", async () => {
    mocks.targets.mockResolvedValue(
      AsyncResult.success({
        hub: { projects: [{ projectId: "project", title: "Project" }] },
        hosts: [{ host: "remote", label: "Remote host" }],
      }),
    );
    mocks.projects
      .mockRejectedValueOnce(new Error("Remote unavailable"))
      .mockResolvedValue(
        AsyncResult.success({ projects: [{ path: "/project", title: "Remote project" }] }),
      );
    await render();
    await selectMenu("Node", "host:remote");
    expect(container.textContent).toContain("Remote unavailable");
    expect(button("Start work").disabled).toBe(true);
    await act(async () => button("Reload targets").click());
    expect(mocks.projects).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("Remote unavailable");
    expect(button("Remote project")).toBeDefined();
    expect(button("Start work").disabled).toBe(false);
  });
});

describe("captured start work discovery recovery", () => {
  it("reloads targets after a failed launch without losing the captured payload or requestId", async () => {
    mocks.start
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("offline"))))
      .mockResolvedValueOnce(AsyncResult.success({}));
    await render();
    await act(async () => button("Start work").click());
    mocks.targets.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("discovery offline"))),
    );
    await act(async () => button("Reload targets").click());
    expect(mocks.targets).toHaveBeenCalledTimes(2);
    expect(button("Retry this attempt").disabled).toBe(false);
    await act(async () => button("Retry this attempt").click());
    expect(mocks.start.mock.calls[1]).toEqual(mocks.start.mock.calls[0]);
    expect(mocks.dismissed).toHaveBeenCalledOnce();
  });

  it("refreshes a captured remote target without changing its project or requestId", async () => {
    mocks.targets.mockResolvedValue(
      AsyncResult.success({
        hub: { projects: [{ projectId: "project", title: "Project" }] },
        hosts: [{ host: "remote", label: "Remote host", kind: "ssh" }],
      }),
    );
    mocks.projects.mockResolvedValueOnce(
      AsyncResult.success({
        projects: [{ path: "/original", title: "Original project" }],
      }),
    );
    mocks.start
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("offline"))))
      .mockResolvedValueOnce(AsyncResult.success({}));
    await render();
    await selectMenu("Node", "host:remote");
    expect(button("Original project").getAttribute("aria-pressed")).toBe("true");
    await act(async () => button("Start work").click());
    mocks.projects.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("remote discovery offline"))),
    );
    await act(async () => button("Reload targets").click());
    expect(mocks.projects).toHaveBeenCalledTimes(2);
    expect(button("Retry this attempt").disabled).toBe(false);
    await selectMenu("Node", "this-hub");
    expect(button("Remote host").disabled).toBe(true);
    mocks.projects.mockResolvedValueOnce(
      AsyncResult.success({
        projects: [{ path: "/replacement", title: "Replacement project" }],
      }),
    );
    await act(async () => button("Reload targets").click());
    expect(button("Replacement project").getAttribute("aria-pressed")).toBe("false");
    await act(async () => button("Retry this attempt").click());
    expect(mocks.start.mock.calls[1]).toEqual(mocks.start.mock.calls[0]);
    expect(mocks.start.mock.calls[1]![0].input.target).toEqual({
      type: "host",
      host: "remote",
      projectPath: "/original",
    });
  });

  it("keeps an ambiguous attempt blocked after target refresh and only resets on Start again", async () => {
    mocks.start
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail({ reason: "launch_ambiguous" })))
      .mockResolvedValueOnce(AsyncResult.success({}));
    await render();
    await act(async () => button("Start work").click());
    await act(async () => button("Reload targets").click());
    expect(button("Retry this attempt").disabled).toBe(true);
    await act(async () => button("Retry this attempt").click());
    expect(mocks.start).toHaveBeenCalledOnce();
    await act(async () => button("Start again").click());
    await act(async () => button("Start work").click());
    expect(mocks.start).toHaveBeenCalledTimes(2);
    expect(mocks.start.mock.calls[1]![0].input.requestId).not.toBe(
      mocks.start.mock.calls[0]![0].input.requestId,
    );
  });
});

describe("compact start work node picker", () => {
  it("keeps 40 SSH aliases in a menu after linked hosts and launches the chosen node", async () => {
    mocks.targets.mockResolvedValue(
      AsyncResult.success({
        hub: { projects: [{ projectId: "project", title: "Project" }] },
        hosts: [
          ...Array.from({ length: 40 }, (_, index) => ({
            host: `ssh-${index}`,
            label: `SSH ${index}`,
            kind: "ssh",
          })),
          { host: "linked", label: "Linked host", kind: "linked" },
        ],
      }),
    );
    mocks.projects.mockResolvedValue(
      AsyncResult.success({ projects: [{ path: "/linked", title: "Linked project" }] }),
    );
    mocks.start.mockResolvedValue(AsyncResult.success({}));
    await render();
    expect(button("This hub")).toBeDefined();
    expect(
      Array.from(container.querySelectorAll("button")).some((entry) =>
        entry.textContent?.startsWith("SSH "),
      ),
    ).toBe(false);
    const choices = container.querySelectorAll('select[aria-label="Node"] option');
    expect(choices).toHaveLength(42);
    expect(choices[1]?.textContent).toBe("Linked host");
    await selectMenu("Node", "host:linked");
    expect(button("Linked host")).toBeDefined();
    await act(async () => button("Start work").click());
    expect(mocks.start.mock.calls[0]![0].input.target).toEqual({
      type: "host",
      host: "linked",
      projectPath: "/linked",
    });
  });
});

describe("start work project selection", () => {
  it("marks the first hub project selected, then moves the visible and accessible selection on press", async () => {
    mocks.targets.mockResolvedValue(
      AsyncResult.success({
        hub: {
          projects: [
            { projectId: "first", title: "First" },
            { projectId: "second", title: "Second" },
          ],
        },
        hosts: [],
      }),
    );
    mocks.start.mockResolvedValue(AsyncResult.success({}));
    await render();
    expect(button("First").textContent).toBe("First · Selected");
    expect(button("First").getAttribute("aria-pressed")).toBe("true");
    expect(button("Second").getAttribute("aria-pressed")).toBe("false");
    await act(async () => button("Second").click());
    expect(button("First").textContent).toBe("First");
    expect(button("First").getAttribute("aria-pressed")).toBe("false");
    expect(button("Second").textContent).toBe("Second · Selected");
    expect(button("Second").getAttribute("aria-pressed")).toBe("true");
    await act(async () => button("Start work").click());
    expect(mocks.start.mock.calls[0]![0].input.target).toEqual({
      type: "hub",
      projectId: "second",
    });
  });
});
