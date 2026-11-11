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
  rows: [] as GoatBotRow[],
  supportsTaskThreads: false,
  requestedTaskId: undefined as string | null | undefined,
  workTaskId: undefined as string | undefined,
  homeOpen: false,
  chatTasks: [] as ReadonlyArray<{ readonly key: string }>,
}));
// Event lines resolve their routine or task against the home's reads, which these tests do not load.
vi.mock("./useGoatBotEventTargets", () => ({
  useGoatBotEventTargets: () => ({ land: () => null, key: "" }),
}));
vi.mock("./MobileBotWork", () => ({
  MobileBotWork: (props: {
    taskId?: string;
    taskCard?: ReactNode;
    chatTasks?: ReadonlyArray<{ readonly key: string }>;
    open?: boolean;
  }) => {
    screenSession.workTaskId = props.taskId;
    screenSession.homeOpen = props.open ?? false;
    screenSession.chatTasks = props.chatTasks ?? [];
    return <section aria-label="Task header">{props.taskCard}</section>;
  },
}));
const list = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
  scrollToIndex: vi.fn(),
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

vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({
    themeAppearance: appearance.mode,
    appearance: { baseFontSize: appearance.baseFontSize },
  }),
}));
vi.mock("react-native", () => ({
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
    accessibilityLabel,
    onPress,
  }: {
    children?: ReactNode;
    style?: unknown;
    accessibilityLabel?: string;
    onPress?: () => void;
  }) => (
    <button data-style={JSON.stringify(style)} aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
  TextInput: ({
    style,
    value,
    onChangeText,
  }: {
    style?: unknown;
    value?: string;
    onChangeText?: (text: string) => void;
  }) => (
    <input
      aria-label="Message GOAT Bot"
      data-style={JSON.stringify(style)}
      value={value ?? ""}
      onChange={(event) => onChangeText?.(event.currentTarget.value)}
    />
  ),
  Platform: { OS: "ios" },
  AccessibilityInfo: { announceForAccessibility: a11y.announce, setAccessibilityFocus: a11y.focus },
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
vi.mock("./GoatBotModelPill", () => ({
  GoatBotModelPill: (props: { menu: { label: string; opens: boolean } }) => (
    <button aria-label="Model" data-opens={String(props.menu.opens)}>
      {props.menu.label}
    </button>
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
      <div>{props.render?.({ item: props.item })}</div>
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
          {props.data?.map((item) => (
            <Row key={item.id} item={item} extra={props.extraData} render={props.renderItem} />
          ))}
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
      onSend: () => true,
      onRetryInput: () => {},
      replyingSince: null,
      activity: screenSession.activity,
      supportsTaskThreads: screenSession.supportsTaskThreads,
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

export { a11y, appearance, layouts, list, models, picker, screenSession };
