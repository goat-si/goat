import { useAtomValue } from "@effect/atom-react";
import type { BotId, BotProfile, EnvironmentId } from "@goat/contracts";
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
import { GoatBotNeedsYou } from "./GoatBotNeedsYou";
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
  const { bots, roster, groups, rows, environmentId, refresh, slackEnabled, supportsMembers } =
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
      {environmentId && (
        <GoatBotNeedsYou environmentId={environmentId} bots={bots ?? []} visible={mode === "bot"} />
      )}
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
              <NewBotButton environmentId={environmentId} mainName={mainName} bots={bots ?? []} />
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
  bots,
}: {
  environmentId: EnvironmentId;
  mainName: string;
  /** The roster's last read; a new bot's row waits until this list holds it. */
  bots: ReadonlyArray<BotProfile>;
}) {
  const canCreate = useAtomValue(channelEnvironment.createBot.permissionAtom(environmentId));
  const [open, setOpen] = useState(false);
  // The new bot's row shows at once, from the name typed, and stays until the roster lists the
  // bot the server returned; then the roster's own row replaces it. A failed create clears it.
  const [creating, setCreating] = useState<{
    readonly name: string;
    readonly botId: BotId | null;
  } | null>(null);
  const navigate = useNavigate();
  // A row without an id is still being created; one the roster lists has given way to its row.
  const listed =
    creating !== null &&
    creating.botId !== null &&
    bots.some((bot) => bot.botId === creating.botId);
  const pendingName = creating === null || listed ? null : creating.name;
  return (
    <SidebarGroup>
      {pendingName === null ? null : (
        <div
          role="status"
          className="mb-1 flex items-center gap-2 rounded-lg px-2 py-2 text-sm text-sidebar-muted-foreground"
        >
          <span
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-full border border-goat-avatar-border bg-goat-avatar text-goat-avatar-foreground"
          >
            {pendingName.slice(0, 1).toUpperCase()}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sidebar-foreground">{pendingName}</span>
            <span className="text-xs">Creating…</span>
          </span>
        </div>
      )}
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
          onPending={(name) => setCreating(name === null ? null : { name, botId: null })}
          onCreated={(bot) => {
            // The returned id retires the row as soon as the roster reads it, and no later.
            setCreating({ name: bot.name, botId: bot.botId });
            void navigate({ to: "/bot", search: { bot: bot.botId } });
          }}
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
