import { EnvironmentId, ProjectId, ThreadId } from "@goat/contracts";
import { SshConnectionProfile } from "@goat/client-runtime/connection";
import { scopeProjectRef } from "@goat/client-runtime/environment";
import { type ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

const state = vi.hoisted(() => ({
  worktreePath: "/tmp/worktree" as string | null,
  serverThread: true,
  realBranch: false,
  showContextMenu: vi.fn(),
  writeTextToClipboard: vi.fn(),
}));

vi.mock(import("../localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: (() => ({ contextMenu: { show: state.showContextMenu } })) as never,
}));
vi.mock(import("../hooks/useCopyToClipboard"), async (original) => ({
  ...(await original()),
  writeTextToClipboard: state.writeTextToClipboard,
}));
vi.mock(import("./BranchToolbarBranchSelector"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    BranchToolbarBranchSelector: ((
      props: ComponentProps<typeof actual.BranchToolbarBranchSelector>,
    ) => (state.realBranch ? <actual.BranchToolbarBranchSelector {...props} /> : null)) as never,
  };
});
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useQuietThreadShell: (() =>
    state.serverThread
      ? { environmentId: "local", projectId: "project", worktreePath: state.worktreePath }
      : null) as never,
  useProject: (() => ({ id: "source", workspaceRoot: "/tmp/project" })) as never,
  useThreadShellsForProjectRefs: () => [],
}));
// The branch picker reads source control state over RPC; these stand-ins keep it idle.
vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock(import("../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => vi.fn()) as never,
}));
vi.mock(import("../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({ data: { refName: "main", refs: [] }, isPending: false })) as never,
}));
vi.mock(import("../state/queries"), async (original) => ({
  ...(await original()),
  usePaginatedBranches: (() => ({
    refs: [{ name: "main", isDefault: true }],
    data: { nextCursor: null },
    isPending: false,
  })) as never,
}));
vi.mock(import("./ThreadStatusIndicators"), async (original) => ({
  ...(await original()),
  useLinkedThreadPullRequest: (() => null) as never,
}));
vi.mock(import("../lib/openPullRequestLink"), async (original) => ({
  ...(await original()),
  useOpenPrLink: (() => vi.fn()) as never,
}));

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import type { SavedSshWorktreeOption } from "../lib/sshWorktree";
import { BranchToolbar, type BranchToolbarHandle } from "./BranchToolbar";
import { BranchToolbarEnvModeSelector } from "./BranchToolbarEnvModeSelector";

import { act, render } from "../../test/render";

vi.mock(import("../hooks/useAddProjectTargets"), () => ({ useAddProjectTargets: () => [] }));

async function setup() {
  state.worktreePath = "/tmp/worktree";
  state.serverThread = true;
  state.realBranch = false;
  state.showContextMenu.mockReset().mockResolvedValue("copy-path");
  state.writeTextToClipboard.mockReset().mockResolvedValue(true);
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  const screen = await render(null);
  const container = screen.container;
  function renderToolbar(props: Partial<ComponentProps<typeof BranchToolbar>>) {
    return act(async () =>
      screen.rerender(
        <BranchToolbar
          layout="panel"
          panelSection="workspace"
          environmentId={EnvironmentId.make("local")}
          threadId={ThreadId.make("thread")}
          projectId={ProjectId.make("source")}
          worktreePath={state.worktreePath}
          isServerThread={state.serverThread}
          showGitControls
          envMode="local"
          envLocked={false}
          startFromOrigin={false}
          onStartFromOriginChange={vi.fn()}
          onEnvModeChange={vi.fn()}
          {...props}
        />,
      ),
    );
  }
  function workspaceTrigger(layout: (typeof LAYOUTS)[number]) {
    return container.querySelector<HTMLButtonElement>(
      layout === "wide"
        ? '[aria-label="Workspace"]'
        : layout === "panel"
          ? '[aria-label="Run context"]'
          : '[data-composer-shortcut*="composer.workspace"]',
    )!;
  }
  return Object.assign(screen, { renderToolbar, workspaceTrigger });
}

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

const LAYOUTS = ["composer", "panel", "wide"] as const;

const menuItem = (text: string) =>
  [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(
    (node) => node.textContent === text,
  );

const session = (draftId: DraftId) => useComposerDraftStore.getState().getDraftSession(draftId);

it.each(LAYOUTS)("shows workspace modes and retires the old option in %s", async (layout) => {
  await using screen = await setup();
  const { workspaceTrigger } = screen;
  state.serverThread = false;
  const draftId = DraftId.make("panel-draft");
  const projectRef = scopeProjectRef(EnvironmentId.make("remote"), ProjectId.make("project"));
  useComposerDraftStore.getState().setLogicalProjectDraftThreadId("project", projectRef, draftId, {
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
  const onEnvModeChange = (envMode: "local" | "worktree") =>
    useComposerDraftStore.getState().setDraftThreadContext(draftId, { envMode });
  const renderModes = () =>
    act(async () => {
      const envMode = session(draftId)!.envMode;
      await screen.rerender(
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
              projectId={ProjectId.make("source")}
              worktreePath={null}
              isServerThread={false}
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
  await renderModes();
  const trigger = () => workspaceTrigger(layout);
  const label = trigger().querySelector("[data-composer-label]")!;
  expect(label.textContent).toBe("Local · Build host");
  // Compact composers still show the workspace label instead of collapsing it.
  expect(label.className).not.toContain("max-w-0");
  expect(label.querySelector("[data-composer-label-motion]")!.className).not.toContain("opacity-0");
  for (const [choice, mode] of [
    ["New worktree", "worktree"],
    ["Local", "local"],
  ] as const) {
    await userEvent.click(trigger());
    await expect.element(page.getByRole("menu")).toBeVisible();
    expect(menuItem("Previous worktree")).toBeUndefined();
    await userEvent.click(page.getByRole("menuitemradio", { name: choice, exact: true }));
    expect(session(draftId)?.envMode).toBe(mode);
    await renderModes();
    expect(trigger().textContent).toContain(`${choice} · Build host`);
  }
});

it.each([
  [false, "local", null, "Local · Build host"],
  [false, "worktree", "/existing", "Worktree · Build host"],
  [false, "worktree", null, "New worktree · Build host"],
  [true, "local", "/stale", "New worktree · Build host"],
] as const)(
  "labels locked wide mode with force=%s mode=%s path=%s",
  async (forceNewWorktree, effectiveEnvMode, activeWorktreePath, label) => {
    await using screen = await setup();
    const { container } = screen;
    await act(
      async () =>
        await screen.rerender(
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
  },
);

it.each(LAYOUTS.flatMap((layout) => [[layout, "mouse"] as const, [layout, "keyboard"] as const]))(
  "selects and clears saved SSH hosts through the right submenu in %s with %s",
  async (layout, activation) => {
    await using screen = await setup();
    const { workspaceTrigger } = screen;
    state.serverThread = false;
    const draftId = DraftId.make("ssh-menu");
    const source = scopeProjectRef(EnvironmentId.make("local"), ProjectId.make("source"));
    useComposerDraftStore.getState().setLogicalProjectDraftThreadId("source", source, draftId, {
      envMode: "worktree",
      threadId: ThreadId.make("source"),
    });
    const renderSsh = (options: SavedSshWorktreeOption[] = [sshOption]) =>
      act(async () => {
        const draft = session(draftId)!;
        const common = {
          sshDestination: draft.sshDestination ?? null,
          sshOptions: options,
          sshDisabledReason: null,
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
        await screen.rerender(
          layout === "wide" ? (
            <BranchToolbarEnvModeSelector
              {...common}
              envLocked={false}
              effectiveEnvMode={draft.envMode}
              activeWorktreePath={null}
            />
          ) : (
            <BranchToolbar
              projectId={ProjectId.make("source")}
              worktreePath={null}
              isServerThread={false}
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
    const activate = async (text: string, key: "{ArrowRight}" | "{Enter}") => {
      await vi.waitFor(() => expect(menuItem(text)).toBeDefined());
      const item = menuItem(text)!;
      if (activation === "mouse") await userEvent.click(item);
      else {
        await act(async () => item.focus());
        await userEvent.keyboard(key);
      }
    };

    await renderSsh();
    await userEvent.click(workspaceTrigger(layout));
    await activate("Work on SSH", "{ArrowRight}");
    await activate("Build host", "{Enter}");
    expect(session(draftId)).toMatchObject({
      sshDestination: sshOption.destination,
      environmentId: source.environmentId,
      projectId: source.projectId,
      branch: null,
      worktreePath: null,
    });
    await renderSsh();
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
    expect(workspaceTrigger(layout).textContent).toBe("SSH · Build host");

    await userEvent.click(workspaceTrigger(layout));
    await userEvent.click(page.getByRole("menuitemradio", { name: "New worktree", exact: true }));
    expect(session(draftId)?.sshDestination).toBeNull();

    await renderSsh([{ ...sshOption, disabledReason: "Enable host" }]);
    await userEvent.click(workspaceTrigger(layout));
    await userEvent.click(page.getByRole("menuitem", { name: "Work on SSH" }));
    // The host's own reason is printed on its row.
    await vi.waitFor(() => expect(menuItem("Build hostEnable host")).toBeDefined());
    expect(menuItem("Build hostEnable host")!.getAttribute("aria-disabled")).toBe("true");
    menuItem("Build hostEnable host")!.click();
    expect(session(draftId)?.sshDestination).toBeNull();

    // The first Escape closes the host submenu, the second its parent menu.
    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("{Escape}");
    await renderSsh([]);
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
    await userEvent.click(workspaceTrigger(layout));
    await expect.element(page.getByRole("menu")).toBeVisible();
    expect(menuItem("Work on SSH")).toBeUndefined();
  },
);

it("does not auto-pick a local base branch or open the branch keybinding while SSH is selected", async () => {
  await using screen = await setup();
  const { renderToolbar: render } = screen;
  state.realBranch = true;
  state.serverThread = false;
  const draftId = DraftId.make("branch-ssh");
  const environmentId = EnvironmentId.make("local");
  const threadId = ThreadId.make("branch-ssh");
  useComposerDraftStore
    .getState()
    .setLogicalProjectDraftThreadId(
      "source",
      scopeProjectRef(environmentId, ProjectId.make("source")),
      draftId,
      { threadId, envMode: "worktree", sshDestination: sshOption.destination },
    );
  const ref = { current: null as BranchToolbarHandle | null };
  await render({
    ref,
    panelSection: "branch",
    threadId,
    draftId,
    envMode: "worktree",
    sshDestination: sshOption.destination,
  });
  await act(async () => ref.current?.openBranchPicker());
  expect(session(draftId)).toMatchObject({ branch: null, sshDestination: sshOption.destination });
  expect(document.querySelector('[role="combobox"]')?.getAttribute("aria-expanded")).toBe("false");
});

it.each(LAYOUTS)("keeps blocked SSH hosts visible with the reason in %s", async (layout) => {
  await using screen = await setup();
  const { workspaceTrigger } = screen;
  state.serverThread = false;
  const draftId = DraftId.make("blocked-ssh");
  const environmentId = EnvironmentId.make("local");
  const threadId = ThreadId.make("blocked-ssh");
  useComposerDraftStore
    .getState()
    .setLogicalProjectDraftThreadId(
      "source",
      scopeProjectRef(environmentId, ProjectId.make("source")),
      draftId,
      { threadId, envMode: "local" },
    );
  const select = vi.fn();
  for (const reason of [
    "SSH worktrees need a new draft.",
    "Add this project on this device to copy it over SSH.",
    "Choose one model before sending to SSH.",
    "This connection cannot copy code and start SSH threads.",
  ]) {
    const common = {
      sshDestination: null,
      sshOptions: [sshOption],
      sshDisabledReason: reason,
      onSshDestinationChange: select,
      onEnvModeChange: vi.fn(),
    };
    await act(
      async () =>
        await screen.rerender(
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
              projectId={ProjectId.make("source")}
              worktreePath={null}
              isServerThread={false}
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
        ),
    );
    await userEvent.click(workspaceTrigger(layout));
    await vi.waitFor(() => expect(menuItem("Work on SSH")).toBeDefined());
    const submenu = menuItem("Work on SSH")!;
    expect(submenu.getAttribute("aria-disabled")).not.toBe("true");
    await act(async () => submenu.focus());
    await userEvent.keyboard("{ArrowRight}");
    await vi.waitFor(() => expect(menuItem("Build host")).toBeDefined());
    const host = menuItem("Build host")!;
    expect(host.getAttribute("aria-disabled")).toBe("true");
    expect(host.closest('[role="menu"]')?.textContent).toContain(reason);
    host.click();
    expect(select).not.toHaveBeenCalled();
    expect(session(draftId)?.sshDestination).toBeNull();
    // The first Escape closes the host submenu, the second its parent menu.
    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
  }
});
