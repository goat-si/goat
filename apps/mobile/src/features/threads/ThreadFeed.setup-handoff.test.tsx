import { MessageId, RunId, TurnItemId } from "@goat/contracts";
import { createRef, type ReactNode } from "react";
import type { SharedValue } from "react-native-reanimated";
import type { LegendListRef } from "@legendapp/list/react-native";
import { expect, it, vi } from "vite-plus/test";
import {
  createNativeMemoryHarness,
  renderNative,
  nativeEnv,
} from "../../testing/memoryNativeHarness";
import { buildThreadFeed } from "../../lib/threadActivity";
import {
  projected,
  userMessage,
  command,
  assistantMessage,
  runId,
  threadId,
} from "../../lib/threadActivity.testkit";
import { resolveThreadFeedSubmissionAnchor } from "./thread-feed-live-follow";

vi.mock("react-native-reanimated", () => {
  const transition = { duration: () => ({}) };
  return {
    default: {
      View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
      ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    },
    FadeIn: transition,
    FadeInUp: transition,
    FadeOut: transition,
    LinearTransition: transition,
    ReduceMotion: { System: 0 },
    useAnimatedStyle: () => ({}),
    useSharedValue: (value: number) => ({ value, set: () => {} }),
    withTiming: (value: number) => value,
  };
});
vi.mock("./thread-subagent-group", () => ({ ThreadSubagentGroup: () => null }));
vi.mock("./ProposedPlanCard", () => ({ ProposedPlanCard: () => null }));
vi.mock("./FileChangeInlineDiff", () => ({ FileChangeInlineDiff: () => null }));
vi.mock("./BrowserAppIcon", () => ({ BrowserAppIcon: () => null }));
vi.mock("./ReplCodeText", () => ({ ReplCodeText: () => null, commandCodeText: () => "" }));
vi.mock("./threadComputerUseEntry", () => ({ threadComputerUseEntry: () => null }));
vi.mock("../pull-requests/PullRequestPresentation", () => ({ PullRequestDiffStats: () => null }));
vi.mock("../../components/GoatWordmark", () => ({ GoatWordmark: () => null }));
vi.mock("../../state/assets", () => ({ useAssetUrl: () => null }));
vi.mock("../../lib/appState", () => ({
  useAppActive: () => true,
  useReduceMotionEnabled: () => true,
}));
vi.mock("./work-shimmer-arbiter", async () => ({
  FeedEntryShimmerContext: (await import("react")).createContext(0),
  useWorkShimmerTurn: () => false,
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("@react-navigation/elements", async () => ({
  HeaderHeightContext: (await import("react")).createContext(0),
  useHeaderHeight: () => 0,
}));
vi.mock("./thread-work-log", () => ({
  collapsedWorkLogHeight: () => 40,
  THREAD_DISCLOSURE_TRANSITION_MS: 0,
  WORK_GROUP_TOGGLE_HEIGHT: 40,
  ThreadDisclosureChevron: () => null,
  ThreadWorkGroupToggle: () => null,
  ThreadThinkingRow: () => null,
  ThreadWorkLog: () => null,
  ShimmeringWorkContent: ({ label }: { label: string }) => <span>{label}</span>,
}));
vi.mock("./thread-workflow-opening", () => ({
  useWorkflowOpening: () => null,
  ThreadWorkflowOpening: () => null,
}));
vi.mock("./ThreadGuestShareBar", () => ({
  useThreadGuestShare: () => null,
  ThreadGuestPendingMessage: () => null,
}));
vi.mock("../layout/workspace-content-width", () => ({
  useWorkspaceSettledContentWidth: () => null,
}));
vi.mock("../../native/NativeWorkspaceColumns", () => ({
  useNativeWorkspaceColumnsSupported: () => false,
}));
vi.mock("../../native/native-layout-metrics", () => ({ useDeviceType: () => "phone" }));
vi.mock("../../native/useOpenPullRequest", () => ({ useOpenPullRequest: () => () => {} }));
vi.mock("./useFileChipShare", () => ({ useFileChipShare: () => () => {} }));
vi.mock("../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({ selectedThread: null }),
}));
vi.mock("../../native/useMarkdownImageSource", () => ({
  useMarkdownImageSource: () => () => null,
}));
vi.mock("../../state/presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentPresentations: { presentationAtom: () => Atom.make(null) },
    connectedEnvironmentIdsAtom: Atom.make([]),
    threadListEnvironmentsAtom: Atom.make([]),
    useEnvironmentPresentation: () => ({ isReady: true, presentation: null }),
  };
});
vi.mock("./MessageImageGalleryScope", () => ({
  MessageImageGalleryScope: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("./ThreadMarkdownVideo", async () => ({
  ThreadMediaVisibleContext: (await import("react")).createContext(false),
  ThreadMarkdownVideo: () => null,
}));
vi.mock("../../native/SelectableMarkdownText", () => ({ SelectableMarkdownText: () => null }));
vi.mock("../../components/VideoPreviewModal", () => ({ VideoPreviewModal: () => null }));
vi.mock("../../components/FilePreviewModal", () => ({ FilePreviewModal: () => null }));
vi.mock("./use-visible-second-clock", () => ({
  useVisibleSecondClock: () => Date.parse("2026-06-20T00:00:10.000Z"),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", async () => {
  const { getMobileThemeVariables } = await import("../../lib/mobileTheme");
  return {
    useAppearancePreferences: () => ({
      appearance: { baseFontSize: 14 },
      themeAppearance: "light",
      themeVariables: getMobileThemeVariables("goat-code", "light"),
    }),
  };
});
vi.mock("./work-log-layout", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    EXPANDABLE_ROW_MIN_HEIGHT: 44,
    WorkLogLabel: Container,
    WorkLogBlock: Container,
    WorkLogRows: Container,
    WorkLogIconSlot: Container,
    WorkLogPressable: Container,
  };
});
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../state/threads", () => ({ environmentThreadDetails: {}, threadEnvironment: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => () => {} }));
vi.mock("../cloud/dpop", async () => ({ layer: (await import("effect/Layer")).empty }));
vi.mock("expo", () => ({
  requireNativeModule: () => ({}),
  requireOptionalNativeModule: () => null,
  requireNativeView: () => () => null,
}));
vi.mock("expo-constants", () => ({
  default: { expoConfig: {}, executionEnvironment: "storeClient" },
}));
vi.mock("expo-haptics", () => ({}));
vi.mock("expo-clipboard", () => ({
  setStringAsync: async () => {},
  getStringAsync: async () => "",
}));
vi.mock("react-native-webview", () => ({ WebView: () => null }));
vi.mock("uniwind", () => ({
  withUniwind: (component: unknown) => component,
  useResolveClassNames: () => ({}),
}));
vi.mock("react-native-screens", () => ({
  Screen: () => null,
  ScreenStackHeaderConfig: () => null,
  ScrollViewMarker: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@goat/mobile-source-text", () => ({ SourceText: () => null }));
vi.mock(
  "@expo/ui/swift-ui",
  () => new Proxy({}, { get: (_target, key) => (key === "then" ? undefined : () => null) }),
);
vi.mock(
  "@expo/ui/swift-ui/modifiers",
  () => new Proxy({}, { get: (_target, key) => (key === "then" ? undefined : () => null) }),
);
vi.mock("expo-image", () => ({ Image: () => null }));
vi.mock("@expo/ui/community/masked-view", () => ({
  MaskedView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@legendapp/list/reanimated", () => ({ AnimatedLegendList: () => null }));
vi.mock("react-native-svg", () => ({
  default: () => null,
  Defs: () => null,
  LinearGradient: () => null,
  Rect: () => null,
  Stop: () => null,
}));
vi.mock("./thread-command-output", () => ({
  ThreadCommandOutput: () => null,
  useCommandOutputStreaming: () => false,
}));
vi.mock("../../state/queries", () => ({ useTurnItemDetail: () => ({ data: null, error: null }) }));
vi.mock("./useOpenLinkedThread", () => ({ useOpenLinkedThread: () => () => {} }));
vi.mock("./QuestionAnswerHistory", () => ({ QuestionAnswerHistory: () => <span>ANSWERED</span> }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("./ThreadMarkdownImage", async () => ({
  ThreadMarkdownImage: () => null,
  MarkdownImageAvailableWidthContext: (await import("react")).createContext(0),
}));
vi.mock("./ThreadInlineFilePreview", () => ({ ThreadInlineFilePreview: () => null }));
vi.mock("expo-audio", () => ({
  AudioModule: {},
  setAudioModeAsync: async () => {},
  setIsAudioActiveAsync: async () => {},
}));
vi.mock("../../components/FilePreviewGallery", () => ({ FilePreviewGallery: () => null }));
vi.mock("./worktree-setup-sheet", () => ({
  WorktreeSetupSheet: ({ children, onClose }: { children: ReactNode; onClose: () => void }) => (
    <div role="dialog">
      {children}
      <button onClick={onClose}>Close setup details</button>
    </div>
  ),
}));

vi.mock("@legendapp/list/keyboard", () => ({
  KeyboardAwareLegendList: ({
    data,
    renderItem,
    ListHeaderComponent,
    ListFooterComponent,
  }: {
    data: Array<{ id: string }>;
    renderItem: (info: { item: unknown; index: number }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
  }) => (
    <div>
      {ListHeaderComponent}
      {data.map((item, index) => (
        <div key={item.id} data-rowid={item.id}>
          {renderItem({ item, index })}
        </div>
      ))}
      {ListFooterComponent}
    </div>
  ),
}));
vi.mock("@legendapp/list/react-native", () => ({ useViewabilityAmount: () => {} }));
import { ThreadFeed } from "./ThreadFeed";

const shared = <T,>(value: T) => ({ value, get: () => value }) as SharedValue<T>;
const testFeed = () =>
  buildThreadFeed([projected(userMessage(), 0)]).map((entry) =>
    entry.type === "message" ? { ...entry, message: { ...entry.message, text: "" } } : entry,
  );

it("keeps one working row after setup and the first anchor on follow-up", async () => {
  const startedAt = "2026-06-20T00:00:01.000Z";
  const feed = testFeed();
  expect(feed).toHaveLength(1);
  const h = createNativeMemoryHarness();
  const props = {
    environmentId: nativeEnv,
    threadId,
    threadTitle: "Thread",
    detailRef: null,
    feed,
    queuedMessages: [],
    dispatchingMessageId: null,
    onEditPendingMessage: null,
    contentPresentation: { kind: "ready" as const },
    agentLabel: "Agent",
    latestRun: { runId, status: "running" as const, startedAt, completedAt: null },
    activeWorkStartedAt: startedAt,
    setupWorkingStartedAt: startedAt,
    listRef: createRef<LegendListRef>(),
    freeze: shared(false),
    anchorMessageId: MessageId.make("message-user"),
    contentInsetEndAdjustment: shared(0),
    keyboardOffset: 0,
  };
  const view = renderNative(h, <ThreadFeed {...props} />);
  try {
    await view.render();
    expect(view.container.textContent?.match(/Working for/g)).toHaveLength(1);
    expect(
      resolveThreadFeedSubmissionAnchor({
        currentAnchorMessageId: "message-user",
        submittedMessageId: "next",
        hasStartedTurn: true,
        hasUserMessage: true,
        queuedMessageCount: 0,
        deliveryDeferred: false,
      }),
    ).toBe("message-user");
  } finally {
    await view.unmount();
    h.dispose();
  }
});

it("displays background work and its action at the end of a working feed", async () => {
  const startedAt = "2026-06-20T00:00:01.000Z";
  const stop = vi.fn();
  const open = vi.fn();
  const h = createNativeMemoryHarness();
  const props = {
    environmentId: nativeEnv,
    threadId,
    threadTitle: "Thread",
    detailRef: null,
    feed: testFeed(),
    queuedMessages: [],
    dispatchingMessageId: null,
    onEditPendingMessage: null,
    contentPresentation: { kind: "ready" as const },
    agentLabel: "Agent",
    latestRun: { runId, status: "running" as const, startedAt, completedAt: null },
    activeWorkStartedAt: startedAt,
    listRef: createRef<LegendListRef>(),
    freeze: shared(false),
    anchorMessageId: null,
    contentInsetEndAdjustment: shared(0),
    keyboardOffset: 0,
    statusLines: [
      {
        key: "background",
        icon: "terminal" as const,
        label: "Running jobs",
        onOpen: open,
        action: {
          label: "Stop",
          accessibilityLabel: "Stop background work",
          disabled: false,
          onPress: stop,
        },
      },
    ],
  };
  const view = renderNative(h, <ThreadFeed {...props} />);
  try {
    await view.render();
    expect(view.container.textContent).toContain("Running jobs");
    await view.click("Running jobs");
    await view.click("Stop background work");
    expect(open).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  } finally {
    await view.unmount();
    h.dispose();
  }
});

it("keeps setup details open when setup finishes after handoff", async () => {
  const startedAt = "2026-06-20T00:00:01.000Z";
  const snapshot = {
    threadId,
    sequence: 1,
    phase: "running" as const,
    startedAt,
    endedAt: null,
    branch: "feature",
    baseRef: "main",
    worktreePath: null,
    setupScript: null,
    error: null,
    stages: [
      {
        id: "agent" as const,
        status: "done" as const,
        startedAt,
        endedAt: startedAt,
        percent: null,
        detail: null,
        tail: [],
      },
    ],
  };
  const setup = {
    snapshot,
    turnStarted: false,
    turnStartedAt: null,
    working: false,
    onCancel: () => {},
    onWorkLocally: null,
  };
  const h = createNativeMemoryHarness();
  const props = {
    environmentId: nativeEnv,
    threadId,
    threadTitle: "Thread",
    detailRef: null,
    feed: testFeed(),
    queuedMessages: [],
    dispatchingMessageId: null,
    onEditPendingMessage: null,
    contentPresentation: { kind: "ready" as const },
    agentLabel: "Agent",
    latestRun: { runId, status: "running" as const, startedAt, completedAt: null },
    activeWorkStartedAt: startedAt,
    listRef: createRef<LegendListRef>(),
    freeze: shared(false),
    anchorMessageId: null,
    contentInsetEndAdjustment: shared(0),
    keyboardOffset: 0,
  };
  const view = renderNative(
    h,
    <ThreadFeed {...props} {...{ worktreeSetup: setup, worktreeSetupDetails: setup }} />,
  );
  try {
    await view.render();
    await view.click("Worktree setup details");
    expect(view.container.querySelector('[role="dialog"]')).not.toBeNull();
    const done = {
      ...setup,
      turnStarted: true,
      snapshot: { ...snapshot, phase: "done" as const, sequence: 2, endedAt: startedAt },
    };
    await view.rerender(
      <ThreadFeed {...props} {...{ worktreeSetup: null, worktreeSetupDetails: done }} />,
    );
    expect(view.container.querySelector('[role="dialog"]')).not.toBeNull();
  } finally {
    await view.unmount();
    h.dispose();
  }
});

it("keeps background setup on the owning run when a follow-up starts", async () => {
  const startedAt = "2026-06-20T00:00:01.000Z";
  const nextRun = RunId.make("run-next");
  const followup = {
    ...userMessage(),
    id: TurnItemId.make("next-item"),
    messageId: MessageId.make("next"),
    runId: nextRun,
  };
  const feed = buildThreadFeed(
    [userMessage(), command(), assistantMessage(), followup].map((item, index) =>
      projected(item, index),
    ),
  ).map((entry) =>
    entry.type === "message" ? { ...entry, message: { ...entry.message, text: "" } } : entry,
  );
  const snapshot = {
    threadId,
    sequence: 1,
    phase: "running" as const,
    startedAt,
    endedAt: null,
    branch: "feature",
    baseRef: "main",
    worktreePath: null,
    setupScript: null,
    error: null,
    stages: [
      {
        id: "agent" as const,
        status: "done" as const,
        startedAt,
        endedAt: startedAt,
        percent: null,
        detail: null,
        tail: [],
      },
    ],
  };
  const setup = { snapshot, turnStarted: true, onCancel: () => {}, onWorkLocally: null };
  const h = createNativeMemoryHarness();
  const props = {
    environmentId: nativeEnv,
    threadId,
    threadTitle: "Thread",
    detailRef: null,
    feed,
    queuedMessages: [],
    dispatchingMessageId: null,
    onEditPendingMessage: null,
    contentPresentation: { kind: "ready" as const },
    agentLabel: "Agent",
    latestRun: { runId: nextRun, status: "running" as const, startedAt, completedAt: null },
    activeWorkStartedAt: startedAt,
    listRef: createRef<LegendListRef>(),
    freeze: shared(false),
    anchorMessageId: null,
    contentInsetEndAdjustment: shared(0),
    keyboardOffset: 0,
    worktreeSetup: setup,
    worktreeSetupDetails: setup,
  };
  const view = renderNative(h, <ThreadFeed {...props} />);
  try {
    await view.render();
    expect(view.container.querySelector(`[data-rowid="run-fold:${runId}"]`)?.textContent).toContain(
      "Background setup",
    );
    expect(
      view.container.querySelector(`[data-rowid="run-fold:${nextRun}"]`)?.textContent,
    ).not.toContain("Background setup");
  } finally {
    await view.unmount();
    h.dispose();
  }
});

it("keeps setup details reachable when the owning fold is absent", async () => {
  const startedAt = "2026-06-20T00:00:01.000Z";
  const setup = {
    snapshot: {
      threadId,
      sequence: 1,
      phase: "running" as const,
      startedAt,
      endedAt: null,
      branch: "feature",
      baseRef: "main",
      worktreePath: null,
      setupScript: null,
      error: null,
      stages: [
        {
          id: "agent" as const,
          status: "done" as const,
          startedAt,
          endedAt: startedAt,
          percent: null,
          detail: null,
          tail: [],
        },
      ],
    },
    turnStarted: true,
    onCancel: () => {},
    onWorkLocally: null,
  };
  const h = createNativeMemoryHarness();
  const props = {
    environmentId: nativeEnv,
    threadId,
    threadTitle: "Thread",
    detailRef: null,
    feed: testFeed(),
    queuedMessages: [],
    dispatchingMessageId: null,
    onEditPendingMessage: null,
    contentPresentation: { kind: "ready" as const },
    agentLabel: "Agent",
    latestRun: null,
    activeWorkStartedAt: null,
    listRef: createRef<LegendListRef>(),
    freeze: shared(false),
    anchorMessageId: null,
    contentInsetEndAdjustment: shared(0),
    keyboardOffset: 0,
    worktreeSetup: setup,
    worktreeSetupDetails: setup,
  };
  const view = renderNative(h, <ThreadFeed {...props} />);
  try {
    await view.render();
    expect(view.container.textContent).toContain("Background setup");
  } finally {
    await view.unmount();
    h.dispose();
  }
});

it("reopens finished setup details, preserves failure access, and shows nothing without setup", async () => {
  const startedAt = "2026-06-20T00:00:01.000Z";
  const stages = [
    {
      id: "agent" as const,
      status: "done" as const,
      startedAt,
      endedAt: startedAt,
      percent: null,
      detail: null,
      tail: [],
    },
    {
      id: "setup-script" as const,
      status: "done" as const,
      startedAt,
      endedAt: startedAt,
      percent: null,
      detail: null,
      tail: ["finished setup log"],
    },
  ];
  const snapshot = {
    threadId,
    sequence: 1,
    phase: "running" as const,
    startedAt,
    endedAt: null,
    branch: "feature",
    baseRef: "main",
    worktreePath: null,
    setupScript: null,
    error: null,
    stages,
  };
  const setup = { snapshot, turnStarted: false, onCancel: () => {}, onWorkLocally: null };
  const h = createNativeMemoryHarness();
  const props = {
    environmentId: nativeEnv,
    threadId,
    threadTitle: "Thread",
    detailRef: null,
    feed: testFeed(),
    queuedMessages: [],
    dispatchingMessageId: null,
    onEditPendingMessage: null,
    contentPresentation: { kind: "ready" as const },
    agentLabel: "Agent",
    latestRun: { runId, status: "running" as const, startedAt, completedAt: null },
    activeWorkStartedAt: startedAt,
    listRef: createRef<LegendListRef>(),
    freeze: shared(false),
    anchorMessageId: null,
    contentInsetEndAdjustment: shared(0),
    keyboardOffset: 0,
  };
  const view = renderNative(
    h,
    <ThreadFeed {...props} worktreeSetup={setup} worktreeSetupDetails={setup} />,
  );
  try {
    await view.render();
    await view.click("Worktree setup details");
    const done = {
      ...setup,
      turnStarted: true,
      snapshot: { ...snapshot, phase: "done" as const, sequence: 2, endedAt: startedAt },
    };
    await view.rerender(<ThreadFeed {...props} worktreeSetup={null} worktreeSetupDetails={done} />);
    await view.click("Close setup details");
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
    expect(view.container.querySelector('button[aria-label="Show setup details"]')).not.toBeNull();
    await view.click("Show setup details");
    expect(view.container.querySelector('[role="dialog"]')?.textContent).toContain(
      "finished setup log",
    );

    await view.click("Close setup details");
    const failed = {
      ...done,
      snapshot: { ...done.snapshot, phase: "failed" as const, error: "setup failed" },
    };
    await view.rerender(
      <ThreadFeed {...props} worktreeSetup={failed} worktreeSetupDetails={failed} />,
    );
    expect(
      view.container.querySelector(
        'button[aria-label="Worktree setup failed. Show setup details."]',
      ),
    ).not.toBeNull();
    expect(view.container.querySelector('button[aria-label="Show setup details"]')).toBeNull();
    await view.click("Worktree setup failed. Show setup details.");
    expect(view.container.querySelector('[role="dialog"]')?.textContent).toContain("setup failed");

    await view.click("Close setup details");
    await view.rerender(<ThreadFeed {...props} worktreeSetup={null} worktreeSetupDetails={null} />);
    expect(view.container.querySelector('button[aria-label="Show setup details"]')).toBeNull();
  } finally {
    await view.unmount();
    h.dispose();
  }
});
