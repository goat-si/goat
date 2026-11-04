import { Link } from "@tanstack/react-router";
import { PlusIcon } from "~/components/solar";
import { selectGlobalAgentMode, useGlobalAgentStore } from "~/globalAgentStore";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Tabs, TabsList, TabsTab } from "../ui/tabs";
import { GoatBotAvatar } from "./GoatBotAvatar";
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
        <Tabs value={mode} onValueChange={(value: typeof mode) => setMode(value)}>
          <TabsList aria-label="Sidebar">
            <TabsTab value="bot">Bots</TabsTab>
            <TabsTab value="thread">Threads</TabsTab>
          </TabsList>
        </Tabs>
      </SidebarGroup>
      {mode === "bot" && (
        <div className="max-h-[70dvh] overflow-y-auto">
          <GoatBotSidebarRow
            name={roster[0]?.profile?.name ?? "GOAT Bot"}
            slackEnabled={slackEnabled}
          />
          {environmentId && (
            <GoatBotChildRows environmentId={environmentId} rows={rows} refresh={refresh} />
          )}
          {roster.slice(1).map(
            (entry) =>
              entry.profile && (
                <SidebarGroup key={entry.profile.botId}>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        render={
                          <Link
                            to="/$environmentId/$threadId"
                            params={{
                              environmentId: entry.profile.environmentId,
                              threadId: entry.profile.sessionThreadId,
                            }}
                          />
                        }
                      >
                        <GoatBotAvatar size="sm" />
                        <span>{entry.profile.name}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroup>
              ),
          )}
          <SidebarGroup>
            <Tooltip>
              <TooltipTrigger render={<span className="block" tabIndex={0} />}>
                <Button variant="outline" size="sm" disabled className="w-full justify-start">
                  <PlusIcon />
                  New bot
                  <Badge variant="secondary" size="sm" className="ml-auto">
                    Coming soon
                  </Badge>
                </Button>
              </TooltipTrigger>
              <TooltipPopup>Creating more bots is coming soon.</TooltipPopup>
            </Tooltip>
          </SidebarGroup>
        </div>
      )}
    </>
  );
}
