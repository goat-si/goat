import { EnvironmentId, ThreadId } from "@goat/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

// The banner follows the server like web's useThreadWorkspaceStatus: on returning to the app,
// every half minute while the worktree needs attention, on each run, and on new thread items
// while it needs attention (goat#3692).
const mocks = vi.hoisted(() => ({
  status: { state: "missing" } as { state: string },
  shell: { latestRun: { runId: "run-1" }, itemCount: 3 },
  refresh: vi.fn(),
  appStateListeners: [] as Array<(state: string) => void>,
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({ _tag: "Success", value: mocks.status }),
}));
vi.mock("@goat/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: () => new Error("failed"),
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AppState: {
    currentState: "active",
    addEventListener: (_event: string, listener: (state: string) => void) => {
      mocks.appStateListeners.push(listener);
      return {
        remove: () => {
          mocks.appStateListeners.splice(mocks.appStateListeners.indexOf(listener), 1);
        },
      };
    },
  },
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label }: { label: string }) => <button>{label}</button>,
}));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: { refresh: mocks.refresh } }));
vi.mock("../../state/entities", () => ({ useQuietThreadShell: () => mocks.shell }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { threadWorkspaceStatus: () => "status-query", restoreThreadWorkspace: {} },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
import { LiveThreadWorkspaceBanner } from "./LiveThreadWorkspaceBanner";

function setup(status: string) {
  mocks.status = { state: status };
  mocks.shell = { latestRun: { runId: "run-1" }, itemCount: 3 };
  mocks.refresh.mockReset();
  mocks.appStateListeners.length = 0;
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = async () => {
    await act(async () =>
      root.render(
        <LiveThreadWorkspaceBanner
          environmentId={EnvironmentId.make("local")}
          threadId={ThreadId.make("thread")}
        />,
      ),
    );
  };
  return {
    render,
    appState: (state: string) =>
      act(() => {
        for (const listener of mocks.appStateListeners.slice()) listener(state);
      }),
    [Symbol.asyncDispose]: async () => {
      await act(async () => root.unmount());
    },
  };
}

it("refreshes a missing worktree's status when the app returns to the foreground", async () => {
  await using banner = setup("missing");
  await banner.render();
  expect(mocks.refresh).not.toHaveBeenCalled();
  banner.appState("background");
  banner.appState("active");
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
  expect(mocks.refresh).toHaveBeenCalledWith("status-query");
});

it("refreshes every half minute only while the worktree needs attention", async () => {
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  vi.useFakeTimers();
  {
    await using banner = setup("missing");
    await banner.render();
    act(() => vi.advanceTimersByTime(30_000));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(30_000));
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
  }
  await using healthy = setup("present");
  await healthy.render();
  act(() => vi.advanceTimersByTime(90_000));
  expect(mocks.refresh).not.toHaveBeenCalled();
});

it("refreshes on a new run, even while the worktree is healthy", async () => {
  await using banner = setup("present");
  await banner.render();
  expect(mocks.refresh).not.toHaveBeenCalled();
  mocks.shell = { latestRun: { runId: "run-2" }, itemCount: 3 };
  await banner.render();
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
});

it("refreshes on new thread items only while the worktree needs attention", async () => {
  await using banner = setup("missing");
  await banner.render();
  mocks.shell = { latestRun: { runId: "run-1" }, itemCount: 4 };
  await banner.render();
  expect(mocks.refresh).toHaveBeenCalledTimes(1);

  await using healthy = setup("present");
  await healthy.render();
  mocks.shell = { latestRun: { runId: "run-1" }, itemCount: 9 };
  await healthy.render();
  expect(mocks.refresh).not.toHaveBeenCalled();
});
