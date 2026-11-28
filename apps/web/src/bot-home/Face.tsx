// One face for a bot row: profile face, else a stable face from its id (until bot_changed arrives).
import { BotFace, faceFromId } from "@goat2/bot-face";
import type { BotRowData } from "../host/store.ts";

export function moodOf(state: BotRowData["state"]) {
  return state === "needs-you" ? "needs_you" as const : state === "working" ? "work" as const : "idle" as const;
}
export function Face({ bot, size, live = false }: { bot: Pick<BotRowData, "botId" | "face" | "state" | "name">; size: number; live?: boolean }) {
  return <BotFace face={bot.face ?? faceFromId(bot.botId)} size={size} mood={moodOf(bot.state)} tier={live ? "live" : "list"} title={bot.name} />;
}
