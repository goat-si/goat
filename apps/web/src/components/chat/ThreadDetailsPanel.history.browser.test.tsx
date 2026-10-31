import { EnvironmentId, ProjectId, ThreadId } from "@goat/contracts";
import { type ComponentProps, type ReactNode } from "react";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { PopoverCreateHandle } from "../ui/popover";

const state = vi.hoisted(() => ({ canRead: true, request: vi.fn() }));
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (atom: unknown) => (atom === "history-permission" ? state.canRead : []),
}));
vi.mock("@goat/client-runtime/state/computer-use-history", () => ({
  createComputerUseHistoryCommand: () => ({ permissionAtom: () => "history-permission" }),
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: null }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.request }));
vi.mock("../../composerDraftStore", () => ({
  DraftId: { make: (value: string) => value },
  useComposerDraftStore: () => undefined,
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: () => null,
  useThreadProjection: () => null,
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { providersValueAtom: () => null } }));
vi.mock("@goat/client-runtime/state/cloud-task", () => ({
  deriveCloudTaskState: () => ({ showLocalWorkspace: false }),
}));
vi.mock("../BranchToolbar", () => ({ BranchToolbar: () => null }));
vi.mock("../GitActionsControl", () => ({ default: () => null }));
vi.mock("../ProjectScriptsControl", () => ({ default: () => null }));
vi.mock("./OpenInPicker", () => ({ OpenInPicker: () => null }));
vi.mock("./ThreadAutomationsPanel", () => ({ ThreadAutomationsPanel: () => null }));
vi.mock("./ThreadRelationshipsControl", () => ({ ThreadRelationshipsPanel: () => null }));
vi.mock("./ThreadDetailsCard", () => ({
  ThreadDetailsCard: ({ children }: { children: (density: "full") => ReactNode }) => (
    <div>{children("full")}</div>
  ),
}));
import { ThreadDetailsPanel } from "./ThreadDetailsPanel";

it("opens empty thread history from details and hides it without read permission", async () => {
  state.canRead = true;
  state.request
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { entries: [], nextCursor: null } });
  const props = {
    anchor: { current: null },
    handle: PopoverCreateHandle(),
    onPresentationChange: () => {},
    environmentId: EnvironmentId.make("env:a"),
    threadId: ThreadId.make("thread:empty"),
    projectId: ProjectId.make("project:a"),
    worktreePath: null,
    isServerThread: true,
    activeProjectName: undefined,
    activeProjectScripts: undefined,
    preferredScriptId: null,
    keybindings: [],
    availableEditors: [],
    showOpenInPicker: false,
    openInShortcutEnabled: false,
    gitCwd: null,
    isGitRepo: false,
    envLocked: false,
    availableEnvironments: [],
    environmentsWithoutProject: [],
    onEnvModeChange: () => {},
    envMode: "local",
    startFromOrigin: false,
    onStartFromOriginChange: () => {},
    onComposerFocusRequest: () => {},
    onRunProjectScript: () => {},
    onAddProjectScript: async () => AsyncResult.success(undefined),
    onUpdateProjectScript: async () => AsyncResult.success(undefined),
    onDeleteProjectScript: async () => AsyncResult.success(undefined),
  } satisfies ComponentProps<typeof ThreadDetailsPanel>;
  await using screen = await render(<ThreadDetailsPanel {...props} />);
  await userEvent.click(screen.getByRole("button", { name: "Show input history" }));
  await expect.element(screen.getByText("No input history.")).toBeVisible();
  state.canRead = false;
  await screen.rerender(<ThreadDetailsPanel key="denied" {...props} />);
  expect(screen.getByRole("button", { name: "Show input history" }).elements()).toHaveLength(0);
});
