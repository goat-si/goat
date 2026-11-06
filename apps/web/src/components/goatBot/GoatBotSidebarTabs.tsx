import { scopeThreadRef } from "@goat/client-runtime/environment";
import { Link } from "@tanstack/react-router";
import { PlusIcon } from "~/components/solar";
import { selectGlobalAgentMode, useGlobalAgentStore } from "~/globalAgentStore";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Tabs, TabsList, TabsTab } from "../ui/tabs";
import { GoatBotSessionAvatar } from "./GoatBotAvatar";
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
  const { roster, rows, rowsLoaded, environmentId, refresh, slackEnabled } = useBotRoster();
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
          {rowsLoaded && rows.length === 0 && (
            <p className="px-4 text-xs text-sidebar-muted-foreground">
              Work GOAT Bot starts will appear here.
            </p>
          )}
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
                        size="lg"
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
                        <GoatBotSessionAvatar
                          size="sm"
                          threadRef={scopeThreadRef(
                            entry.profile.environmentId,
                            entry.profile.sessionThreadId,
                          )}
                        />
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
                <Button variant="outline" size="sm-multiline" disabled className="w-full">
                  <span className="flex min-w-0 flex-wrap items-center justify-center gap-1">
                    <PlusIcon />
                    New bot
                    <Badge variant="secondary" size="sm">
                      Coming soon
                    </Badge>
                  </span>
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
