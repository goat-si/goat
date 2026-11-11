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
    create: vi.fn(async (..._args: unknown[]): Promise<object | string> => ({
      botId: "research",
      name: "Research",
      avatar: null,
      purpose: "",
      defaultModelSelection: null,
    })),
    update: vi.fn(async (..._args: unknown[]): Promise<string | null> => null),
    hide: vi.fn(async () => true),
    remove: vi.fn(async () => true),
    restore: vi.fn(async () => true),
  },
  sheet: null as null | {
    mode: string;
    onSubmit: (changes: object) => Promise<string | null>;
    onClose: () => void;
    extraChanged?: boolean;
    colorEditable?: boolean;
  },
  modelEditable: true,
  colorEditable: true,
  pickModel: null as null | ((model: object | null) => void),
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Alert: { alert: state.alert },
}));
vi.mock("./useMobileBotPreview", () => ({ useMobileBotPreview: () => null }));
vi.mock("./useMobileGoatBotHomeMode", () => ({
  useMobileGoatBotHomeMode: () => ({ botRef: null }),
}));
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
  useMobileGoatBotColorEditable: () => state.colorEditable,
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
    colorEditable?: boolean;
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
    profile: {
      botId: "research",
      name: "Research",
      avatar: null,
      purpose: "",
      defaultModelSelection: null,
    },
  });
  expect(state.manage.update).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

it("a retry after a create the server kept, though the phone saw it fail, still carries the edits", async () => {
  state.manage.update.mockClear();
  const stored = {
    botId: "research",
    role: "member",
    name: "Research",
    avatar: null,
    purpose: "",
    defaultModelSelection: null,
  };
  // The first request was stored, but its answer never reached the phone.
  state.manage.create
    .mockResolvedValueOnce("Couldn't reach GOAT Bot's computer.")
    .mockResolvedValueOnce(stored);
  const opened = vi.fn();
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<MobileBotRoster selectedKey={null} onOpenBot={opened} />));
  await act(async () => (state.members as { onNewBot: () => void }).onNewBot());
  let failure: string | null | undefined;
  await act(async () => {
    failure = await state.sheet?.onSubmit({ name: "Research", avatar: null, purpose: "" });
  });
  expect(failure).toBe("Couldn't reach GOAT Bot's computer.");
  const luna = { instanceId: "codex", model: "luna" };
  await act(async () => state.pickModel?.(luna));
  await act(async () => {
    failure = await state.sheet?.onSubmit({ name: "Researcher", avatar: "🔬", purpose: "" });
  });
  // The same request id finds the stored bot; the edits made since reach it as a change.
  expect(state.manage.create).toHaveBeenLastCalledWith(
    { name: "Researcher", avatar: "🔬", purpose: "" },
    luna,
    "request-1",
  );
  expect(state.manage.update).toHaveBeenCalledExactlyOnceWith(
    stored,
    { name: "Researcher", avatar: "🔬" },
    luna,
  );
  expect(failure).toBeNull();
  expect(opened).toHaveBeenCalledWith({
    kind: "member",
    profile: { ...stored, name: "Researcher", avatar: "🔬", defaultModelSelection: luna },
  });
  await act(async () => root.unmount());
});

it("keeps the New bot sheet open with the reason when the edits cannot reach a bot the server kept", async () => {
  state.manage.update.mockClear();
  const stored = {
    botId: "research",
    role: "member",
    name: "Research",
    avatar: null,
    purpose: "",
    defaultModelSelection: null,
  };
  state.manage.create.mockResolvedValueOnce(stored);
  state.manage.update.mockResolvedValueOnce("You can't change this bot.");
  const opened = vi.fn();
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<MobileBotRoster selectedKey={null} onOpenBot={opened} />));
  await act(async () => (state.members as { onNewBot: () => void }).onNewBot());
  let failure: string | null | undefined;
  await act(async () => {
    failure = await state.sheet?.onSubmit({ name: "Researcher", avatar: null, purpose: "" });
  });
  expect(failure).toBe("You can't change this bot.");
  expect(opened).not.toHaveBeenCalled();
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

it("offers a colour where the server stores one, and a create retried after a picked colour still carries it", async () => {
  state.manage.update.mockClear();
  const stored = {
    botId: "research",
    role: "member",
    name: "Research",
    avatar: null,
    purpose: "",
    defaultModelSelection: null,
  };
  // The first request was stored without a colour, and its answer never reached the phone.
  state.manage.create
    .mockResolvedValueOnce("Couldn't reach GOAT Bot's computer.")
    .mockResolvedValueOnce(stored);
  const opened = vi.fn();
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<MobileBotRoster selectedKey={null} onOpenBot={opened} />));
  await act(async () => (state.members as { onNewBot: () => void }).onNewBot());
  expect(state.sheet?.colorEditable).toBe(true);
  await act(async () => {
    await state.sheet?.onSubmit({ name: "Research", avatar: null, purpose: "" });
  });
  await act(async () => {
    await state.sheet?.onSubmit({ name: "Research", avatar: null, purpose: "", color: "#0F766E" });
  });
  expect(state.manage.create).toHaveBeenLastCalledWith(
    { name: "Research", avatar: null, purpose: "", color: "#0F766E" },
    null,
    "request-1",
  );
  expect(state.manage.update).toHaveBeenCalledExactlyOnceWith(
    stored,
    { color: "#0F766E" },
    undefined,
  );
  expect(opened).toHaveBeenCalledWith({
    kind: "member",
    profile: { ...stored, color: "#0F766E" },
  });
  await act(async () => root.unmount());
});

it("offers a member's colour on Edit only where the server stores one, and never the main bot's", async () => {
  state.alert.mockClear();
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<MobileBotRoster selectedKey={null} onOpenBot={() => {}} />));
  const members = state.members as { onLongPressBot: (entry: object) => void };
  const edit = async (entry: object) => {
    await act(async () => members.onLongPressBot(entry));
    await act(async () => choose("Edit"));
  };
  await edit({
    kind: "member",
    profile: { ...member, role: "member", defaultModelSelection: null },
  });
  expect(state.sheet?.colorEditable).toBe(true);
  await act(async () => state.sheet?.onClose());
  await edit({
    kind: "main",
    profile: { botId: "main", role: "main", name: "GOAT Bot", defaultModelSelection: null },
  });
  expect(state.sheet?.colorEditable).toBe(false);
  await act(async () => state.sheet?.onClose());
  state.colorEditable = false;
  await edit({
    kind: "member",
    profile: { ...member, role: "member", defaultModelSelection: null },
  });
  expect(state.sheet?.colorEditable).toBe(false);
  state.colorEditable = true;
  await act(async () => root.unmount());
});
