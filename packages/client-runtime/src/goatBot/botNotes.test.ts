import { describe, expect, it } from "@effect/vitest";
import {
  ChannelGatewayError,
  EnvironmentAuthorizationError,
  goatBotChangeNoteMessage,
  goatBotForgetNoteMessage,
} from "@goat/contracts";
import {
  botNotesFailure,
  changeNoteDraft,
  forgetNoteDraft,
  goatBotNotesRefreshKey,
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

  it("an undated note says so", () => {
    expect(noteDateLabel(null)).toBe("Undated");
    expect(noteDateLabel("2026-11-07")).toBe("2026-11-07");
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
      ),
    ).toEqual({ message: "This device can't read GOAT Bot's notes.", retry: false });
  });

  it("a server that is not GOAT Bot's home points there", () => {
    expect(botNotesFailure(new ChannelGatewayError({ reason: "not_home" }))).toEqual({
      message: "GOAT Bot's notes are on its home computer.",
      retry: false,
    });
  });

  it("anything else can be retried", () => {
    expect(botNotesFailure(new Error("socket closed"))).toEqual({
      message: "Couldn't load GOAT Bot's notes.",
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
