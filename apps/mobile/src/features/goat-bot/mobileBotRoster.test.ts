import { BotProfile, BotThreadRow } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { mobileBotRoster } from "./mobileBotRoster";

const at = "2026-11-04T10:00:00.000Z";
const profile = Schema.decodeUnknownSync(BotProfile)({
  botId: "main",
  role: "main",
  name: "Assistant",
  avatar: null,
  purpose: "",
  defaultModelSelection: null,
  defaultProjectId: null,
  environmentId: "env",
  sessionThreadId: "main",
  createdAt: at,
  updatedAt: at,
});
const task = Schema.decodeUnknownSync(BotThreadRow)({
  kind: "task",
  task: { taskId: "task", title: "Review", status: "waiting_input", updatedAt: at },
  view: { taskId: "task", pinnedAt: null, doneAt: null, readThrough: null },
  lastActivityAt: at,
  unread: true,
  mainMessagesSinceQuiet: 0,
});
const args = {
  bots: [profile],
  children: [task],
  now: Date.parse(at),
  showMore: false,
  selectedKey: null,
};

describe("mobile bot roster", () => {
  it("shows only a synthesized main row without server capabilities", () => {
    expect(
      mobileBotRoster({ ...args, supportsProfiles: false, supportsTaskThreads: false }),
    ).toEqual({
      bots: [{ kind: "main", profile: null }],
      children: { rows: [], hasMore: false },
    });
  });
  it("shows profile and task rows when supported", () => {
    expect(mobileBotRoster({ ...args, supportsProfiles: true, supportsTaskThreads: true })).toEqual(
      {
        bots: [{ kind: "main", profile }],
        children: { rows: [task], hasMore: false },
      },
    );
  });
});
