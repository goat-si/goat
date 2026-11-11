import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@goat/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { PlusIcon } from "~/components/solar";
import { selectGlobalAgentMode, useGlobalAgentStore } from "~/globalAgentStore";
import { channelEnvironment } from "~/state/channels";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SidebarGroup } from "../ui/sidebar";
import { Tabs, TabsList, TabsTab } from "../ui/tabs";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { GoatBotSidebarRow } from "./GoatBotSidebarRow";
import { GoatBotChildRows } from "./GoatBotChildRows";
import { GoatBotMemberRoster } from "./GoatBotMemberRows";
import { GoatBotNewBotDialog } from "./GoatBotNewBotDialog";
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
  const { roster, groups, rows, environmentId, refresh, slackEnabled, supportsMembers } =
    useBotRoster();
  const mainName = roster[0]?.profile?.name ?? "GOAT Bot";
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
            name={mainName}
            slackEnabled={slackEnabled}
            main={roster[0]?.profile ?? null}
          />
          {environmentId && (
            <GoatBotChildRows environmentId={environmentId} rows={rows} refresh={refresh} />
          )}
          {environmentId && supportsMembers ? (
            <>
              <GoatBotMemberRoster environmentId={environmentId} groups={groups} />
              <NewBotButton environmentId={environmentId} mainName={mainName} />
            </>
          ) : (
            <NewBotComingSoon />
          )}
        </div>
      )}
    </>
  );
}

function NewBotButton({
  environmentId,
  mainName,
}: {
  environmentId: EnvironmentId;
  mainName: string;
}) {
  const canCreate = useAtomValue(channelEnvironment.createBot.permissionAtom(environmentId));
  const [open, setOpen] = useState(false);
  // The new bot's row shows at once; the roster's own row replaces it when the bot arrives.
  const [creating, setCreating] = useState<string | null>(null);
  const navigate = useNavigate();
  return (
    <SidebarGroup>
      {creating !== null ? (
        <div
          role="status"
          className="mb-1 flex items-center gap-2 rounded-lg px-2 py-2 text-sm text-sidebar-muted-foreground"
        >
          <span
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-full border border-goat-avatar-border bg-goat-avatar text-goat-avatar-foreground"
          >
            {creating.slice(0, 1).toUpperCase()}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sidebar-foreground">{creating}</span>
            <span className="text-xs">Creating…</span>
          </span>
        </div>
      ) : null}
      <Button
        variant="outline"
        size="sm"
        className="w-full"
        disabled={!canCreate}
        onClick={() => setOpen(true)}
      >
        <PlusIcon />
        New bot
      </Button>
      {open ? (
        <GoatBotNewBotDialog
          environmentId={environmentId}
          canSubmit={canCreate}
          mainName={mainName}
          onClose={() => setOpen(false)}
          onPending={setCreating}
          onCreated={(bot) => void navigate({ to: "/bot", search: { bot: bot.botId } })}
        />
      ) : null}
    </SidebarGroup>
  );
}

/** Servers without member bots keep the disabled button and its note. */
function NewBotComingSoon() {
  return (
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
  );
}
