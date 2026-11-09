import { act, useState, type ReactNode } from "react";
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

const session = vi.hoisted(() => ({
  rows: [] as GoatBotRow[],
  canSend: true,
  onSend: vi.fn(() => true),
  notes: [] as Array<{ index: number; date: string | null; text: string }>,
  refresh: vi.fn(),
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Modal: ({ children, visible }: { children?: ReactNode; visible: boolean }) =>
    visible ? <section aria-label="Work sheet">{children}</section> : null,
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
    value,
    onChangeText,
    accessibilityLabel,
    accessibilityState,
  }: {
    value?: string;
    onChangeText?: (text: string) => void;
    accessibilityLabel?: string;
    accessibilityState?: { disabled?: boolean };
  }) => (
    <textarea
      aria-label={accessibilityLabel}
      aria-disabled={accessibilityState?.disabled}
      value={value}
      onChange={(event) => onChangeText?.(event.currentTarget.value)}
    />
  ),
  Platform: { OS: "ios" },
  useWindowDimensions: () => ({ width: 393, height: 852 }),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({
    themeAppearance: "light",
    appearance: { baseFontSize: 16 },
  }),
}));
vi.mock("../../components/GoatWordmark", () => ({ GoatWordmark: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("./GoatBotFace", () => ({ GoatBotHeaderFace: () => null }));
// Work sits in the iOS header's trailing items; they render as buttons here.
vi.mock("../../native/StackHeader", () => ({
  NativeStackScreenOptions: ({
    options,
  }: {
    options: {
      unstable_headerRightItems: () => {
        label: string;
        accessibilityLabel: string;
        onPress: () => void;
      }[];
    };
  }) =>
    options.unstable_headerRightItems().map((item) => (
      <button key={item.label} aria-label={item.accessibilityLabel} onClick={item.onPress}>
        {item.label}
      </button>
    )),
}));
// The native Markdown renderer cannot load under Vitest.
vi.mock("./GoatBotMarkdown", () => ({ GoatBotMarkdown: () => null }));
vi.mock("./GoatBotComposerAttachments", () => ({
  GoatBotAttachButton: () => null,
  GoatBotAttachmentStrip: () => null,
  releaseGoatBotAttachments: () => {},
}));
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
    attachmentSupport: null,
    onSend: session.onSend,
    onRetryInput: () => {},
    replyingSince: null,
    activity: null,
    supportsTaskThreads: true,
  }),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("expo-crypto", () => ({ randomUUID: () => globalThis.crypto.randomUUID() }));
vi.mock("../../state/channels", () => ({
  channelEnvironment: {
    listBotThreads: () => "tasks",
    listChildWork: () => "child",
    listBotNotes: () => "notes",
    updateTaskView: {},
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
vi.mock("./GoatBotMemberModelAndroidMenu", () => ({ GoatBotMemberModelAndroidMenu: () => null }));
vi.mock("./useMobileGoatBotMemberModel", () => ({ useMobileGoatBotMemberModelMenu: () => null }));
vi.mock("./MobileBotStatusCard", () => ({ MobileBotStatusCard: () => null }));
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
  await press(container, "Open GOAT Bot work");
  await press(container, "Memory");
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

it("the open Memory tab reads the notes again after the answer and after the task finishes", async () => {
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
  expect(view.container.textContent).toContain(
    "No notes yet. Ask GOAT Bot to remember a standing rule.",
  );
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
