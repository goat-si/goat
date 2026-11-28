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
    // Part 2 provider boards (design/paper/part2): Settings > Providers, sign-in, Add provider > ACP Registry.
    case "1PBB-2": case "1Q0P-2": case "1QAN-2": return { ...base, mode: "settings", settingsPath: "/settings/providers", settingsSearch: {} };
    default: return base;
  }
}
