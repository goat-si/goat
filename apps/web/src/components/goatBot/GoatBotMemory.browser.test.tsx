import {
  BotProfile,
  ChannelGatewayError,
  EnvironmentAuthorizationError,
  EnvironmentId,
  goatBotChangeNoteMessage,
  goatBotForgetNoteMessage,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  supported: true,
  data: null as unknown,
  failure: null as unknown,
  refresh: vi.fn(),
  requested: vi.fn(),
}));
vi.mock("~/state/entities", () => ({
  useServerConfigs: () =>
    new Map([["env", { environment: { capabilities: { goatBotNotes: state.supported } } }]]),
}));
vi.mock("~/state/channels", () => ({
  channelEnvironment: {
    listBotNotes: (target: unknown) => {
      state.requested(target);
      return "notes";
    },
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data: atom === null ? null : state.data,
    failure: atom === null ? null : state.failure,
    error: state.failure === null ? null : "failed",
    isPending: false,
    isSuccess: state.data !== null,
    refresh: state.refresh,
  }),
}));
import { GoatBotMemberContext } from "./goatBotMemberContext";
import { GoatBotMemory } from "./GoatBotMemory";

const environmentId = EnvironmentId.make("env");
const decodeProfile = Schema.decodeSync(BotProfile);
const older = { index: 0, date: null, text: "Keep replies short" };
const newer = { index: 1, date: "2026-11-07", text: 'Reply in "Korean"' };

function setup(options: { data?: unknown; failure?: unknown; supported?: boolean } = {}) {
  state.supported = options.supported ?? true;
  state.data =
    options.data === undefined
      ? { revision: "r1", notes: [newer, older], truncated: false }
      : options.data;
  state.failure = options.failure ?? null;
  state.refresh.mockReset();
  state.requested.mockReset();
}

it("lists notes newest first with their date and says how GOAT Bot uses them", async () => {
  setup();
  await using screen = await render(<GoatBotMemory environmentId={environmentId} />);
  await expect
    .element(
      screen.getByText(
        "GOAT Bot uses notes from its next conversation session. Notes are shared with Slack and iMessage.",
      ),
    )
    .toBeVisible();
  const items = [...screen.container.querySelectorAll("li")].map((item) => item.textContent);
  expect(items).toEqual([
    '2026-11-07Reply in "Korean"Ask to changeAsk to forget',
    "UndatedKeep replies shortAsk to changeAsk to forget",
  ]);
  expect(
    screen.getByText("Every bot on this computer shares these notes with GOAT Bot.").query(),
  ).toBeNull();
});

it("says when there are no notes yet", async () => {
  setup({ data: { revision: null, notes: [], truncated: false } });
  await using screen = await render(<GoatBotMemory environmentId={environmentId} />);
  await expect
    .element(screen.getByText("No notes yet. Ask GOAT Bot to remember a standing rule."))
    .toBeVisible();
});

it("a member's tab says the notes are shared and a long file says only the newest show", async () => {
  setup({ data: { revision: "r1", notes: [newer], truncated: true } });
  const member = decodeProfile({
    botId: "research",
    role: "member",
    name: "Research",
    avatar: null,
    purpose: "",
    defaultModelSelection: null,
    defaultProjectId: null,
    environmentId: "env",
    sessionThreadId: "thread-research",
    createdAt: "2026-11-07T00:00:00.000Z",
    updatedAt: "2026-11-07T00:00:00.000Z",
  });
  await using screen = await render(
    <GoatBotMemberContext value={member}>
      <GoatBotMemory environmentId={environmentId} />
    </GoatBotMemberContext>,
  );
  await expect
    .element(screen.getByText("Every bot on this computer shares these notes with GOAT Bot."))
    .toBeVisible();
  await expect.element(screen.getByText("Showing the newest notes only.")).toBeVisible();
});

it("Ask to forget drafts the quoted note and nothing else", async () => {
  setup();
  const onDraft = vi.fn();
  await using screen = await render(
    <GoatBotMemory environmentId={environmentId} onDraft={onDraft} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Ask to forget" }).first());
  expect(onDraft).toHaveBeenCalledTimes(1);
  expect(onDraft).toHaveBeenCalledWith(goatBotForgetNoteMessage(newer.text));
});

it("Ask to change asks for the new wording first, then drafts the quoted change", async () => {
  setup();
  const onDraft = vi.fn();
  await using screen = await render(
    <GoatBotMemory environmentId={environmentId} onDraft={onDraft} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Ask to change" }).first());
  const field = screen.getByRole("textbox", { name: "New wording" });
  await expect.element(field).toHaveValue(newer.text);
  await expect.element(screen.getByRole("button", { name: "Fill message" })).toBeDisabled();
  await userEvent.clear(field);
  await userEvent.type(field, "Reply in English");
  await userEvent.click(screen.getByRole("button", { name: "Fill message" }));
  expect(onDraft).toHaveBeenCalledWith(goatBotChangeNoteMessage(newer.text, "Reply in English"));
  expect(screen.getByRole("textbox", { name: "New wording" }).query()).toBeNull();
});

it("cannot ask while the chat cannot send", async () => {
  setup();
  await using screen = await render(<GoatBotMemory environmentId={environmentId} />);
  await expect
    .element(screen.getByRole("button", { name: "Ask to forget" }).first())
    .toBeDisabled();
  await expect
    .element(screen.getByRole("button", { name: "Ask to change" }).first())
    .toBeDisabled();
});

it("a new list drops an open change so new wording never lands on another note", async () => {
  setup();
  await using screen = await render(
    <GoatBotMemory environmentId={environmentId} onDraft={() => {}} />,
  );
  // The older note is index 0; once it is forgotten the newer note becomes index 0.
  await userEvent.click(screen.getByRole("button", { name: "Ask to change" }).nth(1));
  await expect
    .element(screen.getByRole("textbox", { name: "New wording" }))
    .toHaveValue(older.text);
  state.data = { revision: "r2", notes: [{ ...newer, index: 0 }], truncated: false };
  await screen.rerender(<GoatBotMemory environmentId={environmentId} onDraft={() => {}} />);
  await expect.element(screen.getByText(newer.text)).toBeVisible();
  expect(screen.getByRole("textbox", { name: "New wording" }).query()).toBeNull();
});

it("an older server is not asked for notes", async () => {
  setup({ supported: false });
  await using screen = await render(<GoatBotMemory environmentId={environmentId} />);
  await expect.element(screen.getByText("Notes need a newer GOAT server.")).toBeVisible();
  expect(state.requested).not.toHaveBeenCalled();
});

it.each([
  {
    name: "missing memory read",
    failure: new EnvironmentAuthorizationError({ message: "no", requiredScope: "memory:read" }),
    copy: "This device can't read GOAT Bot's notes.",
    retry: false,
  },
  {
    name: "not GOAT Bot's home",
    failure: new ChannelGatewayError({ reason: "not_home" }),
    copy: "GOAT Bot's notes are on its home computer.",
    retry: false,
  },
  {
    name: "other failure",
    failure: new Error("socket"),
    copy: "Couldn't load GOAT Bot's notes.",
    retry: true,
  },
])("shows why notes cannot load: $name", async ({ failure, copy, retry }) => {
  setup({ data: null, failure });
  await using screen = await render(<GoatBotMemory environmentId={environmentId} />);
  await expect.element(screen.getByText(copy)).toBeVisible();
  const again = screen.getByRole("button", { name: "Try again" });
  if (!retry) {
    expect(again.query()).toBeNull();
    return;
  }
  state.refresh.mockClear();
  await userEvent.click(again);
  expect(state.refresh).toHaveBeenCalledTimes(1);
});

it("asks again when opened and whenever the bot answers or a task moves on", async () => {
  setup();
  await using screen = await render(<GoatBotMemory environmentId={environmentId} refreshKey="a" />);
  expect(state.refresh).toHaveBeenCalledTimes(1);
  await screen.rerender(<GoatBotMemory environmentId={environmentId} refreshKey="a" />);
  expect(state.refresh).toHaveBeenCalledTimes(1);
  await screen.rerender(<GoatBotMemory environmentId={environmentId} refreshKey="b" />);
  expect(state.refresh).toHaveBeenCalledTimes(2);
});
