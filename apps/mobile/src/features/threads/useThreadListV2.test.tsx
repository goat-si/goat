import { RegistryContext } from "@effect/atom-react";
import { goatBotObservationThreadKeys } from "@goat/client-runtime/state/threads";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

import type { Preferences } from "../../persistence/mobile-preferences";
import { makeThreadShellFixture } from "../../test-fixtures";

vi.mock("../../state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentThreadShells: {
      goatBotObservationThreadKeysAtom: Atom.make(new Set<string>() as ReadonlySet<string>).pipe(
        Atom.keepAlive,
      ),
    },
    launchSubagentRowsAtom: Atom.make([]).pipe(Atom.keepAlive),
    threadEnvironment: { visit: {} },
  };
});
vi.mock("../../state/preferences", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  return {
    mobilePreferencesAtom: Atom.make(AsyncResult.success({})).pipe(Atom.keepAlive),
    updateMobilePreferencesAtom: Atom.make(null).pipe(Atom.keepAlive),
  };
});
// Older settled pages are network-backed; every loaded settled row is listed here.
vi.mock("../../state/olderSettledShelf", () => ({
  useOlderSettledShelf: () => ({ isListed: () => true, unloadedCount: () => 0 }),
  useOlderSettledShelfGrowth: () => {},
}));
// Launcher family reads go through the live connection runtime.
vi.mock("./remoteLauncherReads", () => ({ useRemoteLauncherReads: () => {} }));

import { mobilePreferencesAtom } from "../../state/preferences";
import { environmentThreadShells } from "../../state/threads";
import { useThreadListV2 } from "./useThreadListV2";

const observationKeysAtom =
  environmentThreadShells.goatBotObservationThreadKeysAtom as Atom.Writable<ReadonlySet<string>>;
const preferencesAtom = mobilePreferencesAtom as Atom.Writable<
  AsyncResult.AsyncResult<Preferences>
>;

const environmentId = EnvironmentId.make("environment-1");
const NOW = "2026-06-02T00:00:00.000Z";
const SESSION = "goat-bot-session:conversation";

function thread(
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
  launchedBy?: { readonly by: string; readonly via: "thread_launch" | "delegate_task" },
): EnvironmentThreadShell {
  const shell = makeThreadShellFixture({
    environmentId,
    id: ThreadId.make(id),
    title: id,
    ...overrides,
  });
  if (launchedBy === undefined) return shell;
  return {
    ...shell,
    source: {
      ...shell.source,
      launchedBy: {
        kind: "launch",
        threadId: ThreadId.make(launchedBy.by),
        environmentId: null,
        environmentLabel: null,
        threadTitle: null,
        via: launchedBy.via,
      },
    },
  };
}

const threads = [
  thread("mine"),
  thread(SESSION),
  thread("observer", {}, { by: SESSION, via: "delegate_task" }),
  thread("coding", {}, { by: SESSION, via: "thread_launch" }),
  thread("goat-bot-session:snoozed", { snoozedUntil: "2026-06-03T00:00:00.000Z" }),
  thread("settled-observer", { settledOverride: "settled" }, { by: SESSION, via: "delegate_task" }),
  thread("settled-mine", { settledOverride: "settled" }),
];

type ListResult = ReturnType<typeof useThreadListV2>;

async function renderList(searchQuery = "") {
  const registry = AtomRegistry.make();
  registry.set(observationKeysAtom, goatBotObservationThreadKeys({ threads }));
  const environments = new Set([environmentId]);
  let result: ListResult | undefined;
  function List() {
    const value = useThreadListV2({
      threads,
      pendingTasks: [],
      environmentId: null,
      projectRefs: null,
      searchQuery,
      searchMatches: new Map(),
      settlementEnvironmentIds: environments,
      snoozeEnvironmentIds: environments,
      pinReorderEnvironmentIds: environments,
      activeReorderEnvironmentIds: environments,
      queuedThreadKeys: new Set(),
      settledLimit: 10,
      now: NOW,
      pendingOrder: null,
      shelfPreferencesLoaded: true,
      workingShelfEnabled: false,
      workingShelfExpanded: true,
      snoozedShelfExpanded: true,
      settledShelfExpanded: true,
      selectedThreadKey: null,
    });
    useLayoutEffect(() => {
      result = value;
    });
    return null;
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <List />
      </RegistryContext.Provider>,
    ),
  );
  const read = () => {
    if (result === undefined) throw new Error("the list did not render");
    return {
      ids: result.layout.items.map((item) => String(item.thread.id)).toSorted(),
      launchGroups: (result.layout.launchMarkers ?? []).map((marker) => marker.entry.parentKey),
      snoozedCount: result.layout.snoozedCount,
      settledCount: result.layout.settledCount,
    };
  };
  const showBotThreads = (shown: boolean) =>
    act(() => registry.set(preferencesAtom, AsyncResult.success({ showGoatBotThreads: shown })));
  return {
    read,
    showBotThreads,
    [Symbol.asyncDispose]: () => act(async () => root.unmount()),
  };
}

describe("mobile thread list with GOAT Bot threads", () => {
  it("lists no GOAT Bot observation threads, in any shelf, and keeps work the bot launched", async () => {
    await using list = await renderList();
    expect(list.read()).toEqual({
      ids: ["coding", "mine", "settled-mine"],
      launchGroups: [],
      snoozedCount: 0,
      settledCount: 1,
    });
  });

  it("still finds a hidden observation thread by search", async () => {
    await using list = await renderList("observer");
    expect(list.read().ids).toEqual(["observer", "settled-observer"]);
  });

  it("lists them again while this device shows GOAT Bot threads, with the bot's work folded under its session", async () => {
    await using list = await renderList();
    await list.showBotThreads(true);
    expect(list.read()).toEqual({
      ids: [
        "goat-bot-session:conversation",
        "goat-bot-session:snoozed",
        "mine",
        "observer",
        "settled-mine",
        "settled-observer",
      ],
      launchGroups: [`${environmentId}:${SESSION}`],
      snoozedCount: 1,
      settledCount: 2,
    });
    await list.showBotThreads(false);
    expect(list.read().ids).toEqual(["coding", "mine", "settled-mine"]);
  });
});

it("#2394 reads a drive-root worktree without exposing its raw path", async () => {
  vi.stubGlobal("__DEV__", false);
  vi.doMock("react-native", () => ({
    View: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    Pressable: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    useWindowDimensions: () => ({ width: 400 }),
  }));
  const box = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  vi.doMock("../../components/ui/RowPressable", () => ({
    RowPressable: ({
      accessibilityLabel,
      children,
    }: {
      accessibilityLabel: string;
      children?: React.ReactNode;
    }) => <button aria-label={accessibilityLabel}>{children}</button>,
  }));
  vi.doMock("../../components/ui/Dialog", () => ({ alert: () => {} }));
  vi.doMock("../../components/ui/AppText", () => ({ AppText: box }));
  vi.doMock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
  vi.doMock("../../components/ui/AppActivityIndicator", () => ({
    AppActivityIndicator: () => null,
  }));
  vi.doMock("../../components/ui/Menu", () => ({ Menu: box }));
  vi.doMock("../../components/EnvironmentMachineSymbol", () => ({
    EnvironmentMachineSymbol: () => null,
  }));
  vi.doMock("../../components/ProjectFavicon", () => ({ ProjectFavicon: () => null }));
  vi.doMock("../../components/ProviderIcon", () => ({
    ProviderIcon: () => null,
    ProviderInstanceIcon: () => null,
  }));
  vi.doMock("./CustomSnoozeSheet", () => ({ CustomSnoozeSheet: () => null }));
  vi.doMock("../home/thread-swipe-actions", () => ({ ThreadSwipeable: box }));
  vi.doMock("../home/swipe-row-activation", () => ({ useSwipeRowDormant: () => false }));
  vi.doMock("../../lib/copyThreadReference", () => ({ copyThreadShell: () => {} }));
  vi.doMock("../../lib/copyTextWithHaptic", () => ({ copyTextWithHaptic: () => {} }));
  vi.doMock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => "light" }));
  vi.doMock("../../lib/clock", () => ({ useNowAfter: () => 0 }));
  vi.doMock("../../state/session", () => ({ useEnvironmentScope: () => false }));
  vi.doMock("../../state/use-atom-command", () => ({ useAtomCommand: () => () => {} }));
  vi.doMock("../../state/use-thread-pr", () => ({ useThreadPr: () => null }));
  vi.doMock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
  vi.doMock("../../state/thread-order", () => ({ threadArrangementOpenAtom: {} }));
  vi.doMock("./turnThreadIntoProject", () => ({
    canTurnThreadIntoProject: () => false,
    turnThreadIntoProject: () => {},
  }));
  vi.doMock("./use-pending-draft-branch", () => ({ usePendingDraftBranch: () => null }));
  vi.doMock("./queued-message-icon", () => ({ QueuedMessageIcon: () => null }));
  vi.doMock("./thread-search-match", () => ({ ThreadSearchMatchExcerpt: () => null }));
  vi.doMock("./thread-list-pane-clock", () => ({ ThreadListV2Duration: () => null }));
  const { ThreadListV2Row } = await import("./thread-list-v2-items");
  const noop = () => {};
  const container = document.createElement("div");
  const root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await act(async () =>
      root.render(
        <ThreadListV2Row
          thread={thread("root", { worktreePath: "C:\\", branch: "feature" })}
          variant="card"
          wokeAt={null}
          timeLabel=""
          snoozePresetMinute=""
          project={null}
          providers={undefined}
          providerInstance={null}
          environmentLabel={null}
          onSelectThread={noop}
          onOpenThreadPullRequests={noop}
          onDeleteThread={noop}
          onNewThreadOnBranch={noop}
          onRenameThread={noop}
          onRegenerateThreadTitle={noop}
          onMarkThreadUnread={noop}
          onSettleThread={async () => true}
          onSnoozeThread={noop}
          onUnsnoozeThread={noop}
          onUnsettleThread={noop}
          onArchiveThread={noop}
          onPinThread={noop}
          onUnpinThread={noop}
          onSetThreadAutoSettle={noop}
          settlementSupported={false}
          snoozeSupported={false}
          snoozePresets={[]}
          pinningSupported={false}
          autoSettleOptOutSupported={false}
          titleRegenerationSupported={false}
          onSwipeableWillOpen={noop}
          onSwipeableClose={noop}
        />,
      ),
    );
    expect(container.querySelector('[aria-label="root, in a worktree (feature)"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});
