import { useAtomValue } from "@effect/atom-react";
import {
  botManageFailure,
  dismissCreatedBot,
  dismissNewBot,
  forgetNewBotIntentsOf,
  retryNewBot,
  settleListedNewBots,
  startNewBot,
  type CreateNewBot,
  type OpenIfStillHere,
} from "@goat/client-runtime/goatBot";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { BotProfile, EnvironmentId } from "@goat/contracts";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef } from "react";
import { PlusIcon } from "~/components/solar";
import { selectGlobalAgentMode, useGlobalAgentStore } from "~/globalAgentStore";
import { randomUUID } from "~/lib/utils";
import { channelEnvironment } from "~/state/channels";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SidebarGroup, useSidebar, useSidebarVisibility } from "../ui/sidebar";
import { Tabs, TabsList, TabsTab } from "../ui/tabs";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { GoatBotNeedsYou } from "./GoatBotNeedsYou";
import { GoatBotSidebarRow } from "./GoatBotSidebarRow";
import { GoatBotChildRows } from "./GoatBotChildRows";
import { GoatBotMemberRoster } from "./GoatBotMemberRows";
import { GoatBotNewBotStatus } from "./GoatBotNewBotStatus";
import { openNewBotChat } from "./goatBotNewBotOpen";
import { navigationBlocked } from "~/lib/navigationHolds";
import { useBotRoster } from "./useBotRoster";
import { useGoatBotHome } from "./useGoatBotHome";
import { useGoatBotEnabled } from "./useGoatBotSession";
import { useNewBotSlot } from "./useNewBotSlot";

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
  const {
    bots,
    botsError,
    retryBots,
    roster,
    groups,
    rows,
    environmentId,
    refresh,
    slackEnabled,
    supportsMembers,
  } = useBotRoster();
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
        <GoatBotNeedsYou
          key={environmentId}
          environmentId={environmentId}
          bots={bots ?? []}
          visible={mode === "bot"}
        />
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
              <NewBotButton
                environmentId={environmentId}
                bots={bots}
                botsError={botsError}
                retryBots={retryBots}
              />
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
  bots,
  botsError,
  retryBots,
}: {
  environmentId: EnvironmentId;
  /** The roster's last good read, deleted bots included; a created bot's row waits for it. */
  bots: ReadonlyArray<BotProfile> | undefined;
  botsError: string | null;
  retryBots: () => void;
}) {
  const canCreate = useAtomValue(channelEnvironment.createBot.permissionAtom(environmentId));
  const send = useAtomCommand(channelEnvironment.createBot, { reportFailure: false });
  const { operation, created } = useNewBotSlot(environmentId);
  const visible = useSidebarVisibility();
  const { setOpenMobile } = useSidebar();
  const router = useRouter();
  // This roster as it is now: mounted, showing, and its environment. A create's answer reads it
  // then; the open belongs to the roster that was clicked.
  const mount = useRef({ mounted: true, visible, environmentId });
  // oxlint-disable-next-line goat/react-effect-budget -- A create answers later; it must read this roster's committed state.
  useLayoutEffect(() => {
    mount.current = { mounted: true, visible, environmentId };
  }, [visible, environmentId]);
  // oxlint-disable-next-line goat/react-effect-budget -- An unmounted roster (the Threads tab, the closed narrow sheet) opens nothing when its create answers.
  useEffect(() => {
    const owner = mount;
    return () => {
      owner.current = { ...owner.current, mounted: false };
      forgetNewBotIntentsOf(owner);
    };
  }, []);
  const create: CreateNewBot = async (name, clientRequestId) => {
    const result = await send({
      environmentId,
      input: { clientRequestId, name, avatar: null, purpose: "", defaultModelSelection: null },
    });
    return result._tag === "Success"
      ? result.value.bot
      : botManageFailure(squashAtomCommandFailure(result));
  };
  // The chat opens only if, when the create answers, this roster is still mounted and showing the
  // environment the create went to, the page is the one clicked from, and no bot menu and nothing
  // modal is open. The narrow sheet closes only after that check.
  const openIfStillHere = (): OpenIfStillHere => {
    const clickedAt = router.state.location.href;
    return (bot, sentTo) => {
      const now = mount.current;
      if (!now.mounted || !now.visible || now.environmentId !== sentTo) return;
      if (router.state.location.href !== clickedAt || navigationBlocked()) return;
      setOpenMobile(false);
      openNewBotChat(router, bot);
    };
  };
  const listedIds = new Set((bots ?? []).map((bot) => bot.botId));
  const settle = () => settleListedNewBots(environmentId, listedIds);
  return (
    <SidebarGroup>
      {botsError !== null ? (
        <div className="mb-1 flex items-center gap-2 px-2 py-1">
          <p role="alert" className="min-w-0 flex-1 text-xs text-destructive-foreground">
            Couldn't load bots: {botsError}
          </p>
          <Button size="xs" variant="outline" aria-label="Retry loading bots" onClick={retryBots}>
            Retry
          </Button>
        </div>
      ) : null}
      <GoatBotNewBotStatus
        operation={operation}
        created={created.filter((bot) => !listedIds.has(bot.botId))}
        onRetry={() => {
          settle();
          retryNewBot(environmentId, create, openIfStillHere(), mount);
        }}
        onDismiss={() => dismissNewBot(environmentId)}
        onDismissCreated={(bot) => dismissCreatedBot(environmentId, bot.botId)}
      />
      <Button
        variant="outline"
        size="sm"
        className="w-full"
        disabled={!canCreate || bots === undefined}
        // While a create runs or waits to be retried, New bot stays focusable and does nothing.
        aria-disabled={operation !== null || undefined}
        onClick={() => {
          if (bots === undefined || operation !== null) return;
          settle();
          startNewBot(environmentId, bots, create, openIfStillHere(), mount, randomUUID);
        }}
      >
        <PlusIcon />
        New bot
      </Button>
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
