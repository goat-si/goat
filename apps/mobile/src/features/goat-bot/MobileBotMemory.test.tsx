import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  ChannelGatewayError,
  EnvironmentAuthorizationError,
  EnvironmentId,
  goatBotChangeNoteMessage,
  goatBotForgetNoteMessage,
} from "@goat/contracts";

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Pressable: ({
    children,
    onPress,
    disabled,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onPress} disabled={disabled}>
      {children}
    </button>
  ),
  TextInput: ({
    value,
    onChangeText,
    accessibilityLabel,
  }: {
    value?: string;
    onChangeText?: (text: string) => void;
    accessibilityLabel?: string;
  }) => (
    <textarea
      aria-label={accessibilityLabel}
      value={value}
      onChange={(event) => onChangeText?.(event.currentTarget.value)}
    />
  ),
}));
const state = vi.hoisted(() => ({
  data: null as unknown,
  cause: null as unknown,
  refresh: vi.fn(),
  requested: vi.fn(),
}));
vi.mock("../../state/channels", () => ({
  channelEnvironment: {
    listBotNotes: (target: unknown) => {
      state.requested(target);
      return "notes";
    },
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data: atom === null ? null : state.data,
    cause: atom === null ? null : state.cause,
    error: state.cause === null ? null : "failed",
    isPending: false,
    isSuccess: state.data !== null,
    refresh: state.refresh,
  }),
}));
import { MobileBotMemory } from "./MobileBotMemory";

const environmentId = EnvironmentId.make("env");
const older = { index: 0, date: null, text: "Keep replies short" };
const newer = { index: 1, date: "2026-11-07", text: 'Reply in "Korean"' };
const container = document.createElement("div");
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container.remove();
});

type Props = Partial<Parameters<typeof MobileBotMemory>[0]>;
function setup(options: { data?: unknown; cause?: unknown } = {}) {
  state.data =
    options.data === undefined
      ? { revision: "r", notes: [newer, older], truncated: false }
      : options.data;
  state.cause = options.cause ?? null;
  state.refresh.mockReset();
  state.requested.mockReset();
}
async function render(props: Props = {}) {
  document.body.appendChild(container);
  if (!root) root = createRoot(container);
  await act(async () =>
    root?.render(
      <MobileBotMemory
        environmentId={environmentId}
        connected
        supported
        member={false}
        {...props}
      />,
    ),
  );
}
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent === label);
async function press(label: string) {
  const target = button(label);
  expect(target).toBeDefined();
  await act(async () => target?.click());
}

it("lists notes newest first with their date and says how GOAT Bot uses them", async () => {
  setup();
  await render();
  expect(container.textContent).toContain(
    "GOAT Bot uses notes from its next conversation session. Notes are shared with Slack and iMessage.",
  );
  const text = container.textContent ?? "";
  expect(text.indexOf('2026-11-07Reply in "Korean"')).toBeLessThan(
    text.indexOf("UndatedKeep replies short"),
  );
  expect(text).not.toContain("Every bot on this computer shares these notes with GOAT Bot.");
});

it("says when there are no notes yet, and a member's tab says they are shared", async () => {
  setup({ data: { revision: null, notes: [], truncated: true } });
  await render({ member: true });
  expect(container.textContent).toContain(
    "No notes yet. Ask GOAT Bot to remember a standing rule.",
  );
  expect(container.textContent).toContain(
    "Every bot on this computer shares these notes with GOAT Bot.",
  );
});

it("Ask to forget drafts the quoted note and nothing else", async () => {
  setup();
  const onDraft = vi.fn();
  await render({ onDraft });
  await press("Ask to forget");
  expect(onDraft).toHaveBeenCalledTimes(1);
  expect(onDraft).toHaveBeenCalledWith(goatBotForgetNoteMessage(newer.text));
});

it("Ask to change asks for the new wording first, then drafts the quoted change", async () => {
  setup();
  const onDraft = vi.fn();
  await render({ onDraft });
  await press("Ask to change");
  const field = container.querySelector<HTMLTextAreaElement>('[aria-label="New wording"]')!;
  expect(field.value).toBe(newer.text);
  expect(button("Fill message")?.disabled).toBe(true);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(field, "Reply in English");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await press("Fill message");
  expect(onDraft).toHaveBeenCalledWith(goatBotChangeNoteMessage(newer.text, "Reply in English"));
});

it("cannot ask while the chat cannot send", async () => {
  setup();
  await render();
  expect(button("Ask to forget")?.disabled).toBe(true);
  expect(button("Ask to change")?.disabled).toBe(true);
});

it("offline says so and loads once GOAT Bot is back", async () => {
  setup();
  await render({ connected: false });
  expect(container.textContent).toContain("Notes are unavailable while GOAT Bot is offline.");
  expect(state.requested).not.toHaveBeenCalled();
  await render({ connected: true });
  expect(state.requested).toHaveBeenCalled();
  expect(container.textContent).toContain('Reply in "Korean"');
});

it("an older server is not asked for notes", async () => {
  setup();
  await render({ supported: false });
  expect(container.textContent).toContain("Notes need a newer GOAT server.");
  expect(state.requested).not.toHaveBeenCalled();
});

it.each([
  {
    name: "missing memory read",
    cause: new EnvironmentAuthorizationError({ message: "no", requiredScope: "memory:read" }),
    copy: "This device can't read GOAT Bot's notes.",
    retry: false,
  },
  {
    name: "not GOAT Bot's home",
    cause: new ChannelGatewayError({ reason: "not_home" }),
    copy: "GOAT Bot's notes are on its home computer.",
    retry: false,
  },
  {
    name: "other failure",
    cause: new Error("socket"),
    copy: "Couldn't load GOAT Bot's notes.",
    retry: true,
  },
])("shows why notes cannot load: $name", async ({ cause, copy, retry }) => {
  setup({ data: null, cause });
  await render();
  expect(container.textContent).toContain(copy);
  expect(button("Try again") !== undefined).toBe(retry);
  if (!retry) return;
  state.refresh.mockClear();
  await press("Try again");
  expect(state.refresh).toHaveBeenCalledTimes(1);
});

it("asks again when opened and whenever the bot answers or a task moves on", async () => {
  setup();
  await render({ refreshKey: "a" });
  expect(state.refresh).toHaveBeenCalledTimes(1);
  await render({ refreshKey: "a" });
  expect(state.refresh).toHaveBeenCalledTimes(1);
  await render({ refreshKey: "b" });
  expect(state.refresh).toHaveBeenCalledTimes(2);
});
