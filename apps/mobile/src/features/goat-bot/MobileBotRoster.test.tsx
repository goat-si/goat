import { act } from "react";
import { createRoot } from "react-dom/client";
import { BotThreadRow } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  update: vi.fn(async () => {}),
  alert: vi.fn(),
  members: null as null | Record<string, unknown>,
  manage: {
    canCreate: true,
    canManage: true,
    canEdit: true,
    create: vi.fn(async () => ({ botId: "research", name: "Research" })),
    update: vi.fn(async () => null),
    hide: vi.fn(async () => true),
    remove: vi.fn(async () => true),
    restore: vi.fn(async () => true),
  },
  sheet: null as null | {
    mode: string;
    onSubmit: (changes: object) => Promise<string | null>;
  },
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Alert: { alert: state.alert },
}));
vi.mock("../../state/entities", () => ({ useNavigationThreadShells: () => [] }));
vi.mock("./useMobileBotPreview", () => ({ useMobileBotPreview: () => null }));
vi.mock("./useMobileBotRoster", () => ({
  useMobileBotRoster: () => ({
    bots: [],
    groups: { main: null, members: [], hidden: [], deleted: [] },
    supportsMembers: true,
    environmentId: "env",
    children: { rows: [], hasMore: false },
    slackEnabled: false,
    update: state.update,
    showMore: () => {},
    error: null,
  }),
}));
vi.mock("./MobileBotRosterView", () => ({
  MobileBotRosterView: (props: {
    onLongPressTask: (row: typeof task) => void;
    members?: Record<string, unknown>;
  }) => {
    state.members = props.members ?? null;
    return <button onClick={() => props.onLongPressTask(task)}>Menu</button>;
  },
}));
vi.mock("./useMobileBotManage", () => ({ useMobileBotManage: () => state.manage }));
vi.mock("./MobileNewBotModel", () => ({ MobileNewBotModel: () => null }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "request-1" }));
vi.mock("./MobileBotProfileSheet", () => ({
  MobileBotProfileSheet: (props: {
    mode: string;
    onSubmit: (changes: object) => Promise<string | null>;
  }) => {
    state.sheet = props;
    return null;
  },
}));
import { MobileBotRoster } from "./MobileBotRosterPanel";
const at = "2026-11-04T10:00:00.000Z";
const task = Schema.decodeUnknownSync(BotThreadRow)({
  kind: "task",
  task: { taskId: "task", title: "Review", status: "waiting_input", updatedAt: at },
  view: { taskId: "task", pinnedAt: null, doneAt: null, readThrough: null },
  lastActivityAt: at,
  unread: true,
  mainMessagesSinceQuiet: 0,
});
it("sends reversible view changes and read-through from the task menu", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(<MobileBotRoster selectedKey={null} onOpenBot={() => {}} onOpenChild={() => {}} />),
  );
  await act(async () => container.querySelector("button")?.click());
  const actions = state.alert.mock.calls[0]?.[2] as Array<{ onPress?: () => void }>;
  await act(async () => {
    actions[0]?.onPress?.();
    actions[1]?.onPress?.();
    actions[2]?.onPress?.();
  });
  expect(state.update.mock.calls).toEqual([
    [{ taskId: "task", pinned: true }],
    [{ taskId: "task", done: true }],
    [{ taskId: "task", readThrough: at }],
  ]);
  await act(async () => root.unmount());
});

const member = { botId: "research", name: "Research", hidden: false };
type Choice = { text: string; onPress?: () => void };
const choices = () => state.alert.mock.calls.at(-1)?.[2] as Array<Choice>;
const choose = (text: string) =>
  choices()
    .find((choice) => choice.text === text)
    ?.onPress?.();

it("hides a member, and deletes it only after the person confirms", async () => {
  state.alert.mockClear();
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(<MobileBotRoster selectedKey={null} onOpenBot={() => {}} onOpenChild={() => {}} />),
  );
  const members = state.members as { onLongPressBot: (entry: object) => void };
  await act(async () => members.onLongPressBot({ kind: "member", profile: member }));
  expect(choices().map((choice) => choice.text)).toEqual(["Edit", "Hide", "Delete", "Cancel"]);
  await act(async () => choose("Hide"));
  expect(state.manage.hide).toHaveBeenCalledWith(member, true);
  await act(async () => members.onLongPressBot({ kind: "member", profile: member }));
  await act(async () => choose("Delete"));
  expect(state.alert.mock.calls.at(-1)?.[1]).toBe(
    "Its conversation is archived; you can restore it.",
  );
  expect(state.manage.remove).not.toHaveBeenCalled();
  await act(async () => choose("Delete"));
  expect(state.manage.remove).toHaveBeenCalledWith(member);
  await act(async () => root.unmount());
});

it("restores a deleted member after the person confirms", async () => {
  state.alert.mockClear();
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(<MobileBotRoster selectedKey={null} onOpenBot={() => {}} onOpenChild={() => {}} />),
  );
  const members = state.members as { onPressDeleted: (bot: object) => void };
  await act(async () => members.onPressDeleted({ ...member, state: "deleted" }));
  await act(async () => choose("Restore"));
  expect(state.manage.restore).toHaveBeenCalledWith({ ...member, state: "deleted" });
  await act(async () => root.unmount());
});

it("creates a bot from New bot with one request id and opens its conversation", async () => {
  const opened = vi.fn();
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(<MobileBotRoster selectedKey={null} onOpenBot={opened} onOpenChild={() => {}} />),
  );
  const members = state.members as { onNewBot: () => void };
  await act(async () => members.onNewBot());
  expect(state.sheet?.mode).toBe("create");
  await act(async () => {
    await state.sheet?.onSubmit({ name: "Research", avatar: null, purpose: "" });
  });
  expect(state.manage.create).toHaveBeenCalledWith(
    { name: "Research", avatar: null, purpose: "" },
    null,
    "request-1",
  );
  expect(opened).toHaveBeenCalledWith({
    kind: "member",
    profile: { botId: "research", name: "Research" },
  });
  await act(async () => root.unmount());
});
