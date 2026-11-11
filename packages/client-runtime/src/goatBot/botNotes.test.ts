import { describe, expect, it } from "@effect/vitest";
import {
  BotId,
  ChannelGatewayError,
  EnvironmentAuthorizationError,
  goatBotChangeNoteMessage,
  goatBotForgetNoteMessage,
} from "@goat/contracts";
import {
  botNotesFailure,
  changeNoteDraft,
  forgetNoteDraft,
  GOAT_BOT_NOTES_TRUNCATED_COPY,
  goatBotNotesNamedByTextOnly,
  goatBotNoteSourceLabel,
  goatBotNotesRefreshKey,
  goatBotNotesView,
  noteDateLabel,
} from "./botNotes.ts";

const note = { index: 0, date: "2026-11-07", text: 'Reply in "Korean" (always)  ' };

describe("note drafts", () => {
  it("forget quotes the note exactly as the contract builds it", () => {
    expect(forgetNoteDraft(note)).toBe(goatBotForgetNoteMessage(note.text));
  });

  it("change quotes the original note untouched and trims only the new wording", () => {
    expect(changeNoteDraft(note, "  Reply in English  ")).toBe(
      goatBotChangeNoteMessage(note.text, "Reply in English"),
    );
  });

  it("change has nothing to send for blank or unchanged wording", () => {
    expect(changeNoteDraft(note, "   ")).toBeNull();
    expect(changeNoteDraft(note, note.text.trim())).toBeNull();
  });

  it("names the one note when the server gave it an id", () => {
    const named = { index: 0, date: null, text: "Use pnpm", id: "0123456789ab" };
    expect(forgetNoteDraft(named)).toBe('Please forget this note: "Use pnpm" (note 0123456789ab)');
    expect(changeNoteDraft(named, "Use vp")).toBe(
      'Please change this note: "Use pnpm" (note 0123456789ab) to: "Use vp"',
    );
  });

  it("finds current notes a request can name only by words another current note shares", () => {
    const alike = (index: number, id?: string) => ({
      index,
      date: null,
      text: "Use pnpm",
      ...(id === undefined ? {} : { id }),
    });
    const replaced = { ...alike(0), replacedBy: 3 };
    const other = { index: 4, date: null, text: "Use vp" };
    expect([...goatBotNotesNamedByTextOnly([replaced, alike(1), other])]).toEqual([]);
    expect([...goatBotNotesNamedByTextOnly([alike(1), alike(2), other])]).toEqual([1, 2]);
    // A server that names each line lets a request pick one of them.
    expect([...goatBotNotesNamedByTextOnly([alike(1, "a"), alike(2, "b")])]).toEqual([]);
  });

  it("an undated note says so", () => {
    expect(noteDateLabel({ date: null })).toBe("Undated");
    expect(noteDateLabel({ date: "2026-11-07" })).toBe("2026-11-07");
  });
});

describe("noteDateLabel", () => {
  // 02:10 in Seoul on Nov 8 is still Nov 7 in UTC, the day the line was written with.
  const asked = {
    date: "2026-11-07",
    source: {
      kind: "shown" as const,
      inputId: "in-1",
      channel: "goat" as const,
      botId: BotId.make("main"),
      from: "Juni",
      at: "2026-11-07T17:10:00.000Z",
    },
  };

  it("dates a note by when it was asked, in the viewer's time zone, across UTC midnight", () => {
    expect(noteDateLabel(asked, "Asia/Seoul")).toBe("2026-11-08");
    expect(noteDateLabel(asked, "UTC")).toBe("2026-11-07");
    expect(
      noteDateLabel(
        {
          ...asked,
          date: "2026-11-08",
          source: { ...asked.source, at: "2026-11-08T03:00:00.000Z" },
        },
        "America/Los_Angeles",
      ),
    ).toBe("2026-11-07");
  });

  it("matches the source label's day for the same note and time zone", () => {
    const now = Date.parse("2026-11-08T00:00:00.000Z");
    expect(goatBotNoteSourceLabel(asked.source, { now, timeZone: "Asia/Seoul" })).toContain(
      "Nov 8",
    );
    expect(noteDateLabel(asked, "Asia/Seoul")).toBe("2026-11-08");
  });

  it("keeps the line's own date without a request time, and says Undated without either", () => {
    expect(noteDateLabel({ date: "2026-11-07", source: { kind: "elsewhere" } }, "Asia/Seoul")).toBe(
      "2026-11-07",
    );
    expect(noteDateLabel({ date: "2025-03-04" }, "Asia/Seoul")).toBe("2025-03-04");
    expect(noteDateLabel({ date: null, source: { kind: "elsewhere" } }, "UTC")).toBe("Undated");
  });

  it("falls back to the line's date, then Undated, when the request time does not parse", () => {
    const garbled = { ...asked.source, at: "not a time" };
    expect(noteDateLabel({ date: "2026-11-07", source: garbled }, "Asia/Seoul")).toBe("2026-11-07");
    expect(noteDateLabel({ date: null, source: garbled }, "Asia/Seoul")).toBe("Undated");
  });
});

describe("botNotesFailure", () => {
  it("a missing memory:read grant cannot be retried", () => {
    expect(
      botNotesFailure(
        new EnvironmentAuthorizationError({
          message: "no",
          requiredScope: "memory:read",
        }),
        "Goaty",
      ),
    ).toEqual({ message: "This device can't read Goaty's notes.", retry: false });
  });

  it("a server that is not GOAT Bot's home points there", () => {
    expect(botNotesFailure(new ChannelGatewayError({ reason: "not_home" }), "Goaty")).toEqual({
      message: "Goaty's notes are on its home computer.",
      retry: false,
    });
  });

  it("anything else can be retried", () => {
    expect(botNotesFailure(new Error("socket closed"), "Goaty")).toEqual({
      message: "Couldn't load Goaty's notes.",
      retry: true,
    });
  });
});

describe("goatBotNotesRefreshKey", () => {
  const user = { kind: "user", id: "u1", text: "Please forget this note" } as const;
  const bot = { kind: "bot", id: "b1", text: "On it." } as const;
  const card = (revision: number) =>
    ({ kind: "task", id: "t1", card: { key: "task-1", revision } }) as const;

  it("a new bot answer changes the key and a new user message does not", () => {
    const before = goatBotNotesRefreshKey([user]);
    expect(goatBotNotesRefreshKey([user, { ...user, id: "u2" }])).toBe(before);
    expect(goatBotNotesRefreshKey([user, bot])).not.toBe(before);
  });

  it("the same answer growing changes the key", () => {
    expect(goatBotNotesRefreshKey([bot])).not.toBe(
      goatBotNotesRefreshKey([{ ...bot, text: "On it. Done." }]),
    );
  });

  it("a task card's new revision changes the key and the same revision does not", () => {
    const running = goatBotNotesRefreshKey([user, bot, card(1)]);
    expect(goatBotNotesRefreshKey([user, bot, card(1)])).toBe(running);
    expect(goatBotNotesRefreshKey([user, bot, card(2)])).not.toBe(running);
  });
});
describe("goatBotNoteSourceLabel", () => {
  const shown = (
    channel: "goat" | "slack" | "imessage" | "mcp",
    at = "2026-11-07T10:00:00.000Z",
    from = "Juni",
  ) => ({
    kind: "shown" as const,
    inputId: "in-1",
    channel,
    botId: BotId.make("main"),
    from,
    at,
  });
  const now = Date.parse("2026-11-07T12:00:00.000Z");

  it("names the channel, the person and the day", () => {
    expect(goatBotNoteSourceLabel(shown("slack"), { now, timeZone: "UTC" })).toBe(
      "Slack, Juni, Nov 7",
    );
    expect(goatBotNoteSourceLabel(shown("goat"), { now, timeZone: "UTC" })).toBe(
      "GOAT, Juni, Nov 7",
    );
    expect(goatBotNoteSourceLabel(shown("imessage"), { now, timeZone: "UTC" })).toBe(
      "iMessage, Juni, Nov 7",
    );
    expect(goatBotNoteSourceLabel(shown("mcp"), { now, timeZone: "UTC" })).toBe(
      "an agent, Juni, Nov 7",
    );
    expect(goatBotNoteSourceLabel(shown("slack", undefined, "  "), { now, timeZone: "UTC" })).toBe(
      "Slack, Nov 7",
    );
  });

  it("says another conversation when the details are not this viewer's, and nothing for a hand-written line", () => {
    expect(goatBotNoteSourceLabel({ kind: "elsewhere" }, { now })).toBe(
      "Asked in another conversation",
    );
    expect(goatBotNoteSourceLabel(undefined, { now })).toBeNull();
  });

  it("reads the day in the viewer's time zone", () => {
    const late = shown("slack", "2026-11-07T23:30:00.000Z");
    expect(goatBotNoteSourceLabel(late, { now, timeZone: "UTC" })).toBe("Slack, Juni, Nov 7");
    expect(goatBotNoteSourceLabel(late, { now, timeZone: "Asia/Seoul" })).toBe(
      "Slack, Juni, Nov 8",
    );
  });

  it("adds the year only when it is not this year in that time zone", () => {
    const newYear = Date.parse("2026-01-01T03:00:00.000Z");
    const eve = shown("slack", "2025-12-31T20:00:00.000Z");
    expect(goatBotNoteSourceLabel(eve, { now: newYear, timeZone: "UTC" })).toBe(
      "Slack, Juni, Dec 31, 2025",
    );
    expect(goatBotNoteSourceLabel(eve, { now: newYear, timeZone: "Asia/Seoul" })).toBe(
      "Slack, Juni, Jan 1",
    );
  });
});

describe("goatBotNotesView", () => {
  const a = { index: 0, date: "2026-11-05", text: "Reply in Korean", replacedBy: 1 };
  const b = { index: 1, date: "2026-11-07", text: "Reply in English", replaces: "Reply in Korean" };
  const c = { index: 2, date: null, text: "Keep it short" };

  it("splits current notes from replaced ones and finds what replaced each", () => {
    const view = goatBotNotesView({ notes: [c, b, a], truncated: false });
    expect(view.current).toEqual([c, b]);
    expect(view.replaced).toEqual([a]);
    expect(view.replacingText(a)).toBe("Reply in English");
    expect(view.replacingText({ ...a, replacedBy: 9 })).toBeNull();
    expect(view.empty).toBeNull();
  });

  it("tells an empty file from an all-replaced list from a window with no complete note", () => {
    expect(goatBotNotesView({ notes: [], truncated: false }).empty).toBe("none");
    expect(goatBotNotesView({ notes: [a], truncated: false }).empty).toBe("no_current");
    expect(goatBotNotesView({ notes: [], truncated: true }).empty).toBe("none_in_window");
  });

  it("explains a partial list without claiming what the bot reads", () => {
    expect(GOAT_BOT_NOTES_TRUNCATED_COPY).toBe(
      "memory.md is larger than 64 KB, so this list shows only complete notes from its newest 64 KB. The rest of the file is unchanged.",
    );
  });
});
