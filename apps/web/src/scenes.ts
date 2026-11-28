// Verification scenes (?fake=<board id>): the UI state each Paper board shows. Fake host only.
import type { UiState } from "./ui-state/uiState.ts";

const base: Partial<UiState> = { mode: "bots", botId: "reviewer", sidebarOpen: true, panelOpen: true, panelThreadId: null, pinned: ["main", "ci", "release"], railBots: [] };
export function sceneUi(scene: string): Partial<UiState> {
  switch (scene) {
    case "2R-1": case "1KL4-1": case "1FKW-0": return base;
    case "FF-1": return { ...base, sidebarOpen: false };
    case "12P-1": case "U8-1": return { ...base, pinned: [] };
    case "25D-0": return { ...base, pinned: [], panelThreadId: "t-review-7712" };
    case "LXD-0": return { ...base, mode: "threads", threadId: null };
    case "C2Y-0": case "1MFK-1": return { ...base, mode: "threads", threadId: "t-perf6" };
    default: return base;
  }
}
