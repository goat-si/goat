import { scopeThreadRef } from "@goat/client-runtime/environment";
import type { EnvironmentShellSync } from "@goat/client-runtime/state/presentation";
import type { EnvironmentThreadState } from "@goat/client-runtime/state/threads";
import { EnvironmentId, ProjectId, ThreadId } from "@goat/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const navigate = vi.fn();
const refreshShell = vi.fn();
let sync: EnvironmentShellSync = "live";

vi.mock("../state/presentation", () => ({ useEnvironmentShellSync: () => sync }));
vi.mock("../state/threads", async () => {
  const { EMPTY_ENVIRONMENT_THREAD_STATE } = await import("@goat/client-runtime/state/threads");
  return {
    useEnvironmentThread: (
      _environmentId: EnvironmentId | null,
      threadId: ThreadId | null,
    ): EnvironmentThreadState => ({
      ...EMPTY_ENVIRONMENT_THREAD_STATE,
      status: threadId === "gone" ? "deleted" : "synchronizing",
    }),
  };
});

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));
vi.mock("./ChatView", () => ({ default: () => <div data-view="chat" /> }));
vi.mock("./goatBot/GoatBotThreadView", () => ({
  GoatBotThreadView: () => <div data-view="goat-bot" />,
}));
vi.mock("./ChatView.logic", () => ({
  resolveDraftPromotionNavigationTarget: () => null,
  threadHasStarted: () => false,
}));
vi.mock("./chat/draftHeroTransition", () => ({
  waitForDraftHeroTransition: () => Promise.resolve(),
}));
vi.mock("./ui/sidebar", () => ({
  SidebarInset: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomRefresh: () => refreshShell,
}));
vi.mock("../state/shell", () => ({
  environmentShell: { stateAtom: () => null },
  useEnvironmentShellStatus: () =>
    sync === "live" ? "live" : sync === "error" ? "empty" : "cached",
}));
vi.mock("../state/entities", () => ({
  // Another thread exists in the environment, so a missing ordinary thread redirects home.
  useEnvironmentThreadRefs: () => [{ environmentId: "env", threadId: "other" }],
  useThreadRefs: () => [],
  useQuietThreadShell: (ref: { threadId: string } | null) =>
    ref?.threadId === "worker" ? { deletedAt: null, archivedAt: null } : null,
}));
vi.mock("../composerDraftStore", async () => {
  const Schema = await import("effect/Schema");
  const store = {
    getDraftSession: () => null,
    getDraftThreadByRef: () => null,
    getDraftIdByRef: () => null,
    hasDraftThreadsInEnvironment: () => false,
  };
  return {
    DraftId: Schema.String.pipe(Schema.brand("DraftId")),
    useComposerDraftStore: (select: (value: typeof store) => unknown) => select(store),
    useBackgroundDraftSubmissionPending: () => false,
    finalizePromotedDraftThreadByRef: () => {},
    markPromotedDraftThreadByRef: () => {},
  };
});

import { useGlobalAgentStore } from "../globalAgentStore";
import { ThreadRouteView } from "./ThreadRouteView";

const environmentId = EnvironmentId.make("env");
const botThreadId = ThreadId.make("bot");

let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  navigate.mockClear();
  refreshShell.mockClear();
  sync = "live";
  useGlobalAgentStore.setState({
    ref: null,
    botRef: { environmentId, projectId: ProjectId.make("scratch"), threadId: botThreadId },
  });
});

afterEach(async () => {
  await act(() => root?.unmount());
  container?.remove();
  root = undefined;
});

async function renderThread(threadId: ThreadId) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() => {
    root?.render(
      <ThreadRouteView
        target={{ kind: "server", threadRef: scopeThreadRef(environmentId, threadId) }}
      />,
    );
  });
}

it("keeps a missing GOAT Bot thread on the bot view instead of redirecting", async () => {
  await renderThread(botThreadId);
  expect(container.querySelector("[data-view]")?.getAttribute("data-view")).toBe("goat-bot");
  expect(navigate).not.toHaveBeenCalled();
});

it("still sends a missing ordinary thread home", async () => {
  await renderThread(ThreadId.make("gone"));
  expect(container.querySelector("[data-view]")).toBeNull();
  expect(navigate).toHaveBeenCalledWith({ to: "/", replace: true });
});

it("opens the chip worker target in the coding ChatView rather than the bot view", async () => {
  await renderThread(ThreadId.make("worker"));
  expect(container.querySelector("[data-view]")?.getAttribute("data-view")).toBe("chat");
  expect(navigate).not.toHaveBeenCalled();
});

it("warns alongside cached threads, retries synchronization, and removes the warning after recovery", async () => {
  sync = "stale";
  await renderThread(ThreadId.make("worker"));
  expect(container.querySelector("[data-view=chat]")).not.toBeNull();
  expect(container.querySelector("[role=status]")?.textContent).toContain(
    "Displayed threads may be out of date",
  );
  await act(() => container.querySelector("button")?.click());
  expect(refreshShell).toHaveBeenCalledOnce();
  sync = "live";
  await act(() =>
    root?.render(
      <ThreadRouteView
        target={{
          kind: "server",
          threadRef: scopeThreadRef(environmentId, ThreadId.make("worker")),
        }}
      />,
    ),
  );
  expect(container.querySelector("[role=status]")).toBeNull();
  expect(container.querySelector("[data-view=chat]")).not.toBeNull();
});

it("shows a retryable shell error instead of a blank route without a snapshot", async () => {
  sync = "error";
  await renderThread(ThreadId.make("unknown"));
  expect(container.querySelector("[role=status]")?.textContent).toContain(
    "Could not sync environment data",
  );
  expect(container.querySelector("button")?.textContent).toBe("Retry sync");
  expect(navigate).not.toHaveBeenCalled();
});

it("stays quiet during a routine synchronization", async () => {
  sync = "synchronizing";
  await renderThread(ThreadId.make("unknown"));
  expect(container.querySelector("[role=status]")).toBeNull();
  expect(container.querySelector("button")).toBeNull();
  expect(navigate).not.toHaveBeenCalled();
});
