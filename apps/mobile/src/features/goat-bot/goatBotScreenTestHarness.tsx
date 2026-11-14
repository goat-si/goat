import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { GoatBotActivity, GoatBotRow } from "@goat/client-runtime/goatBot";
import { vi } from "vite-plus/test";

// The GoatBotScreen DOM harness: native modules, the session, the list and the composer, mocked
// once for the screen's appearance and unread suites.
const appearance = vi.hoisted(() => ({
  mode: "dark" as "light" | "dark",
  baseFontSize: 16,
}));
const screenSession = vi.hoisted(() => ({
  activity: null as GoatBotActivity | null,
  faceShell: null as unknown,
  rows: [] as GoatBotRow[],
  supportsTaskThreads: false,
  requestedTaskId: undefined as string | null | undefined,
  workTaskId: undefined as string | undefined,
  homeOpen: false,
  chatTasks: [] as ReadonlyArray<{ readonly key: string }>,
  send: vi.fn((_text: string, _attachments?: unknown) => true),
  answer: vi.fn((_text: string, _taskId?: string, _questionId?: string) => true),
  // What the home sheet calls to fill the message box (New routine, a note's change).
  draft: null as null | ((text: string) => boolean),
  // The home sheet's Edit bot, and its report that the sheet has gone.
  editBot: null as null | (() => void),
  homeGone: null as null | (() => void),
  // The conversation the session shows, and what its server can do.
  visibleTurnItems: [] as ReadonlyArray<unknown>,
  boundedSnapshots: false,
  environmentId: null as string | null,
  threadId: null as string | null,
}));
// Event lines resolve their routine or task against the home's reads, which these tests do not load.
// Chat file cards read the Library through the environment runtime; GoatBotTimelineRow.files.test covers them.
// The provider stands in, but the chat's own opener is real: its viewer shows, and a test opens an
// image through it.
const chatFiles = vi.hoisted(() => ({
  opener: null as null | { open: (file: { relativePath: string }) => Promise<void> },
  // Each time a reply's file cards mount: a row mounted again starts its preview reads over.
  cardMounts: 0,
}));
vi.mock("./GoatBotReplyFiles", async () => {
  const React = await import("react");
  return {
    GoatBotFilesProvider: (props: {
      children?: ReactNode;
      opener?: { open: (file: { relativePath: string }) => Promise<void>; viewer: ReactNode };
    }) => {
      chatFiles.opener = props.opener ?? null;
      return (
        <>
          {props.children}
          {props.opener?.viewer}
        </>
      );
    },
    GoatBotReplyFiles: function ReplyFiles() {
      // Counted once per mount, as a card's first preview read would be.
      React.useState(() => {
        chatFiles.cardMounts += 1;
        return null;
      });
      return null;
    },
    chatFilesScope: (environmentId: string | null, threadId: string | null) =>
      JSON.stringify([environmentId, threadId]),
  };
});
vi.mock("./openBotLibraryFile", () => ({
  openBotLibraryFile: async (_environmentId: string, relativePath: string) => ({
    kind: "image",
    preview: {
      name: relativePath,
      file: { uri: "file:///cache/" + relativePath, dispose: () => {}, share: async () => {} },
    },
  }),
}));
// The thread state GOAT Bot's steps are read from: each thread's items, and when a reader holds or
// lets go of one.
const threadReads = vi.hoisted(() => ({
  held: [] as string[],
  released: [] as string[],
  itemsAtom: null as
    | null
    | ((key: string) => import("effect/reactivity").Atom.Writable<ReadonlyArray<unknown>>),
}));
vi.mock("../../state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  const items = Atom.family((_key: string) =>
    Atom.make<ReadonlyArray<unknown>>([]).pipe(Atom.keepAlive),
  );
  threadReads.itemsAtom = items;
  const quiet = Atom.family((key: string) =>
    Atom.make((get) => {
      threadReads.held.push(key);
      get.addFinalizer(() => threadReads.released.push(key));
      return get(items(key));
    }),
  );
  const whole = Atom.make({ hasMoreHistory: false });
  const keyOf = (ref: { environmentId: string; threadId: string }) =>
    ref.environmentId + "\u0000" + ref.threadId;
  return {
    // The visit write is the transport; a test that needs it stands in for useAtomCommand.
    threadEnvironment: { visit: "visit" },
    environmentThreadDetails: {
      quietVisibleTurnItemsAtom: (ref: { environmentId: string; threadId: string }) =>
        quiet(keyOf(ref)),
      historyAtom: () => whole,
    },
  };
});
// Editing a member from its chat: who may edit, the edit itself, and this device's dismissals.
const botEditing = vi.hoisted(() => ({
  canEdit: false,
  update: vi.fn(async (..._args: unknown[]): Promise<string | null> => null),
  stored: null as string | null,
  writes: [] as string[],
  // The Edit bot sheet the chat opened: its bot, the name it starts from, and how to close it.
  sheet: null as null | { botId: string; draftName?: string; onClose: () => void },
}));
vi.mock("./MobileBotEditSheet", () => ({
  MobileBotEditSheet: (props: {
    bot: { botId: string };
    draftName?: string;
    onClose: () => void;
  }) => {
    botEditing.sheet = {
      botId: props.bot.botId,
      draftName: props.draftName,
      onClose: props.onClose,
    };
    return <div role="dialog" aria-label="Edit bot" />;
  },
}));
vi.mock("./useMobileBotManage", () => ({
  useMobileBotManage: () => ({ canEdit: botEditing.canEdit, update: botEditing.update }),
}));
vi.mock("../../lib/protectedData", () => ({ whenProtectedDataAvailable: async () => {} }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => botEditing.stored,
  setItemAsync: async (_key: string, value: string) => {
    botEditing.writes.push(value);
  },
}));
vi.mock("./useGoatBotEventTargets", () => ({
  useGoatBotEventTargets: () => ({ land: () => null, key: "" }),
}));
vi.mock("./MobileBotWork", () => ({
  MobileBotWork: (props: {
    taskId?: string;
    taskCard?: ReactNode;
    heroFace?: ReactNode;
    chatTasks?: ReadonlyArray<{ readonly key: string }>;
    open?: boolean;
    onDraft?: (text: string) => boolean;
    onEditBot?: () => void;
    onDismissed?: () => void;
  }) => {
    screenSession.workTaskId = props.taskId;
    screenSession.homeOpen = props.open ?? false;
    screenSession.chatTasks = props.chatTasks ?? [];
    screenSession.draft = props.onDraft ?? null;
    screenSession.editBot = props.onEditBot ?? null;
    screenSession.homeGone = props.onDismissed ?? null;
    return (
      <section aria-label="Task header">
        {props.heroFace}
        {props.taskCard}
      </section>
    );
  },
}));
const list = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
  scrollToIndex: vi.fn(),
  // Rows whose cells are scrolled out of the window: their items stay in the data.
  unmounted: new Set<string>(),
}));
vi.mock("./GoatBotFace", () => ({
  GoatBotHeaderFace: (props: { title: string; onPress?: () => void }) =>
    props.onPress ? (
      <button aria-label={`Chip ${props.title}`} onClick={props.onPress}>
        {props.title}
      </button>
    ) : null,
  GoatBotProgressFace: (props: { state: string; inView: boolean }) => (
    <i data-face={`${props.state}:${props.inView}`} />
  ),
  GoatBotFaceAvatar: (props: {
    state: string;
    emoji?: string | null;
    accent?: { background: string } | null;
  }) => (
    <i
      data-avatar={props.state}
      data-avatar-emoji={props.emoji}
      data-avatar-accent={props.accent?.background}
    />
  ),
}));
vi.mock("./GoatBotShimmerText", () => ({
  GoatBotShimmerText: (props: { label: string; animate: boolean; style?: unknown }) => (
    <span data-sweep={String(props.animate)} data-style={JSON.stringify(props.style)}>
      {props.label}
    </span>
  ),
}));
const picker = vi.hoisted(() => ({
  onPicked: null as
    | ((files: ReadonlyArray<import("../../lib/composerImages").DraftComposerAttachment>) => void)
    | null,
  release: vi.fn(),
}));
export type LayoutHandler = (event: { nativeEvent: { layout: { height: number } } }) => void;
const layouts = vi.hoisted(() => new Map<string, LayoutHandler>());
const a11y = vi.hoisted(() => ({ announce: vi.fn(), focus: vi.fn() }));
// The app's state as React Native reports it, and whether the screen has navigation focus; a route
// test moves them as the system would.
const device = vi.hoisted(() => {
  const listeners = new Set<(next: string) => void>();
  return {
    focused: true,
    appState: "active" as "active" | "inactive" | "background",
    listeners,
    setAppState(next: "active" | "inactive" | "background") {
      device.appState = next;
      for (const listener of listeners) listener(next);
    },
  };
});

vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({
    themeAppearance: appearance.mode,
    appearance: { baseFontSize: appearance.baseFontSize },
  }),
}));
vi.mock("react-native", () => ({
  StyleSheet: { hairlineWidth: 1 },
  View: ({
    children,
    style,
    className,
    testID,
    onLayout,
    accessibilityLiveRegion,
    accessibilityLabel,
    ref,
  }: {
    children?: ReactNode;
    style?: unknown;
    className?: string;
    testID?: string;
    onLayout?: LayoutHandler;
    accessibilityLiveRegion?: string;
    accessibilityLabel?: string;
    ref?: import("react").Ref<HTMLDivElement>;
  }) => {
    if (testID && onLayout) layouts.set(testID, onLayout);
    return (
      <div
        ref={ref}
        data-testid={testID}
        data-style={JSON.stringify(style)}
        data-class={className}
        data-live={accessibilityLiveRegion}
        aria-label={accessibilityLabel}
      >
        {children}
      </div>
    );
  },
  Text: ({
    children,
    style,
    className,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    style?: unknown;
    className?: string;
    accessibilityLabel?: string;
  }) => (
    <span data-style={JSON.stringify(style)} data-class={className} aria-label={accessibilityLabel}>
      {children}
    </span>
  ),
  Pressable: ({
    children,
    style,
    className,
    accessibilityLabel,
    accessibilityHint,
    accessibilityState,
    disabled,
    onPress,
  }: {
    children?: ReactNode;
    style?: unknown;
    className?: string;
    accessibilityLabel?: string;
    accessibilityHint?: string;
    accessibilityState?: { expanded?: boolean };
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button
      data-style={JSON.stringify(style)}
      data-class={className}
      aria-label={accessibilityLabel}
      aria-expanded={accessibilityState?.expanded}
      data-hint={accessibilityHint}
      disabled={disabled}
      onClick={onPress}
    >
      {children}
    </button>
  ),
  TextInput: ({
    style,
    value,
    onChangeText,
    accessibilityLabel,
  }: {
    style?: unknown;
    value?: string;
    onChangeText?: (text: string) => void;
    accessibilityLabel?: string;
  }) => (
    <input
      // Every chat's message box answers to one label here; other fields keep their own.
      aria-label={
        accessibilityLabel === undefined || accessibilityLabel.startsWith("Message ")
          ? "Message GOAT Bot"
          : accessibilityLabel
      }
      data-style={JSON.stringify(style)}
      value={value ?? ""}
      onChange={(event) => onChangeText?.(event.currentTarget.value)}
    />
  ),
  Modal: (props: { visible?: boolean; children?: ReactNode }) =>
    props.visible ? <div role="dialog">{props.children}</div> : null,
  Image: (props: { accessibilityLabel?: string }) => <img alt={props.accessibilityLabel} />,
  ScrollView: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  Platform: { OS: "ios" },
  AccessibilityInfo: {
    announceForAccessibility: a11y.announce,
    setAccessibilityFocus: a11y.focus,
    addEventListener: () => ({ remove: () => {} }),
    isReduceMotionEnabled: async () => false,
  },
  AppState: {
    get currentState() {
      return device.appState;
    },
    addEventListener: (_type: "change", listener: (next: string) => void) => {
      device.listeners.add(listener);
      return { remove: () => device.listeners.delete(listener) };
    },
  },
  findNodeHandle: (node: unknown) => node ?? null,
  useWindowDimensions: () => ({ width: 393, height: 852 }),
}));
vi.mock("../../components/GoatWordmark", () => ({ GoatWordmark: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
const models = vi.hoisted(() => ({
  main: null as null | Record<string, unknown>,
  member: null as null | Record<string, unknown>,
}));
vi.mock("./useMobileGoatBotModel", () => ({ useMobileGoatBotModelMenu: () => models.main }));
vi.mock("./useMobileGoatBotMemberModel", () => ({
  useMobileGoatBotMemberModelMenu: () => models.member,
}));
// The real model pill renders; only the native menu it opens stands in, as a box that keeps its style.
vi.mock("../../components/ui/Menu", () => ({
  Menu: (props: { children?: ReactNode; style?: unknown }) => (
    <div data-box="model-menu" data-style={JSON.stringify(props.style ?? null)}>
      {props.children}
    </div>
  ),
}));
vi.mock("../../lib/copyTextWithHaptic", () => ({ tryCopyTextWithHaptic: async () => true }));
// The native Markdown renderer cannot load under Vitest.
vi.mock("./GoatBotMarkdown", () => ({ GoatBotMarkdown: () => null }));
vi.mock("./GoatBotComposerAttachments", () => ({
  GoatBotAttachButton: (props: { onPicked: typeof picker.onPicked }) => {
    picker.onPicked = props.onPicked;
    return null;
  },
  GoatBotAttachmentStrip: () => null,
  releaseGoatBotAttachments: picker.release,
}));
vi.mock("@legendapp/list/react-native", async () => {
  const { memo } = await import("react");
  type Render = ((item: { item: GoatBotRow }) => ReactNode) | undefined;
  // Like LegendList, a mounted row draws again only when its item or extraData changes.
  const Row = memo(
    (props: { item: GoatBotRow; extra: unknown; render: Render }) => (
      <div data-row={props.item.id}>{props.render?.({ item: props.item })}</div>
    ),
    (before, after) => before.item === after.item && before.extra === after.extra,
  );
  return {
    LegendList: (props: {
      data?: GoatBotRow[];
      renderItem?: Render;
      extraData?: unknown;
      ListFooterComponent?: ReactNode;
      ref?: { current: unknown };
    }) => {
      list.props = props;
      if (props.ref) props.ref.current = { scrollToIndex: list.scrollToIndex };
      return (
        <>
          {props.data?.map((item) =>
            list.unmounted.has(item.id) ? null : (
              <Row key={item.id} item={item} extra={props.extraData} render={props.renderItem} />
            ),
          )}
          {props.ListFooterComponent}
        </>
      );
    },
  };
});
vi.mock("@react-navigation/elements", async () => ({
  HeaderHeightContext: (await import("react")).createContext<number | undefined>(undefined),
}));
vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => device.focused,
  useNavigation: () => ({ dispatch: () => {} }),
  StackActions: { push: (name: string, params: object) => ({ name, params }) },
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: (props: { children?: unknown }) => props.children },
  useAnimatedStyle: (style: () => object) => style(),
}));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardAvoidingView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useReanimatedKeyboardAnimation: () => ({ progress: { value: 0 } }),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ bottom: 0, top: 0 }),
}));
vi.mock("../../native/NativeScrollViewMarker", () => ({ NativeScrollView: () => null }));
vi.mock("../settings/SettingsMemoryRouteScreen", () => ({ MemoryReportLink: () => null }));
vi.mock("../workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => () => {},
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteConnectionStatus: () => ({ connectedEnvironments: [] }),
}));
vi.mock("./useMobileGoatBotHomeSettings", () => ({
  useMobileGoatBotHomeSettings: () => ({ moveTarget: null, error: null }),
}));
vi.mock("./useMobileGoatBotSession", () => ({
  useMobileGoatBotSession: (_visible: boolean, taskId?: string | null) => {
    screenSession.requestedTaskId = taskId;
    return {
      availability: "ready",
      rows: screenSession.rows,
      canSend: true,
      attachmentSupport: { maxUploadBytes: null },
      onSend: screenSession.send,
      onAnswer: screenSession.answer,
      onRetryInput: () => {},
      replyingSince: null,
      activity: screenSession.activity,
      supportsTaskThreads: screenSession.supportsTaskThreads,
      streamingReplyIds: new Set<string>(),
      visibleTurnItems: screenSession.visibleTurnItems,
      boundedSnapshots: screenSession.boundedSnapshots,
      historyEnvironmentId: screenSession.environmentId,
      threadId: screenSession.threadId,
    };
  },
}));

export const props = {
  canSend: true,
  onSend: () => true,
  onRetry: () => {},
  onSelectThread: () => {},
};
export const bot: Extract<GoatBotRow, { kind: "bot" }> = {
  kind: "bot",
  id: "bot",
  text: "Could not continue",
  createdAt: "2026-10-12T09:40:00Z",
  tone: "failure",
  proactive: false,
  replyTo: null,
  options: ["Try again"],
  firstInGroup: true,
  groupPosition: "single",
};

export async function typeInto(container: HTMLElement, value: string) {
  const input = container.querySelector<HTMLInputElement>('[aria-label="Message GOAT Bot"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export async function render(element: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return {
    container,
    rerender: async (next: ReactNode) => {
      await act(async () => root.render(next));
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

export {
  a11y,
  appearance,
  botEditing,
  chatFiles,
  device,
  layouts,
  list,
  models,
  picker,
  screenSession,
  threadReads,
};
