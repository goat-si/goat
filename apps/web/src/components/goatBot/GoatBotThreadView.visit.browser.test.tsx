import { ChannelTaskId, EnvironmentId, ThreadId } from "@goat/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import type { ScopedThreadRef } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";

const state = vi.hoisted(() => ({
  visit: vi.fn(),
  markThreadVisited: vi.fn(),
}));

vi.mock("~/state/entities", () => ({
  useThreadShell: () => ({
    environmentId: EnvironmentId.make("env"),
    id: ThreadId.make("bot"),
    updatedAt: "2026-10-12T12:03:00.000Z",
    lastVisitedAt: null,
    latestRun: null,
  }),
  useEnvironmentShellsBootstrapped: () => true,
  resolveThreadDetailRef: (ref: unknown) => ref,
  useThreadVisibleTurnItems: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("~/uiStateStore", () => ({
  useUiStateStore: (selector: (store: object) => unknown) =>
    selector({ markThreadVisited: state.markThreadVisited, threadLastVisitedAtById: {} }),
}));
vi.mock(import("~/state/threads"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentThreadShells: {
      ...actual.environmentThreadShells,
      threadShellAtom: ((ref: ScopedThreadRef) =>
        shellAtom(`${ref.environmentId}:${ref.threadId}`)) as never,
    },
    threadEnvironment: {
      ...actual.threadEnvironment,
      visit: { label: "visit", run: state.visit } as never,
    },
  };
});
vi.mock("~/state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => vi.fn(),
}));
vi.mock("./useGoatBotSession", () => ({
  useGoatBotSession: () => ({
    confirmedBot: { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("bot") },
    onRetryAvailability: vi.fn(),
    canOperate: true,
    rows: [],
  }),
}));
vi.mock("./GoatBotChatView", () => ({
  GoatBotChatView: (props: {
    openHome?: { key: string; entry: string; taskId?: string } | null;
  }) => (
    <div>
      GOAT Bot
      {props.openHome
        ? ` home:${props.openHome.key}:${props.openHome.entry}:${props.openHome.taskId ?? ""}`
        : ""}
    </div>
  ),
}));
vi.mock("./GoatBotTimeline", async () => {
  const { createContext } = await import("react");
  return { GoatBotActivityContext: createContext(null) };
});
vi.mock("./goatBotHooks", () => ({ useLegacyGlobalAgentRoute: () => null }));
vi.mock("./useGoatBotWaitingCount", () => ({ refreshGoatBotWaitingCount: vi.fn() }));
vi.mock("~/lib/archivedThreadsState", () => ({
  refreshArchivedThreadsForEnvironment: vi.fn(),
  useArchivedThreadSnapshots: () => ({ snapshots: [], isLoading: false, error: null }),
}));

vi.mock("./useGoatBotHome", () => ({
  useGoatBotHomeSettings: () => ({ moveTarget: null, busy: false, error: null }),
}));

import { GoatBotThreadView } from "./GoatBotThreadView";

const shellAtom = Atom.family((_key: string) => Atom.make<unknown>(null).pipe(Atom.keepAlive));

it("marks the bot thread visited once using the shell update watermark", async () => {
  state.visit.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.markThreadVisited.mockClear();
  appAtomRegistry.set(shellAtom("env:bot"), {
    environmentId: EnvironmentId.make("env"),
    id: ThreadId.make("bot"),
    updatedAt: "2026-10-12T12:03:00.000Z",
    lastVisitedAt: null,
    latestRun: null,
  });
  await using screen = await render(
    <AppAtomRegistryProvider>
      <GoatBotThreadView
        environmentId={EnvironmentId.make("env")}
        threadId={ThreadId.make("bot")}
      />
    </AppAtomRegistryProvider>,
  );
  await expect.element(screen.getByText("GOAT Bot")).toBeVisible();
  await vi.waitFor(() => expect(state.visit).toHaveBeenCalledTimes(1));
  expect(state.visit).toHaveBeenCalledWith(expect.anything(), {
    environmentId: EnvironmentId.make("env"),
    input: { threadId: ThreadId.make("bot"), visitedAt: "2026-10-12T12:03:00.000Z", opened: true },
  });
  expect(state.markThreadVisited).not.toHaveBeenCalled();
});

it("takes an Open Home request once and removes it from the history entry", async () => {
  state.visit.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  await using screen = await render(
    <AppAtomRegistryProvider>
      <GoatBotThreadView
        environmentId={EnvironmentId.make("env")}
        threadId={ThreadId.make("bot")}
      />
    </AppAtomRegistryProvider>,
  );
  const router = screen.router;
  if (!router) throw new Error("missing router");
  await router.navigate({ to: "/", state: { goatBotOpenHome: "home-key" } });
  await expect.element(screen.getByText(/GOAT Bot home:home-key:/)).toBeInTheDocument();
  const shown = screen.container.textContent;
  await vi.waitFor(() => expect(router.state.location.state.goatBotOpenHome).toBeUndefined());
  // Away and back to the same entry: nothing is left to act on, so no new request appears.
  await router.navigate({ to: "/new" });
  router.history.back();
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"));
  expect(router.state.location.state.goatBotOpenHome).toBeUndefined();
  expect(screen.container.textContent).toBe(shown);
});

it("takes a task-origin Home request once from the entry reached by Back", async () => {
  state.visit.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  await using screen = await render(
    <AppAtomRegistryProvider>
      <GoatBotThreadView
        environmentId={EnvironmentId.make("env")}
        threadId={ThreadId.make("bot")}
      />
    </AppAtomRegistryProvider>,
  );
  const router = screen.router;
  if (!router) throw new Error("missing router");
  await router.navigate({
    to: "/",
    state: { goatBotOpenHome: { key: "member-home", taskId: ChannelTaskId.make("task-a") } },
  });
  await expect.element(screen.getByText(/home:member-home:.*:task-a/)).toBeInTheDocument();
  await vi.waitFor(() => expect(router.state.location.state.goatBotOpenHome).toBeUndefined());
  await router.navigate({ to: "/new" });
  router.history.back();
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"));
  expect(router.state.location.state.goatBotOpenHome).toBeUndefined();
});

it("does not request Home when returning from a bare navigation", async () => {
  state.visit.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  await using screen = await render(
    <AppAtomRegistryProvider>
      <GoatBotThreadView
        environmentId={EnvironmentId.make("env")}
        threadId={ThreadId.make("bot")}
      />
    </AppAtomRegistryProvider>,
  );
  const router = screen.router;
  if (!router) throw new Error("missing router");
  await router.navigate({ to: "/new" });
  router.history.back();
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"));
  expect(router.state.location.state.goatBotOpenHome).toBeUndefined();
  expect(screen.container.textContent).toBe("GOAT Bot");
});
