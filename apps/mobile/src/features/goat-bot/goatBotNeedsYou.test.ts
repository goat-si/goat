import type { BotProfile, ChannelGetBotStatusResult } from "@goat/contracts";
import { expect, it } from "vite-plus/test";

import { goatBotNeedsYou } from "./goatBotNeedsYou";

const member = (botId: string) => ({
  kind: "member" as const,
  profile: { botId } as unknown as BotProfile,
});
const status = (
  waitingCount: number,
  latest?: ChannelGetBotStatusResult["latest"],
): ChannelGetBotStatusResult =>
  ({ bot: null, waitingCount, ...(latest ? { latest } : {}) }) as ChannelGetBotStatusResult;

it("adds up what waits across bots, newest ask first, and skips bots with nothing waiting", () => {
  const needs = goatBotNeedsYou([
    {
      entry: { kind: "main", profile: null },
      name: "GOAT Bot",
      status: status(1, { text: "Which branch?", at: "2026-11-11T10:00:00Z", author: "bot" }),
    },
    {
      entry: member("scout"),
      name: "Scout",
      status: status(2, { text: "Approve the deploy?", at: "2026-11-11T10:05:00Z", author: "bot" }),
    },
    { entry: member("idle"), name: "Idle", status: status(0) },
    { entry: member("offline"), name: "Offline", status: null },
  ]);
  expect(needs.total).toBe(3);
  expect(needs.rows.map((row) => [row.name, row.count, row.ask?.text])).toEqual([
    ["Scout", 2, "Approve the deploy?"],
    ["GOAT Bot", 1, "Which branch?"],
  ]);
});

it("does not present the person's own last message as the bot's ask", () => {
  const needs = goatBotNeedsYou([
    {
      entry: member("scout"),
      name: "Scout",
      status: status(1, { text: "Done, go ahead", at: "2026-11-11T10:05:00Z", author: "person" }),
    },
  ]);
  expect(needs.rows[0]?.ask).toBeNull();
  expect(needs.total).toBe(1);
});
