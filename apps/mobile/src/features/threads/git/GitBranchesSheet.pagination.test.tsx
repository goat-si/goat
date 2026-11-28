import type { VcsListRefsInput, VcsListRefsResult, VcsRef } from "@goat/contracts";
import { RegistryContext } from "@effect/atom-react";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type PressProps = { label: string; disabled?: boolean; onPress: () => void };
const harness = vi.hoisted(() => ({
  cwd: "",
  checkouts: [] as string[],
  pages: new Map<string, unknown>(),
  // Requests this returns true for stay unanswered until the test sets their atom.
  holds: (_input: VcsListRefsInput): boolean => false,
}));

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  useWindowDimensions: () => ({ height: 800 }),
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({
    children,
    disabled,
    onPress,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));
vi.mock("@react-navigation/native", () => ({
  useFocusEffect: () => {},
  useNavigation: () => ({ goBack: () => {}, isFocused: () => true }),
}));
vi.mock("../../../components/ui/AndroidScreenHeader", () => ({ AndroidSheetHeader: () => null }));
vi.mock("../../../components/ui/SheetHeader", () => ({ SheetHeader: () => null }));
vi.mock("../../../components/ui/ScreenContent", () => ({
  ScreenContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  AppTextInput: () => null,
}));
vi.mock("./gitSheetComponents", () => ({
  GitActionFailure: () => null,
  SheetActionButton: (props: PressProps) => (
    <button
      type="button"
      data-sheet-action={props.label}
      disabled={props.disabled}
      onClick={props.onPress}
    >
      {props.label}
    </button>
  ),
}));
vi.mock("../../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({ selectedThread: { environmentId: "environment-1", branch: null } }),
}));
vi.mock("../../../state/use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({ selectedThreadCwd: harness.cwd }),
}));
vi.mock("../../../state/use-selected-thread-git-actions", () => ({
  useSelectedThreadGitActions: () => ({
    canChangeThreadBranch: true,
    onCheckoutSelectedThreadBranch: (name: string) => {
      harness.checkouts.push(name);
      return Promise.resolve(null);
    },
  }),
}));
vi.mock("../../../state/use-vcs-action-state", () => ({
  useVcsActionState: () => ({ currentLabel: null, hookName: null }),
}));
vi.mock("../../../state/sourceControl", () => ({
  sourceControlEnvironment: { discovery: () => null },
}));
vi.mock("../../../state/atom-registry", () => ({ appAtomRegistry: { refresh: () => {} } }));
vi.mock("../../../state/session", () => ({ environmentSession: {} }));
vi.mock("../../../state/presentation", () => ({ useEnvironmentPresentation: () => ({}) }));
vi.mock("../../../state/pull-requests", () => ({ composerPullRequests: {} }));
vi.mock("../../../state/projects", () => ({ projectEnvironment: {} }));
vi.mock("../../../state/orchestration", () => ({ orchestrationEnvironment: {} }));
vi.mock("../../../state/threads", () => ({ olderSettledThreads: {}, threadFamilies: {} }));
vi.mock("../../../state/vcs", () => ({
  vcsEnvironment: {
    branch: () => null,
    listRefs: ({ input }: { input: VcsListRefsInput }) => {
      const key = JSON.stringify(input);
      if (!harness.pages.has(key)) {
        harness.pages.set(
          key,
          Atom.make(harness.holds(input) ? AsyncResult.initial(true) : answer(input)),
        );
      }
      return harness.pages.get(key);
    },
  },
}));

import { GitBranchesSheet } from "./GitBranchesSheet";

const localRefs: VcsRef[] = [
  { name: "main", current: true, isDefault: true, isRemote: false, worktreePath: "/repo" },
  ...Array.from({ length: 104 }, (_, index) => ({
    name: `feature/branch-${String(index + 1).padStart(3, "0")}`,
    current: false,
    isDefault: false,
    isRemote: false,
    worktreePath: null,
  })),
];
const remoteRefs: VcsRef[] = Array.from({ length: 50 }, (_, index) => ({
  name: `origin/remote-${index + 1}`,
  current: false,
  isDefault: false,
  isRemote: true,
  worktreePath: null,
}));

// Pages refs the way the server's listRefs does: filtered by refKind, then sliced by cursor.
function listRefsPage(input: VcsListRefsInput): VcsListRefsResult {
  const refs =
    input.refKind === "local"
      ? localRefs
      : input.refKind === "remote"
        ? remoteRefs
        : [...localRefs, ...remoteRefs];
  const start = input.cursor ?? 0;
  const end = start + (input.limit ?? refs.length);
  return {
    refs: refs.slice(start, end),
    isRepo: true,
    hasPrimaryRemote: true,
    nextCursor: end < refs.length ? end : null,
    totalCount: refs.length,
  };
}

// Live ref lists stay waiting for later changes after their first page arrives.
function answer(input: VcsListRefsInput) {
  return AsyncResult.success(listRefsPage(input), { waiting: true });
}

function setup() {
  harness.cwd = "/repo";
  harness.pages.clear();
  harness.checkouts = [];
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const registry = AtomRegistry.make();
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = () => {
    act(() =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <GitBranchesSheet
            route={{ params: { environmentId: "environment-1", threadId: "thread-1" } }}
          />
        </RegistryContext.Provider>,
      ),
    );
  };
  const rows = () =>
    new Map(
      [...container.querySelectorAll<HTMLButtonElement>("button:not([data-sheet-action])")].map(
        (button) => [button.querySelectorAll("span")[0]?.textContent ?? "", button],
      ),
    );
  const actionButton = (label: string) =>
    container.querySelector<HTMLButtonElement>(`button[data-sheet-action="${label}"]`);
  render();
  return {
    registry,
    container,
    rows,
    actionButton,
    render,
    [Symbol.dispose]() {
      act(() => root.unmount());
      registry.dispose();
      harness.holds = () => false;
    },
  };
}

it("reaches local branches past the first page and checks them out", async () => {
  using screen = setup();
  expect(screen.rows().size).toBe(100);
  expect(screen.rows().has("feature/branch-100")).toBe(false);
  expect(screen.container.textContent).not.toContain("Loading branches...");
  expect(screen.container.textContent).not.toContain("No local branches found.");

  harness.holds = (input) => input.cursor === 100;
  act(() => screen.actionButton("Load more")!.click());
  screen.render();
  expect(screen.actionButton("Load more")!.disabled).toBe(true);

  const [secondPageKey, secondPage] = [...harness.pages].find(
    ([key]) => (JSON.parse(key) as VcsListRefsInput).cursor === 100,
  )!;
  act(() =>
    screen.registry.set(
      secondPage as Atom.Writable<AsyncResult.AsyncResult<VcsListRefsResult>>,
      answer(JSON.parse(secondPageKey) as VcsListRefsInput),
    ),
  );
  screen.render();
  expect(screen.rows().size).toBe(105);
  expect([...screen.rows().keys()].some((name) => name.startsWith("origin/"))).toBe(false);
  expect(screen.actionButton("Load more")).toBeNull();
  await act(async () => screen.rows().get("feature/branch-104")!.click());
  expect(harness.checkouts).toEqual(["feature/branch-104"]);
});

it("shows the saved branch list while local pages are unanswered", () => {
  harness.holds = (input) => input.refKind === "local";
  using screen = setup();
  expect(screen.rows().has("main")).toBe(true);
  expect(screen.rows().size).toBe(100);
  expect(screen.container.textContent).not.toContain("Loading branches...");
  expect(screen.container.textContent).not.toContain("No local branches found.");
  expect(screen.actionButton("Load more")).toBeNull();
});
