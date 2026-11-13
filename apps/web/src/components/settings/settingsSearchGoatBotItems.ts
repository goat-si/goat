import type { SettingsSearchItem } from "./settingsSearch";
export const GOAT_BOT_ROUTING_SEARCH_ITEMS = [
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
] as const satisfies ReadonlyArray<SettingsSearchItem>;
