import type { SettingsSearchItem } from "./settingsSearch";
export const GOAT_BOT_SEARCH_ITEMS = [
  {
    id: "goat-bot-suggestions",
    title: "Suggestions on the bot's home",
    to: "/settings/goat-bot",
    targetId: "goat-bot-suggestions",
    searchTerms: ["goat bot home suggested connect slack hide show"],
  },
  {
    id: "goat-bot-profile",
    title: "Name, avatar and purpose",
    to: "/settings/goat-bot",
    targetId: "goat-bot-profile",
    searchTerms: ["goat bot profile name rename avatar emoji purpose persona identity"],
  },
  {
    id: "channel-auto-placement",
    title: "Automatically choose a worker computer",
    to: "/settings/goat-bot",
    targetId: "goat-bot",
    searchTerms: ["channel placement quota ssh host worker automatic"],
  },
  {
    id: "goat-bot-session-routing",
    title: "Answer with the bot session",
    to: "/settings/goat-bot",
    targetId: "goat-bot",
    searchTerms: ["goat bot session reception routing"],
  },
  {
    id: "goat-bot-model",
    title: "GOAT Bot model",
    to: "/settings/goat-bot",
    targetId: "goat-bot",
    searchTerms: ["goat bot model provider llm assistant turns"],
  },
  {
    id: "slack-connection",
    title: "Slack connection",
    to: "/settings/goat-bot",
    targetId: "slack-channel",
    environmentOnly: true,
    searchTerms: ["slack socket mode bot app token mention direct message dm channel thread reply"],
  },
  {
    id: "imessage-channel",
    title: "iMessage",
    to: "/settings/goat-bot",
    searchTerms: ["goat bot imessage messages text sms phone mac link code"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
