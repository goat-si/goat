import { selectGlobalAgentMode, useGlobalAgentStore } from "~/globalAgentStore";
import { SidebarGroup } from "../ui/sidebar";
import { GoatBotSidebarRow } from "./GoatBotSidebarRow";
import { useGoatBotEnabled } from "./useGoatBotSession";

export function useBotSidebarSelected() {
  const { enabled } = useGoatBotEnabled();
  const mode = useGlobalAgentStore(selectGlobalAgentMode);
  return enabled && mode === "bot";
}

export function GoatBotSidebarTabs() {
  const { enabled } = useGoatBotEnabled();
  const mode = useGlobalAgentStore(selectGlobalAgentMode);
  const setMode = useGlobalAgentStore((state) => state.setMode);
  if (!enabled) return null;
  return (
    <>
      <SidebarGroup>
        <div role="tablist" aria-label="Sidebar" className="flex gap-1">
          {(["bot", "thread"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={mode === tab}
              onClick={() => setMode(tab)}
              className="flex-1 rounded-md px-2 py-1 text-sm aria-selected:bg-accent aria-selected:font-medium"
            >
              {tab === "bot" ? "Bots" : "Threads"}
            </button>
          ))}
        </div>
      </SidebarGroup>
      {mode === "bot" && <GoatBotSidebarRow />}
    </>
  );
}
