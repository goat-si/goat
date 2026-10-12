// @vitest-environment jsdom

import { EnvironmentId, ProjectId, ThreadId } from "@goat/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  worktreePath: "/tmp/worktree" as string | null,
  serverThread: true,
  faultInjection: false,
  realBranch: false,
  showContextMenu: vi.fn().mockResolvedValue("copy-path"),
  writeTextToClipboard: vi.fn().mockResolvedValue(true),
}));

vi.mock("../localApi", () => ({
  readLocalApi: () => ({ contextMenu: { show: state.showContextMenu } }),
}));
vi.mock("../hooks/useCopyToClipboard", () => ({
  writeTextToClipboard: state.writeTextToClipboard,
}));
vi.mock("./BranchToolbarBranchSelector", async (original) => {
  const actual = await original<typeof import("./BranchToolbarBranchSelector")>();
  return {
    BranchToolbarBranchSelector: (
      props: React.ComponentProps<typeof actual.BranchToolbarBranchSelector>,
    ) => (state.realBranch ? <actual.BranchToolbarBranchSelector {...props} /> : null),
  };
});
vi.mock("../state/session", async (original) => ({
  ...(await original<typeof import("../state/session")>()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({ data: { refName: "main", refs: [] }, isPending: false }),
}));
vi.mock("./ThreadStatusIndicators", async (original) => ({
  ...(await original<typeof import("./ThreadStatusIndicators")>()),
  useLinkedThreadPullRequest: () => null,
}));
vi.mock("../lib/openPullRequestLink", () => ({ useOpenPrLink: () => vi.fn() }));
vi.mock("../state/queries", () => ({
  usePaginatedBranches: () => ({
    refs: [{ name: "main", isDefault: true }],
    data: { nextCursor: null },
    isPending: false,
  }),
}));
vi.mock("../state/entities", () => ({
  useThreadShell: () =>
    state.serverThread
      ? {
          environmentId: "local",
          projectId: "project",
          worktreePath: state.worktreePath,
        }
      : null,
  useProject: () => ({ id: "source", workspaceRoot: "/tmp/project" }),
  useServerConfigs: () => new Map(),
  useThreadShellsForProjectRefs: () => [],
}));

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { scopeProjectRef } from "@goat/client-runtime/environment";
import { BranchToolbarEnvModeSelector } from "./BranchToolbarEnvModeSelector";
import { BranchToolbar } from "./BranchToolbar";

it("keeps machine choices usable when the combined row's workspace is locked", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onEnvironmentChange = vi.fn();
  try {
    await act(async () => {
      root.render(
        <BranchToolbar
          layout="panel"
          panelSection="workspace"
          environmentId={EnvironmentId.make("local")}
          threadId={ThreadId.make("thread")}
          showGitControls
          envMode="local"
          envLocked={false}
          startFromOrigin={false}
          onStartFromOriginChange={vi.fn()}
          onEnvModeChange={vi.fn()}
          onEnvironmentChange={onEnvironmentChange}
          availableEnvironments={["local", "remote"].map((id) => ({
            environmentId: EnvironmentId.make(id),
            projectId: ProjectId.make("project"),
            label: id,
            isPrimary: id === "local",
            machine: "server",
          }))}
        />,
      );
    });
    const trigger = container.querySelector("button")!;
    expect(trigger.textContent).toBe("Worktree");
    expect(container.querySelectorAll("button")).toHaveLength(1);
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, ctrlKey: true }));
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await act(async () => trigger.click());
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    expect(
      items.find((item) => item.textContent === "New worktree")?.getAttribute("aria-disabled"),
    ).toBe("true");
    await act(async () => items.find((item) => item.textContent === "remote")!.click());
    expect(onEnvironmentChange).toHaveBeenCalledWith("remote");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it.each([
  ["local", null, "/tmp/project"],
  ["worktree", null, null],
  ["worktree", "/tmp/worktree", "/tmp/worktree"],
] as const)(
  "copies only an existing workspace path with mode %s and worktree %s",
  async (envMode, worktreePath, copiedPath) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.worktreePath = worktreePath;
    state.showContextMenu.mockClear();
    state.writeTextToClipboard.mockClear();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <BranchToolbar
            layout="panel"
            panelSection="workspace"
            environmentId={EnvironmentId.make("local")}
            threadId={ThreadId.make("thread")}
            showGitControls
            envMode={envMode}
            envLocked={false}
            startFromOrigin={false}
            onStartFromOriginChange={vi.fn()}
            onEnvModeChange={vi.fn()}
          />,
        );
      });
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      await act(async () => {
        container.querySelector('[aria-label="Run context"]')!.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(copiedPath !== null);
      if (copiedPath === null) {
        expect(state.showContextMenu).not.toHaveBeenCalled();
        expect(state.writeTextToClipboard).not.toHaveBeenCalled();
      } else {
        expect(state.writeTextToClipboard).toHaveBeenCalledWith(copiedPath, "workspace path");
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
      state.worktreePath = "/tmp/worktree";
      vi.unstubAllGlobals();
    }
  },
);

beforeEach(() => {
  Object.defineProperty(document, "fonts", { configurable: true, value: new EventTarget() });
  state.serverThread = true;
  state.realBranch = false;
  state.worktreePath = "/tmp/worktree";
  state.faultInjection = false;
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
});

it.each(["composer", "panel", "wide"] as const)(
  "shows workspace modes and retires the old option in %s",
  async (layout) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.serverThread = false;
    const draftId = DraftId.make("panel-draft");
    const projectRef = scopeProjectRef(EnvironmentId.make("remote"), ProjectId.make("project"));
    useComposerDraftStore
      .getState()
      .setLogicalProjectDraftThreadId("project", projectRef, draftId, {
        threadId: ThreadId.make("thread"),
        envMode: "local",
      });
    // An existing tree remains in the store; it must not create a third choice.
    useComposerDraftStore
      .getState()
      .setLogicalProjectDraftThreadId("recent", projectRef, DraftId.make("recent"), {
        threadId: ThreadId.make("recent-thread"),
        envMode: "worktree",
        worktreePath: "/recent/wt",
      });
    const environments = ["local", "remote"].map((id) => ({
      environmentId: EnvironmentId.make(id),
      projectId: ProjectId.make("project"),
      label: id === "remote" ? "Build host" : "This device",
      isPrimary: id === "local",
      machine: "server" as const,
    }));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onEnvModeChange = (envMode: "local" | "worktree") =>
      useComposerDraftStore.getState().setDraftThreadContext(draftId, { envMode });
    const render = async () =>
      act(async () => {
        const envMode = useComposerDraftStore.getState().getDraftSession(draftId)!.envMode;
        root.render(
          <div className="group/composer-context" data-compact="">
            {layout === "wide" ? (
              <BranchToolbarEnvModeSelector
                envLocked={false}
                effectiveEnvMode={envMode}
                activeWorktreePath={null}
                activeEnvironment={environments[1]!}
                onEnvModeChange={onEnvModeChange}
              />
            ) : (
              <BranchToolbar
                layout={layout}
                panelSection="workspace"
                draftId={draftId}
                environmentId={projectRef.environmentId}
                threadId={ThreadId.make("thread")}
                showGitControls
                envMode={envMode}
                envLocked={false}
                startFromOrigin={false}
                onStartFromOriginChange={vi.fn()}
                onEnvModeChange={onEnvModeChange}
                availableEnvironments={environments}
                onEnvironmentChange={vi.fn()}
                autoEnvironmentLabel="Auto balance"
                onAutoEnvironment={vi.fn()}
              />
            )}
          </div>,
        );
      });
    try {
      await render();
      const trigger = () =>
        layout === "wide"
          ? container.querySelector<HTMLButtonElement>('[aria-label="Workspace"]')!
          : container.querySelector<HTMLButtonElement>(
              layout === "panel"
                ? '[aria-label="Run context"]'
                : '[data-composer-shortcut*="composer.workspace"]',
            )!;
      expect(trigger().textContent).toContain("Local · Build host");
      const label = trigger().querySelector("[data-composer-label]")!;
      expect(label.textContent).toBe("Local · Build host");
      expect(label.className).not.toContain("max-w-0");
      expect(label.querySelector("[data-composer-label-motion]")!.className).not.toContain(
        "opacity-0",
      );
      for (const [choice, mode] of [
        ["New worktree", "worktree"],
        ["Local", "local"],
      ] as const) {
        await act(async () => trigger().click());
        const items = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
        expect(items.some((item) => item.textContent?.includes("Previous worktree"))).toBe(false);
        const item = items.find((item) => item.textContent === choice)!;
        expect(item).toBeDefined();
        await act(async () => item.click());
        expect(useComposerDraftStore.getState().getDraftSession(draftId)?.envMode).toBe(mode);
        await render();
        expect(trigger().textContent).toContain(`${choice} · Build host`);
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  },
);

it.each([
  [false, "local", null, "Local · Build host"],
  [false, "worktree", "/existing", "Worktree · Build host"],
  [false, "worktree", null, "New worktree · Build host"],
  [true, "local", "/stale", "New worktree · Build host"],
] as const)(
  "labels locked wide mode with force=%s mode=%s path=%s",
  async (forceNewWorktree, effectiveEnvMode, activeWorktreePath, label) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <BranchToolbarEnvModeSelector
            forceNewWorktree={forceNewWorktree}
            envLocked
            effectiveEnvMode={effectiveEnvMode}
            activeWorktreePath={activeWorktreePath}
            activeEnvironment={{ isPrimary: false, label: "Build host" }}
            onEnvModeChange={vi.fn()}
          />,
        ),
      );
      expect(container.textContent).toBe(label);
      expect(container.querySelector("button")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  },
);

import { SshConnectionProfile } from "@goat/client-runtime/connection";
import type { SavedSshWorktreeOption } from "../lib/sshWorktree";
const sshOption: SavedSshWorktreeOption = {
  destination: { connectionId: "saved", environmentId: EnvironmentId.make("ssh") },
  profile: new SshConnectionProfile({
    connectionId: "saved",
    environmentId: EnvironmentId.make("ssh"),
    label: "Build host",
    target: { alias: "build", hostname: "build", username: null, port: null },
  }),
  label: "Build host",
  disabledReason: null,
};
it.each(
  (["composer", "panel", "wide"] as const).flatMap(
    (layout) =>
      [
        [layout, "mouse"],
        [layout, "keyboard"],
      ] as const,
  ),
)(
  "selects and clears saved SSH hosts through the right submenu in %s with %s",
  async (layout, activation) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.serverThread = false;
    const draftId = DraftId.make("ssh-menu");
    const source = scopeProjectRef(EnvironmentId.make("local"), ProjectId.make("source"));
    useComposerDraftStore.getState().setLogicalProjectDraftThreadId("source", source, draftId, {
      envMode: "worktree",
      threadId: ThreadId.make("source"),
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = async (
      options: SavedSshWorktreeOption[] = [sshOption],
      reason: string | null = null,
    ) =>
      act(async () => {
        const draft = useComposerDraftStore.getState().getDraftSession(draftId)!;
        const common = {
          sshDestination: draft.sshDestination ?? null,
          sshOptions: options,
          sshDisabledReason: reason,
          onSshDestinationChange: (sshDestination: typeof sshOption.destination) =>
            useComposerDraftStore.getState().setDraftThreadContext(draftId, {
              sshDestination,
              envMode: "worktree",
              worktreePath: null,
              branch: null,
              startFromOrigin: false,
            }),
          onEnvModeChange: (envMode: "local" | "worktree") =>
            useComposerDraftStore
              .getState()
              .setDraftThreadContext(draftId, { envMode, sshDestination: null }),
        };
        root.render(
          layout === "wide" ? (
            <BranchToolbarEnvModeSelector
              {...common}
              envLocked={false}
              effectiveEnvMode={draft.envMode}
              activeWorktreePath={null}
            />
          ) : (
            <BranchToolbar
              {...common}
              draftId={draftId}
              layout={layout}
              panelSection="workspace"
              environmentId={source.environmentId}
              threadId={draft.threadId}
              showGitControls
              envMode={draft.envMode}
              envLocked={false}
              startFromOrigin={false}
              onStartFromOriginChange={vi.fn()}
            />
          ),
        );
      });
    const trigger = () =>
      container.querySelector<HTMLButtonElement>(
        layout === "wide"
          ? '[aria-label="Workspace"]'
          : layout === "panel"
            ? '[aria-label="Run context"]'
            : '[data-composer-shortcut*="composer.workspace"]',
      )!;
    const item = (text: string) =>
      [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(
        (node) => node.textContent === text,
      )!;
    try {
      await render();
      await act(async () => trigger().click());
      await act(async () => {
        const trigger = item("Worktree on SSH");
        if (activation === "mouse") trigger.click();
        else {
          trigger.focus();
          trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
        }
      });
      await act(async () => {
        const host = item("Build host");
        if (activation === "mouse") host.click();
        else {
          host.focus();
          host.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        }
      });
      expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
        sshDestination: sshOption.destination,
        environmentId: source.environmentId,
        projectId: source.projectId,
        branch: null,
        worktreePath: null,
      });
      await render();
      expect(trigger().textContent).toBe("Worktree · Build host");
      if (!item("New worktree")) await act(async () => trigger().click());
      await act(async () => item("New worktree").click());
      expect(useComposerDraftStore.getState().getDraftSession(draftId)?.sshDestination).toBeNull();
      await render([{ ...sshOption, disabledReason: "Enable host" }]);
      await act(async () => trigger().click());
      await act(async () => item("Worktree on SSH").click());
      expect(item("Build host").getAttribute("aria-disabled")).toBe("true");
      await act(async () => item("Build host").click());
      expect(useComposerDraftStore.getState().getDraftSession(draftId)?.sshDestination).toBeNull();
      await act(async () => trigger().click());
      await render([]);
      await act(async () => trigger().click());
      expect(item("Worktree on SSH")).toBeUndefined();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  },
);

it("does not auto-pick a local base branch or open the branch keybinding while SSH is selected", async () => {
  state.realBranch = true;
  state.serverThread = false;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const draftId = DraftId.make("branch-ssh"),
    environmentId = EnvironmentId.make("local"),
    threadId = ThreadId.make("branch-ssh");
  useComposerDraftStore
    .getState()
    .setLogicalProjectDraftThreadId(
      "source",
      scopeProjectRef(environmentId, ProjectId.make("source")),
      draftId,
      { threadId, envMode: "worktree", sshDestination: sshOption.destination },
    );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const ref = { current: null as import("./BranchToolbar").BranchToolbarHandle | null };
  try {
    await act(async () =>
      root.render(
        <BranchToolbar
          ref={ref}
          layout="panel"
          panelSection="branch"
          environmentId={environmentId}
          threadId={threadId}
          draftId={draftId}
          showGitControls
          envLocked={false}
          envMode="worktree"
          sshDestination={sshOption.destination}
          startFromOrigin={false}
          onStartFromOriginChange={vi.fn()}
          onEnvModeChange={vi.fn()}
        />,
      ),
    );
    await act(async () => ref.current?.openBranchPicker());
    expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
      branch: null,
      sshDestination: sshOption.destination,
    });
    expect(document.querySelector('[role="combobox"]')?.getAttribute("aria-expanded")).toBe(
      "false",
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it.each(["composer", "panel", "wide"] as const)(
  "disables SSH with source and model reasons in %s",
  async (layout) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.serverThread = false;
    const draftId = DraftId.make("blocked-ssh"),
      environmentId = EnvironmentId.make("local"),
      threadId = ThreadId.make("blocked-ssh");
    useComposerDraftStore
      .getState()
      .setLogicalProjectDraftThreadId(
        "source",
        scopeProjectRef(environmentId, ProjectId.make("source")),
        draftId,
        { threadId, envMode: "local" },
      );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const select = vi.fn();
    try {
      for (const reason of [
        "SSH worktrees need a new draft.",
        "Choose Local in Run on before sending to SSH.",
        "Choose one model before sending to SSH.",
        "This connection cannot copy code and start SSH threads.",
      ]) {
        await act(async () => {
          const common = {
            sshDestination: null,
            sshOptions: [sshOption],
            sshDisabledReason: reason,
            onSshDestinationChange: select,
            onEnvModeChange: vi.fn(),
          };
          root.render(
            layout === "wide" ? (
              <BranchToolbarEnvModeSelector
                key={reason}
                {...common}
                envLocked={false}
                effectiveEnvMode="local"
                activeWorktreePath={null}
              />
            ) : (
              <BranchToolbar
                key={reason}
                {...common}
                layout={layout}
                panelSection="workspace"
                environmentId={environmentId}
                threadId={threadId}
                draftId={draftId}
                showGitControls
                envMode="local"
                envLocked={false}
                startFromOrigin={false}
                onStartFromOriginChange={vi.fn()}
              />
            ),
          );
        });
        const trigger = container.querySelector<HTMLButtonElement>(
          layout === "wide"
            ? '[aria-label="Workspace"]'
            : layout === "panel"
              ? '[aria-label="Run context"]'
              : '[data-composer-shortcut*="composer.workspace"]',
        )!;
        await act(async () => trigger.click());
        const submenu = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
          (item) => item.textContent === "Worktree on SSH",
        )!;
        expect(submenu.getAttribute("aria-disabled")).toBe("true");
        expect(submenu.title).toBe(reason);
        await act(async () => {
          submenu.click();
          submenu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
        });
        expect(select).not.toHaveBeenCalled();
        expect(
          useComposerDraftStore.getState().getDraftSession(draftId)?.sshDestination,
        ).toBeNull();
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  },
);
