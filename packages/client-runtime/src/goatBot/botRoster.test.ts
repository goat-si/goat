import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { BotProfile, ChannelGatewayError, ProjectId, ThreadId } from "@goat/contracts";
import {
  botManageFailure,
  botRoster,
  botRosterGroups,
  findMemberBot,
  memberBotRef,
} from "./botRoster.ts";

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

const encode = Schema.encodeSync(BotProfile);
const at = (bot: ReturnType<typeof profile>, createdAt: string, extra: object = {}) =>
  decode({ ...encode(bot), createdAt, ...extra });

describe("bot roster groups", () => {
  it("lists shown members by creation time and keeps hidden and deleted members apart", () => {
    const main = profile("main", "main");
    const late = at(profile("late", "member"), "2026-11-06T00:00:00.000Z");
    const early = at(profile("early", "member"), "2026-11-05T00:00:00.000Z");
    const hidden = at(profile("hidden", "member"), "2026-11-05T01:00:00.000Z", { hidden: true });
    const gone = at(profile("gone", "member"), "2026-11-05T02:00:00.000Z", { state: "deleted" });
    const bots = [late, gone, main, hidden, early];
    expect(botRosterGroups(bots)).toEqual({
      main,
      members: [early, late],
      hidden: [hidden],
      deleted: [gone],
    });
    expect(
      botRoster({ supportsProfiles: true, bots }).map((entry) => entry.profile?.botId),
    ).toEqual(["main", "early", "late"]);
  });
  it("finds a member by its conversation thread, deleted ones included", () => {
    const gone = at(profile("gone", "member"), "2026-11-05T02:00:00.000Z", { state: "deleted" });
    expect(findMemberBot([profile("main", "main"), gone], "env", "gone")).toBe(gone);
    expect(findMemberBot([profile("main", "main")], "env", "main")).toBeNull();
  });
  it("targets a member's own thread under the main bot's project", () => {
    const member = profile("member", "member");
    const main = {
      environmentId: member.environmentId,
      projectId: ProjectId.make("p"),
      threadId: ThreadId.make("main"),
    };
    expect(memberBotRef(member, main)).toEqual({
      environmentId: member.environmentId,
      projectId: main.projectId,
      threadId: member.sessionThreadId,
    });
  });
  it("tells a person to stop open tasks when a delete is refused as busy", () => {
    expect(botManageFailure(new ChannelGatewayError({ reason: "bot_busy" }))).toBe(
      "Stop its open tasks first.",
    );
    expect(botManageFailure(new ChannelGatewayError({ reason: "bot_limit" }))).toBe(
      "This owner already has the most bots allowed.",
    );
    expect(botManageFailure(new Error("boom"))).toBe("boom");
  });
});
