import {
  act,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { createRoot } from "react-dom/client";
import type { GoatBotRow, GoatBotTaskCard } from "@goat/client-runtime/goatBot";
import {
  BotProfile,
  EnvironmentId,
  goatBotChangeNoteMessage,
  goatBotForgetNoteMessage,
  ThreadId,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
vi.mock("./GoatBotHeroFace", () => ({ GoatBotHeroFace: () => null }));

const session = vi.hoisted(() => ({
  rows: [] as GoatBotRow[],
  canSend: true,
  onSend: vi.fn(() => true),
  notes: [] as Array<{ index: number; date: string | null; text: string }>,
  refresh: vi.fn(),
  attachments: false,
}));
// The message box's native focus and caret, and a photo the picker is still reading.
const box = vi.hoisted(() => ({
  // What the screen showed when focus arrived: the sheet, and the message box's text.
  focus: vi.fn(() => {
    box.atFocus = {
      sheet: document.querySelector('[aria-label="Work sheet"]') !== null,
      text: document.querySelector<HTMLTextAreaElement>('[aria-label="Message GOAT Bot"]')?.value,
    };
  }),
  atFocus: null as null | { sheet: boolean; text: string | undefined },
  platform: { OS: "ios" as "ios" | "android" },
  setSelection: vi.fn(),
  pick: null as null | ((value: { attachments: object[]; error?: string }) => void),
  fail: null as null | ((cause: Error) => void),
}));
// Editing a member from its chat reads secure storage and bot permissions; these tests do not.
vi.mock("./MobileNewBotNameRow", () => ({
  useMobileBotEditing: () => ({ nameRow: null, editSheet: null, openEdit: undefined }),
}));
vi.mock("../../lib/composerImages", () => ({
  pickComposerMedia: () =>
    new Promise((resolve, reject) => {
      box.pick = resolve;
      box.fail = reject;
    }),
  pickComposerFiles: async () => ({ files: [] }),
}));
vi.mock("../threads/ComposerAttachmentButton", () => ({
  ComposerAttachmentButton: (props: { onPickMedia: () => void }) => (
    <button onClick={props.onPickMedia}>Photo Library</button>
  ),
}));
vi.mock("../../components/ComposerAttachmentStrip", () => ({
  ComposerAttachmentStrip: () => null,
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../state/use-composer-drafts", () => ({
  releaseUnusedComposerAttachmentFiles: async () => {},
}));
vi.mock("../../lib/composerAttachmentFiles", () => ({
  retainComposerAttachmentFile: () => () => {},
}));
vi.mock("react-native", () => ({
  StyleSheet: { hairlineWidth: 1 },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  FlatList: (
    props: {
      data: ReadonlyArray<{ key: string }>;
      renderItem: (info: { item: { key: string }; index: number }) => ReactNode;
    } & Record<string, unknown>,
  ) => (
    <div>
      {props.data.map((item, index) => (
        <div key={item.key}>{props.renderItem({ item, index })}</div>
      ))}
    </div>
  ),
  // Like iOS, a sheet reports its dismissal once it has gone.
  Modal: function Modal({
    children,
    visible,
    onDismiss,
  }: {
    children?: ReactNode;
    visible: boolean;
    onDismiss?: () => void;
  }) {
    const shown = useRef(visible);
    useEffect(() => {
      // Only iOS reports a sheet's dismissal.
      if (shown.current && !visible && box.platform.OS === "ios") onDismiss?.();
      shown.current = visible;
    }, [visible, onDismiss]);
    return visible ? <section aria-label="Work sheet">{children}</section> : null;
  },
  Alert: { alert: vi.fn() },
  Switch: () => null,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Pressable: ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
  }) => (
    <button onClick={onPress} disabled={disabled} aria-label={accessibilityLabel}>
      {children}
    </button>
  ),
  TextInput: ({
    ref,
    value,
    onChangeText,
    accessibilityLabel,
    accessibilityState,
  }: {
    ref?: Ref<{ focus: () => void; setSelection: (start: number, end: number) => void }>;
    value?: string;
    onChangeText?: (text: string) => void;
    accessibilityLabel?: string;
    accessibilityState?: { disabled?: boolean };
  }) => {
    useImperativeHandle(ref, () =>
      accessibilityLabel?.startsWith("Message ")
        ? { focus: box.focus, setSelection: box.setSelection }
        : { focus: () => {}, setSelection: () => {} },
    );
    return (
      <textarea
        aria-label={accessibilityLabel}
        aria-disabled={accessibilityState?.disabled}
        value={value}
        onChange={(event) => onChangeText?.(event.currentTarget.value)}
      />
    );
  },
  Platform: box.platform,
  useWindowDimensions: () => ({ width: 393, height: 852 }),
}));
// The row menu is native; these tests do not open it.
vi.mock("./MobileBotRowMenu", () => ({
  MobileBotRowMenu: (props: { label: string; row?: ReactNode }) => (
    <>
      {props.row}
      <button aria-label={props.label} />
    </>
  ),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({
    themeAppearance: "light",
    appearance: { baseFontSize: 16 },
  }),
}));
vi.mock("../../components/GoatWordmark", () => ({ GoatWordmark: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("./useMobileGoatBotModel", () => ({ useMobileGoatBotModelMenu: () => null }));
vi.mock("./useMobileGoatBotMemberModel", () => ({ useMobileGoatBotMemberModelMenu: () => null }));
vi.mock("./GoatBotModelPill", () => ({ GoatBotModelPill: () => null }));
// The header chip opens the home; it renders as a button here.
vi.mock("../../lib/copyTextWithHaptic", () => ({ tryCopyTextWithHaptic: async () => true }));
vi.mock("./GoatBotFace", () => ({
  GoatBotHeaderFace: (props: { title: string; onPress?: () => void }) =>
    props.onPress ? (
      <button aria-label={`Open ${props.title} home`} onClick={props.onPress}>
        {props.title}
      </button>
    ) : null,
  GoatBotFaceAvatar: () => null,
  GoatBotChipFace: () => null,
  GoatBotProgressFace: () => null,
}));
vi.mock("./GoatBotShimmerText", () => ({ GoatBotShimmerText: () => null }));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
// The native Markdown renderer cannot load under Vitest.
vi.mock("./GoatBotMarkdown", () => ({ GoatBotMarkdown: () => null }));
vi.mock("@legendapp/list/react-native", () => ({ LegendList: () => null }));
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
// GOAT Bot's steps are read from the thread state, which loads the environment runtime.
vi.mock("../../state/threads", () => ({ environmentThreadDetails: {} }));
vi.mock("./useMobileGoatBotSession", () => ({
  // Like the real session, a deleted member's chat cannot send.
  useMobileGoatBotSession: (
    _visible: boolean,
    _taskId: unknown,
    member: { state?: string } | null = null,
  ) => ({
    availability: "ready",
    rows: session.rows,
    canSend: session.canSend && member?.state !== "deleted",
    attachmentSupport: session.attachments ? { maxUploadBytes: null } : null,
    onSend: session.onSend,
    onRetryInput: () => {},
    replyingSince: null,
    activity: null,
    supportsTaskThreads: true,
    streamingReplyIds: new Set<string>(),
    visibleTurnItems: [],
    boundedSnapshots: false,
  }),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("expo-crypto", () => ({ randomUUID: () => globalThis.crypto.randomUUID() }));
vi.mock("../../state/channels", () => ({
  channelEnvironment: {
    // Home's shared current work; its links are not read in this file.
    homeCurrentOpenableWorkAtom: () => "home-current",
    listBotThreads: () => "tasks",
    listChildWork: () => "child",
    listBotNotes: () => "notes",
    updateTaskView: { permissionAtom: () => "permission" },
  },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    scheduledTasksLive: () => "routines",
    setScheduledTaskEnabled: { permissionAtom: () => "permission" },
  },
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    presentationById: new Map([
      [
        "env",
        {
          serverConfig: {
            environment: { capabilities: { goatBotTaskThreads: true, goatBotNotes: true } },
          },
        },
      ],
    ]),
  }),
}));
vi.mock("./goatBotHomeMode", async (original) => ({
  ...(await original<typeof import("./goatBotHomeMode")>()),
  pickMobileGoatBotEnvironment: () => ({ environmentId: "env", connected: true }),
}));
vi.mock("./useMobileGoatBotHomeMode", () => ({
  useMobileGoatBotHomeMode: () => ({ environments: [], botRef: { threadId: "bot" } }),
}));
vi.mock("./MobileBotCheckInForm", () => ({ MobileBotCheckInForm: () => null }));
// A member's model menu reads server config and native menus this test does not load.
vi.mock("./useMobileGoatBotMemberModel", () => ({ useMobileGoatBotMemberModelMenu: () => null }));
vi.mock("./MobileBotStatusCard", () => ({ MobileBotStatusCard: () => null }));
// The home sheet's peek reads thread detail, which needs the native runtime.
vi.mock("./MobileBotPeek", () => ({ MobileBotPeek: () => null }));
vi.mock("./MobileBotComputer", () => ({ MobileBotComputer: () => null }));
vi.mock("./MobileBotLibrary", () => ({ MobileBotLibrary: () => null }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: string | null) =>
    atom === "notes"
      ? {
          data: { revision: "r", notes: session.notes, truncated: false },
          cause: null,
          error: null,
          isPending: false,
          isSuccess: true,
          refresh: session.refresh,
        }
      : {
          data: atom === "tasks" ? { rows: [] } : atom === "routines" ? { tasks: [] } : null,
          cause: null,
          error: null,
          isPending: false,
          isSuccess: true,
          refresh: () => {},
        },
}));

import { GoatBotScreen } from "./GoatBotScreen";

const note = { index: 0, date: "2026-11-07", text: 'Reply in "Korean"' };

async function render() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<GoatBotScreen visible />));
  return {
    container,
    rerender: () => act(async () => root.render(<GoatBotScreen visible />)),
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}
function setup() {
  session.canSend = true;
  session.rows = [];
  session.notes = [note];
  session.onSend.mockClear();
  session.refresh.mockReset();
  session.attachments = false;
  box.focus.mockClear();
  box.setSelection.mockClear();
  box.atFocus = null;
  box.platform.OS = "ios";
  box.pick = null;
}
const buttonIn = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll("button")].find(
    (button) => button.textContent === label || button.getAttribute("aria-label") === label,
  );
async function press(container: HTMLElement, label: string) {
  const button = buttonIn(container, label);
  expect(button, label).toBeDefined();
  await act(async () => button?.click());
}
async function openMemory(container: HTMLElement) {
  await press(container, "Open GOAT Bot home");
  await press(container, "Library");
}
const composer = (container: HTMLElement) =>
  container.querySelector<HTMLTextAreaElement>('[aria-label="Message GOAT Bot"]')!;

it("Ask to forget closes the sheet and puts the quoted note in the composer without sending", async () => {
  setup();
  const view = await render();
  await openMemory(view.container);
  await press(view.container, "Ask to forget");
  expect(view.container.querySelector('[aria-label="Work sheet"]')).toBeNull();
  expect(composer(view.container).value).toBe(goatBotForgetNoteMessage(note.text));
  expect(session.onSend).not.toHaveBeenCalled();
  await view.unmount();
});

it("Ask to change puts the quoted change in the composer without sending", async () => {
  setup();
  const view = await render();
  await openMemory(view.container);
  await press(view.container, "Ask to change");
  const field = view.container.querySelector<HTMLTextAreaElement>('[aria-label="New wording"]')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(field, "Reply in English");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await press(view.container, "Fill message");
  expect(composer(view.container).value).toBe(
    goatBotChangeNoteMessage(note.text, "Reply in English"),
  );
  expect(session.onSend).not.toHaveBeenCalled();
  await view.unmount();
});

const botRow: GoatBotRow = {
  kind: "bot",
  id: "reply-1",
  text: "On it.",
  createdAt: "2026-11-07T10:00:00.000Z",
  tone: "reply",
  proactive: false,
  replyTo: null,
  options: [],
  firstInGroup: true,
  groupPosition: "single",
};
const taskRow = (revision: number): GoatBotRow => {
  const card: GoatBotTaskCard = {
    key: "task-1",
    revision,
    updatedAt: "2026-11-07T10:01:00.000Z",
    title: "Forget a note",
    statusLabel: revision > 1 ? "Done" : "Working",
    tone: revision > 1 ? "success" : "active",
    sourceLabel: null,
    summary: null,
    attentionLabel: null,
    pullRequests: [],
    target: {
      kind: "thread",
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("task"),
    },
  };
  return {
    kind: "task",
    id: "card-1",
    createdAt: "2026-11-07T10:01:00.000Z",
    card,
    firstInGroup: true,
    groupPosition: "single",
  };
};

it("the open notes in Library read again after the answer and after the task finishes", async () => {
  setup();
  const view = await render();
  await openMemory(view.container);
  const opened = session.refresh.mock.calls.length;
  expect(opened).toBeGreaterThan(0);
  session.rows = [botRow];
  await view.rerender();
  expect(session.refresh).toHaveBeenCalledTimes(opened + 1);
  session.rows = [botRow, taskRow(1)];
  await view.rerender();
  expect(session.refresh).toHaveBeenCalledTimes(opened + 2);
  session.notes = [];
  session.rows = [botRow, taskRow(2)];
  await view.rerender();
  expect(session.refresh).toHaveBeenCalledTimes(opened + 3);
  expect(view.container.textContent).toContain("Ask GOAT Bot to remember a standing rule.");
  await press(view.container, "Close");
  await openMemory(view.container);
  expect(session.refresh).toHaveBeenCalledTimes(opened + 4);
  await view.unmount();
});
const decodeBotProfile = Schema.decodeUnknownSync(BotProfile);
const scout = (state: "active" | "deleted") =>
  decodeBotProfile({
    botId: "scout",
    role: "member",
    name: "Scout",
    avatar: null,
    purpose: "",
    defaultModelSelection: null,
    defaultProjectId: null,
    environmentId: "env",
    sessionThreadId: "thread-scout",
    createdAt: "2026-11-07T00:00:00.000Z",
    updatedAt: "2026-11-07T00:00:00.000Z",
    state,
  });
/**
 * Shaped like GoatBotRouteScreen: Restore is offered while the profile is deleted, and a
 * successful restore re-reads the bot list, which brings back the active profile.
 */
function DeletedScoutRoute(props: { readonly restoreWorks: boolean }) {
  const [member, setMember] = useState(() => scout("deleted"));
  return (
    <GoatBotScreen
      visible
      member={member}
      onRestoreMember={
        member.state === "deleted"
          ? async () => {
              if (props.restoreWorks) setMember(scout("active"));
              return props.restoreWorks;
            }
          : undefined
      }
    />
  );
}
async function renderDeletedScout(restoreWorks: boolean) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<DeletedScoutRoute restoreWorks={restoreWorks} />));
  return {
    container,
    // VoiceOver hears a composer it cannot type into as dimmed.
    composerDisabled: () =>
      container.querySelector('[aria-label="Message Scout"]')?.getAttribute("aria-disabled"),
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it("restoring a deleted member from its banner drops the banner and lets the person type again", async () => {
  setup();
  const view = await renderDeletedScout(true);
  expect(view.container.textContent).toContain("Scout was deleted");
  expect(view.composerDisabled()).toBe("true");
  await press(view.container, "Restore");
  expect(view.container.textContent).not.toContain("Scout was deleted");
  expect(buttonIn(view.container, "Restore")).toBeUndefined();
  expect(view.composerDisabled()).toBe("false");
  await view.unmount();
});

it("a failed restore keeps the deleted banner, its Restore button and the disabled composer", async () => {
  setup();
  const view = await renderDeletedScout(false);
  await press(view.container, "Restore");
  expect(view.container.textContent).toContain("Scout was deleted");
  expect(buttonIn(view.container, "Restore")?.disabled).toBe(false);
  expect(view.composerDisabled()).toBe("true");
  await view.unmount();
});

it("New routine closes the sheet and starts a routine request in the composer without sending", async () => {
  setup();
  const view = await render();
  await press(view.container, "Open GOAT Bot home");
  await press(view.container, "New routine");
  expect(view.container.querySelector('[aria-label="Work sheet"]')).toBeNull();
  expect(composer(view.container).value).toBe("Set up a routine: ");
  expect(session.onSend).not.toHaveBeenCalled();
  await view.unmount();
});

it("a drafted request keeps what the person already typed, and says why", async () => {
  setup();
  const { Alert } = await import("react-native");
  vi.mocked(Alert.alert).mockClear();
  const view = await render();
  await act(async () => {
    const field = composer(view.container);
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(field, "Half a thought");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await openMemory(view.container);
  await press(view.container, "Ask to forget");
  expect(composer(view.container).value).toBe("Half a thought");
  expect(Alert.alert).toHaveBeenCalledTimes(1);
  await view.unmount();
});
async function typeInto(field: HTMLTextAreaElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("a refused Fill message keeps the sheet open and the new wording the person wrote", async () => {
  setup();
  const view = await render();
  await typeInto(composer(view.container), "Half a thought");
  await openMemory(view.container);
  await press(view.container, "Ask to change");
  const wording = () =>
    view.container.querySelector<HTMLTextAreaElement>('[aria-label="New wording"]');
  await typeInto(wording()!, "Reply in English");
  await press(view.container, "Fill message");
  expect(view.container.querySelector('[aria-label="Work sheet"]')).not.toBeNull();
  expect(wording()?.value).toBe("Reply in English");
  expect(composer(view.container).value).toBe("Half a thought");
  // Ask to forget and New routine also leave the sheet where it was.
  await press(view.container, "Cancel");
  await press(view.container, "Ask to forget");
  expect(view.container.querySelector('[aria-label="Work sheet"]')).not.toBeNull();
  await press(view.container, "Home");
  await press(view.container, "New routine");
  expect(view.container.querySelector('[aria-label="Work sheet"]')).not.toBeNull();
  expect(composer(view.container).value).toBe("Half a thought");
  await view.unmount();
});

it("a photo the picker is still reading counts as a message in the box", async () => {
  setup();
  session.attachments = true;
  const { Alert } = await import("react-native");
  vi.mocked(Alert.alert).mockClear();
  const view = await render();
  await press(view.container, "Photo Library");
  expect(box.pick).not.toBeNull();
  await press(view.container, "Open GOAT Bot home");
  await press(view.container, "New routine");
  expect(composer(view.container).value).toBe("");
  expect(view.container.querySelector('[aria-label="Work sheet"]')).not.toBeNull();
  expect(Alert.alert).toHaveBeenCalledTimes(1);
  // Once the picker comes back empty, the box is free again.
  await act(async () => box.pick?.({ attachments: [] }));
  await press(view.container, "New routine");
  expect(composer(view.container).value).toBe("Set up a routine: ");
  await view.unmount();
});

it("a photo the picker could not read, or that failed outright, frees the box again", async () => {
  for (const settle of [
    () => box.pick?.({ attachments: [], error: "That file is too large." }),
    () => box.fail?.(new Error("The picker closed unexpectedly.")),
  ]) {
    setup();
    session.attachments = true;
    const view = await render();
    await press(view.container, "Photo Library");
    await press(view.container, "Open GOAT Bot home");
    await press(view.container, "New routine");
    expect(composer(view.container).value).toBe("");
    await act(async () => settle());
    await press(view.container, "New routine");
    expect(composer(view.container).value).toBe("Set up a routine: ");
    await view.unmount();
  }
});

it("an accepted request focuses the message box once the sheet has gone, caret at the end", async () => {
  setup();
  const view = await render();
  await press(view.container, "Open GOAT Bot home");
  await press(view.container, "New routine");
  expect(view.container.querySelector('[aria-label="Work sheet"]')).toBeNull();
  expect(box.focus).toHaveBeenCalledTimes(1);
  const end = "Set up a routine: ".length;
  expect(box.setSelection).toHaveBeenCalledWith(end, end);
  await view.unmount();
});
it("Android focuses the message box after the sheet has gone and the request is in it", async () => {
  setup();
  box.platform.OS = "android";
  const view = await render();
  // Android draws its own header chip, named for the bot.
  await press(view.container, "GOAT Bot");
  await press(view.container, "New routine");
  expect(box.focus).toHaveBeenCalledTimes(1);
  expect(box.atFocus).toEqual({ sheet: false, text: "Set up a routine: " });
  const end = "Set up a routine: ".length;
  expect(box.setSelection).toHaveBeenCalledWith(end, end);
  await view.unmount();
});

it("a note's new wording waits while the person clears the box, through closing and reopening the sheet", async () => {
  setup();
  const view = await render();
  await typeInto(composer(view.container), "Half a thought");
  await openMemory(view.container);
  await press(view.container, "Ask to change");
  const wording = () =>
    view.container.querySelector<HTMLTextAreaElement>('[aria-label="New wording"]');
  await typeInto(wording()!, "Reply in English");
  await press(view.container, "Fill message");
  // Refused: the person closes the sheet, clears the box, and comes back.
  await press(view.container, "Close");
  await typeInto(composer(view.container), "");
  await openMemory(view.container);
  expect(wording()?.value).toBe("Reply in English");
  await press(view.container, "Fill message");
  expect(composer(view.container).value).toBe(
    goatBotChangeNoteMessage(note.text, "Reply in English"),
  );
  // A successful fill lets the wording go.
  await openMemory(view.container);
  expect(wording()).toBeNull();
  await view.unmount();
});
