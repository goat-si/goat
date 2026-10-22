import { EnvironmentId, ThreadId } from "@goat/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  visit: vi.fn(async () => ({ _tag: "Success" as const })),
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
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.visit }));
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

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.visit.mockClear();
  state.markThreadVisited.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("marks the bot thread visited once using the shell update watermark", async () => {
  await act(() =>
    root.render(
      <GoatBotThreadView
        environmentId={EnvironmentId.make("env")}
        threadId={ThreadId.make("bot")}
      />,
    ),
  );
  expect(state.visit).toHaveBeenCalledTimes(1);
  expect(state.visit).toHaveBeenCalledWith({
    environmentId: EnvironmentId.make("env"),
    input: { threadId: ThreadId.make("bot"), visitedAt: "2026-10-12T12:03:00.000Z" },
  });
  expect(state.markThreadVisited).not.toHaveBeenCalled();
});
