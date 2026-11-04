import { selectGlobalAgentMode, useGlobalAgentStore } from "~/globalAgentStore";
import { SidebarGroup } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { GoatBotSidebarRow } from "./GoatBotSidebarRow";
import { GoatBotChildRows } from "./GoatBotChildRows";
import { useBotRoster } from "./useBotRoster";
import { useGoatBotHome } from "./useGoatBotHome";
import { useGoatBotEnabled } from "./useGoatBotSession";

export function useBotSidebarSelected() {
  const { enabled } = useGoatBotEnabled();
  const mode = useGlobalAgentStore(selectGlobalAgentMode);
  return enabled && mode === "bot";
}

export function GoatBotSidebarTabs() {
  useGoatBotHome();
  const { enabled } = useGoatBotEnabled();
  const mode = useGlobalAgentStore(selectGlobalAgentMode);
  const setMode = useGlobalAgentStore((state) => state.setMode);
  const { roster, rows, environmentId, refresh, slackEnabled } = useBotRoster();
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
      {mode === "bot" && (
        <>
          <GoatBotSidebarRow
            name={roster[0]?.profile?.name ?? "GOAT Bot"}
            slackEnabled={slackEnabled}
          />
          {environmentId && (
            <GoatBotChildRows environmentId={environmentId} rows={rows} refresh={refresh} />
          )}
          <SidebarGroup>
            <Tooltip>
              <TooltipTrigger render={<span tabIndex={0} />}>
                <button type="button" disabled>
                  New bot
                </button>
              </TooltipTrigger>
              <TooltipPopup>Coming soon</TooltipPopup>
            </Tooltip>
          </SidebarGroup>
        </>
      )}
    </>
  );
}
