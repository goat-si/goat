import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { BotProfile } from "@goat/contracts";
import { botRoster } from "./botRoster.ts";

const decode = Schema.decodeSync(BotProfile);
const profile = (botId: string, role: "main" | "member") =>
  decode({
    botId,
    role,
    name: botId,
    avatar: null,
    purpose: "",
    defaultModelSelection: null,
    defaultProjectId: null,
    environmentId: "env",
    sessionThreadId: botId,
    createdAt: "2026-11-04T00:00:00.000Z",
    updatedAt: "2026-11-04T00:00:00.000Z",
  });

describe("bot roster", () => {
  it("synthesizes the main bot for older servers and before creation", () => {
    expect(botRoster({ supportsProfiles: false, bots: [profile("main", "main")] })).toEqual([
      { kind: "main", profile: null },
    ]);
    expect(botRoster({ supportsProfiles: true, bots: [] })).toEqual([
      { kind: "main", profile: null },
    ]);
  });
  it("places the canonical main bot before other profiles", () => {
    const main = profile("main", "main");
    const member = profile("member", "member");
    expect(botRoster({ supportsProfiles: true, bots: [member, main] })).toEqual([
      { kind: "main", profile: main },
      { kind: "member", profile: member },
    ]);
  });
});
