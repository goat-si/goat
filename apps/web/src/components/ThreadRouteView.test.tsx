// @vitest-environment jsdom

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const navigate = vi.fn();

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
vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({ data: { snapshot: { _tag: "Some" } } }),
}));
vi.mock("../state/shell", () => ({ environmentShell: { stateAtom: () => null } }));
vi.mock("../state/entities", () => ({
  // Another thread exists in the environment, so a missing ordinary thread redirects home.
  useEnvironmentThreadRefs: () => [{ environmentId: "env", threadId: "other" }],
  useThreadRefs: () => [],
  useThreadShell: (ref: { threadId: string } | null) =>
    ref?.threadId === "worker" ? { deletedAt: null, archivedAt: null } : null,
}));
vi.mock("../composerDraftStore", () => {
  const store = {
    getDraftSession: () => null,
    getDraftThreadByRef: () => null,
    getDraftIdByRef: () => null,
    hasDraftThreadsInEnvironment: () => false,
  };
  return {
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
