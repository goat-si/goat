import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
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
    onClose: () => void;
    extraChanged?: boolean;
  },
  modelEditable: true,
  pickModel: null as null | ((model: object | null) => void),
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Alert: { alert: state.alert },
}));
vi.mock("./useMobileBotPreview", () => ({ useMobileBotPreview: () => null }));
vi.mock("./useMobileBotRoster", () => ({
  useMobileBotRoster: () => ({
    bots: [],
    groups: { main: null, members: [], hidden: [], deleted: [] },
    supportsMembers: true,
    environmentId: "env",
    slackEnabled: false,
    error: null,
  }),
}));
vi.mock("./MobileBotRosterView", () => ({
  MobileBotRosterView: (props: { members?: Record<string, unknown> }) => {
    state.members = props.members ?? null;
    return null;
  },
}));
vi.mock("./useMobileBotManage", () => ({ useMobileBotManage: () => state.manage }));
vi.mock("./useMobileGoatBotMemberModel", () => ({
  useMobileGoatBotMemberModelEditable: () => ({ editable: state.modelEditable }),
}));
vi.mock("./MobileNewBotModel", () => ({
  MobileNewBotModel: (props: { onChange: (model: object | null) => void }) => {
    state.pickModel = props.onChange;
    return null;
  },
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "request-1" }));
vi.mock("./MobileBotProfileSheet", () => ({
  MobileBotProfileSheet: (props: {
    mode: string;
    onSubmit: (changes: object) => Promise<string | null>;
    onClose: () => void;
    extraChanged?: boolean;
    children?: React.ReactNode;
  }) => {
    state.sheet = props;
    return <>{props.children}</>;
  },
}));
import { MobileBotRoster } from "./MobileBotRosterPanel";
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
  await act(async () => root.render(<MobileBotRoster selectedKey={null} onOpenBot={() => {}} />));
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
  await act(async () => root.render(<MobileBotRoster selectedKey={null} onOpenBot={() => {}} />));
  const members = state.members as {
    canRestore: boolean;
    onRestoreDeleted: (bot: object) => void;
  };
  expect(members.canRestore).toBe(true);
  await act(async () => members.onRestoreDeleted({ ...member, state: "deleted" }));
  await act(async () => choose("Restore"));
  expect(state.manage.restore).toHaveBeenCalledWith({ ...member, state: "deleted" });
  await act(async () => root.unmount());
});

it("creates a bot from New bot with one request id and opens its conversation", async () => {
  const opened = vi.fn();
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<MobileBotRoster selectedKey={null} onOpenBot={opened} />));
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

it("changes a member's model from Edit only where its server takes the change", async () => {
  state.alert.mockClear();
  state.manage.update.mockClear();
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<MobileBotRoster selectedKey={null} onOpenBot={() => {}} />));
  const members = state.members as { onLongPressBot: (entry: object) => void };
  const profile = { ...member, role: "member", defaultModelSelection: null };
  const luna = { instanceId: "codex", model: "luna" };
  const edit = async () => {
    state.pickModel = null;
    await act(async () => members.onLongPressBot({ kind: "member", profile }));
    await act(async () => choose("Edit"));
  };

  await edit();
  expect(state.sheet?.extraChanged).toBe(false);
  await act(async () => state.pickModel?.(luna));
  // A model alone is a change worth saving.
  expect(state.sheet?.extraChanged).toBe(true);
  await act(async () => {
    await state.sheet?.onSubmit({});
  });
  expect(state.manage.update).toHaveBeenLastCalledWith(profile, {}, luna);
  await act(async () => state.sheet?.onClose());

  // An older server drops the model, so the sheet neither offers nor sends one.
  state.modelEditable = false;
  await edit();
  expect(state.pickModel).toBeNull();
  await act(async () => {
    await state.sheet?.onSubmit({ name: "Research 2" });
  });
  expect(state.manage.update).toHaveBeenLastCalledWith(profile, { name: "Research 2" }, undefined);
  state.modelEditable = true;
  await act(async () => root.unmount());
});
