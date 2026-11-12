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
  minute: "2026-11-07T12:00",
  refresh: vi.fn(),
  requested: vi.fn(),
}));
vi.mock("~/hooks/useNowMinute", () => ({ useNowMinute: () => state.minute }));
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
import { navigationBlocked } from "~/lib/navigationHolds";

const environmentId = EnvironmentId.make("env");
const decodeProfile = Schema.decodeSync(BotProfile);
const older = { index: 0, date: null, text: "Keep replies short" };
const newer = { index: 1, date: "2026-11-07", text: 'Reply in "Korean"' };

function setup(
  options: { data?: unknown; failure?: unknown; supported?: boolean; minute?: string } = {},
) {
  state.supported = options.supported ?? true;
  state.minute = options.minute ?? "2026-11-07T12:00";
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
  await expect.element(screen.getByText("No notes yet")).toBeVisible();
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
  await expect.element(screen.getByText(/^memory.md is larger than 64 KB/)).toBeVisible();
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

it("new wording being written holds back a New bot open until it is cancelled", async () => {
  setup();
  await using screen = await render(
    <GoatBotMemory environmentId={environmentId} onDraft={() => {}} />,
  );
  expect(navigationBlocked()).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "Ask to change" }).first());
  await expect.element(screen.getByRole("textbox", { name: "New wording" })).toBeVisible();
  expect(navigationBlocked()).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(navigationBlocked()).toBe(false);
});

it("notes reading alike but for spacing are held back, since a request names a note by its words", async () => {
  const first = { index: 0, date: "2026-11-01", text: "Use pnpm" };
  const second = { index: 1, date: "2026-11-02", text: "Use  pnpm" };
  setup({ data: { revision: "r1", notes: [second, first], truncated: false } });
  const onDraft = vi.fn();
  await using screen = await render(
    <GoatBotMemory environmentId={environmentId} onDraft={onDraft} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Ask to forget" }).nth(1));
  await expect
    .element(
      screen.getByText(
        "More than one note reads “Use pnpm”, so GOAT Bot can't tell which one you mean.",
      ),
    )
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Copy note" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Discard" }));
  await userEvent.click(screen.getByRole("button", { name: "Ask to change" }).first());
  await userEvent.fill(screen.getByRole("textbox", { name: "New wording" }), "Use vp");
  await expect.element(screen.getByRole("button", { name: "Copy new wording" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Fill message" }).query()).toBeNull();
  expect(onDraft).not.toHaveBeenCalled();
});

it("a list cut to the newest part of memory.md holds back every note's request", async () => {
  setup({ data: { revision: "r1", notes: [newer, older], truncated: true } });
  const onDraft = vi.fn();
  await using screen = await render(
    <GoatBotMemory environmentId={environmentId} onDraft={onDraft} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Ask to forget" }).nth(1));
  await expect
    .element(
      screen.getByText(
        "This list shows only the newest part of memory.md, so another note may also read “Keep replies short” and GOAT Bot can't tell which one you mean.",
      ),
    )
    .toBeVisible();
  expect(onDraft).not.toHaveBeenCalled();
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
const sourced = (index: number, text: string, extra: Record<string, unknown> = {}) => ({
  index,
  date: "2026-11-07",
  text,
  ...extra,
});

it("says where each note was asked for", async () => {
  setup({
    data: {
      revision: "r1",
      notes: [
        sourced(2, "Reply in Korean", {
          source: {
            kind: "shown",
            inputId: "i",
            channel: "slack",
            botId: "main",
            from: "Juni",
            at: "2026-11-07T10:00:00.000Z",
          },
        }),
        sourced(1, "Keep it short", { source: { kind: "elsewhere" } }),
        { index: 0, date: null, text: "Written by hand" },
      ],
      truncated: false,
    },
  });
  await using screen = await render(<GoatBotMemory environmentId={environmentId} />);
  const rows = [...screen.container.querySelectorAll("li")].map((row) => row.textContent ?? "");
  expect(rows[0]).toMatch(/Slack, Juni, Nov [78]/);
  expect(rows[1]).toContain("Asked in another conversation");
  expect(rows[2]).not.toContain("Asked in");
});

it("dates a source against the real current instant, so a new local year adds no year", async () => {
  // 20:00 UTC on Dec 31 is already Jan 1 in UTC+5 and later zones; the minute tick carries no offset.
  const at = "2026-12-31T19:30:00.000Z";
  setup({
    minute: "2026-12-31T20:00",
    data: {
      revision: "r1",
      notes: [
        sourced(0, "Reply in Korean", {
          source: {
            kind: "shown",
            inputId: "i",
            channel: "slack",
            botId: "main",
            from: "Juni",
            at,
          },
        }),
      ],
      truncated: false,
    },
  });
  await using screen = await render(<GoatBotMemory environmentId={environmentId} />);
  const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(
    Date.parse(at),
  );
  await expect.element(screen.getByText(`Slack, Juni, ${day}`, { exact: true })).toBeVisible();
});

it("keeps replaced notes behind a toggle that works from the keyboard", async () => {
  setup({
    data: {
      revision: "r1",
      notes: [
        sourced(1, "Reply in English", { replaces: "Reply in Korean" }),
        sourced(0, "Reply in Korean", { replacedBy: 1 }),
      ],
      truncated: false,
    },
  });
  await using screen = await render(
    <GoatBotMemory environmentId={environmentId} onDraft={() => {}} />,
  );
  await expect.element(screen.getByText("Replaces: “Reply in Korean”")).toBeVisible();
  expect(screen.getByText("Replaced by: “Reply in English”").query()).toBeNull();
  const toggle = screen.getByRole("button", { name: "Show replaced notes (1)" });
  await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
  toggle.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(screen.getByText("Replaced by: “Reply in English”")).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Hide replaced notes" }))
    .toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: "Ask to forget" }).all()).toHaveLength(1);
  await userEvent.keyboard("{Enter}");
  expect(screen.getByText("Replaced by: “Reply in English”").query()).toBeNull();
});

it("a correction that arrives while a change is open drops the change and hides the old note", async () => {
  setup({ data: { revision: "r1", notes: [sourced(0, "Reply in Korean")], truncated: false } });
  await using screen = await render(
    <GoatBotMemory environmentId={environmentId} onDraft={() => {}} refreshKey="a" />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Ask to change" }));
  await expect.element(screen.getByRole("textbox", { name: "New wording" })).toBeVisible();
  state.data = {
    revision: "r2",
    notes: [
      sourced(1, "Reply in English", { replaces: "Reply in Korean" }),
      sourced(0, "Reply in Korean", { replacedBy: 1 }),
    ],
    truncated: false,
  };
  await screen.rerender(
    <GoatBotMemory environmentId={environmentId} onDraft={() => {}} refreshKey="b" />,
  );
  expect(screen.getByRole("textbox", { name: "New wording" }).query()).toBeNull();
  expect(screen.getByText("Reply in Korean", { exact: true }).query()).toBeNull();
  expect(screen.getByRole("button", { name: "Ask to forget" }).all()).toHaveLength(1);
});

it.each([
  { name: "with notes", notes: [sourced(0, "Reply in Korean")], body: "Reply in Korean" },
  {
    name: "with no complete note",
    notes: [],
    body: "No complete note fits in the newest 64 KB of memory.md.",
  },
])("explains a partial list $name", async ({ notes, body }) => {
  setup({ data: { revision: "r1", notes, truncated: true } });
  await using screen = await render(<GoatBotMemory environmentId={environmentId} />);
  await expect
    .element(
      screen.getByText(
        "memory.md is larger than 64 KB, so this list shows only complete notes from its newest 64 KB. The rest of the file is unchanged.",
      ),
    )
    .toBeVisible();
  await expect.element(screen.getByText(body)).toBeVisible();
  expect(screen.getByText("No notes yet").query()).toBeNull();
});

it("says when every note has been replaced", async () => {
  setup({
    data: { revision: "r1", notes: [sourced(0, "Old rule", { replacedBy: 5 })], truncated: false },
  });
  await using screen = await render(<GoatBotMemory environmentId={environmentId} />);
  await expect.element(screen.getByText("No current notes.")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Show replaced notes (1)" }));
  await expect.element(screen.getByText("Replaced by a later note")).toBeVisible();
});
