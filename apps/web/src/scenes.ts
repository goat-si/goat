// Verification scenes (?fake=<board id>): the UI state each Paper board shows. Fake host only.
import type { UiState } from "./ui-state/uiState.ts";

const base: Partial<UiState> = { mode: "bots", botId: "reviewer", sidebarOpen: true, panelOpen: true, panelThreadId: null, pinned: ["main", "ci", "release"], railBots: [] };
export function sceneUi(scene: string): Partial<UiState> {
  switch (scene) {
    case "2R-1": case "1KL4-1": case "1FKW-0": return base;
    case "FF-1": return { ...base, sidebarOpen: false };
    case "12P-1": case "U8-1": return { ...base, pinned: [] };
    case "25D-0": return { ...base, pinned: [], panelThreadId: "t-review-7712" };
    case "1N65-1": return { ...base, mode: "threads", threadId: "t-billing" };
    case "1NEM-1": case "1OXX-1": return { ...base, mode: "threads", threadId: "t-billing" };
    // Part 2 provider boards (design/paper/part2, GOAT 2 redesign): Providers list + detail, sign-in, catalog, cloud
    // opt-in, repair; the bot's model page.
    case "1PBB-2": return { ...base, mode: "settings", settingsPath: "/settings/providers", settingsSearch: { instanceId: "codex" } };
    case "1Q0P-2": return { ...base, mode: "settings", settingsPath: "/settings/providers", settingsSearch: { instanceId: "antigravity" } };
    case "1QAN-2": return { ...base, mode: "settings", settingsPath: "/settings/providers", settingsSearch: { view: "add" } };
    case "2LET-2": return { ...base, mode: "settings", settingsPath: "/settings/providers", settingsSearch: { instanceId: "claudeAgent" } };
    case "2LEU-2": return { ...base, mode: "settings", settingsPath: "/settings/providers", settingsSearch: { instanceId: "omo" } };
    case "2LEV-2": return { ...base, mode: "settings", settingsPath: "/settings/providers", settingsSearch: {} };
    case "1QM8-2": return { ...base, botId: "main" };
    case "1QYE-2": return { ...base, botId: "main", mode: "settings", settingsPath: "/settings/goat-bot", settingsSearch: { botId: "main" } };
    default: return base;
  }
}
