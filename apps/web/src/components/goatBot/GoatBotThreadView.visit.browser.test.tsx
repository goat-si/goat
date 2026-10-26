import { EnvironmentId, ThreadId } from "@goat/contracts";
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
vi.mock("./GoatBotChatView", () => ({ GoatBotChatView: () => <div>GOAT Bot</div> }));
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
