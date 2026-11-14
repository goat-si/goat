import {
  buildGoatBotTimeline,
  goatBotConversationPreview,
  goatBotItemReaders,
  type GoatBotConversationPreview,
  type GoatBotRef,
} from "@goat/client-runtime/goatBot";
import { scopeThreadRef, scopedThreadKey } from "@goat/client-runtime/environment";
import { BotId, type BotProfile, type EnvironmentId } from "@goat/contracts";
import { Link, useLocation, useParams } from "@tanstack/react-router";
import { useContext } from "react";

import { GOAT_BOT_PATH, isGoatBotRoute } from "~/globalAgentRoute";
import { useGlobalAgentStore } from "~/globalAgentStore";
import { resolveThreadRouteTarget } from "~/threadRoutes";
import { useUiStateStore } from "~/uiStateStore";
import {
  resolveThreadDetailRef,
  useThreadShell,
  useThreadVisibleTurnItems,
} from "~/state/entities";

import { RelativeTimeLabel } from "../RelativeTimeLabel";
import { resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { Badge } from "../ui/badge";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";
import { GoatBotMainAvatar } from "./GoatBotAvatar";
import { useGoatBotPreferred } from "./GoatBotModeButton";
import { GoatBotChannelContext } from "./goatBotChannelPort";
import { GoatBotMainMenu } from "./GoatBotMemberRows";
import { useGoatBotSidebarWaiting } from "./useGoatBotWaitingCount";
import { GoatBotRowSignals } from "./GoatBotRowSignals";
import { useGoatBotReadMenu } from "./useGoatBotReadMenu";
import { useBotThreads } from "./useBotRoster";

type GoatBotReadMenuProps = ReturnType<typeof useGoatBotReadMenu>;

/** GOAT Bot's pinned place at the top of the thread list, hidden in thread mode. */
export function GoatBotSidebarRow({
  name = "GOAT Bot",
  slackEnabled = false,
  main = null,
}: { name?: string; slackEnabled?: boolean; main?: BotProfile | null } = {}) {
  const port = useContext(GoatBotChannelContext);
  const enabled = useGoatBotPreferred();
  return enabled ? (
    <GoatBotSidebarObserver
      key={port ? "port" : "none"}
      name={name}
      slackEnabled={slackEnabled}
      main={main}
    />
  ) : null;
}

/** Observes the bot without creating a bot thread. */
function GoatBotSidebarObserver({
  name,
  slackEnabled,
  main,
}: {
  name: string;
  slackEnabled: boolean;
  main: BotProfile | null;
}) {
  const waiting = useGoatBotSidebarWaiting();
  const count = waiting.count;
  const readMenu = useGoatBotReadMenu(count, name, { holdsNewBotOpen: true });
  const botRef = useGlobalAgentStore((state) => state.botRef);
  const pathname = useLocation({ select: (location) => location.pathname });
  const task = useLocation({
    select: (location) => (location.search as { task?: string } | undefined)?.task,
  });
  const params = useParams({ strict: false });
  const active =
    task === undefined && isGoatBotRoute(pathname, resolveThreadRouteTarget(params), botRef);
  const { isMobile, setOpenMobile } = useSidebar();
  const threadRef = botRef ? scopeThreadRef(botRef.environmentId, botRef.threadId) : null;
  const shell = useThreadShell(threadRef);
  const handleClick = () => {
    if (isMobile) setOpenMobile(false);
  };
  return (
    <SidebarGroup className="z-1">
      <SidebarMenu>
        <SidebarMenuItem>
          {botRef && shell?.lastVisitedAt !== undefined ? (
            <GoatBotSidebarPreview
              key={`${botRef.environmentId}:${botRef.threadId}`}
              name={name}
              avatar={main?.avatar ?? null}
              slackEnabled={slackEnabled}
              botRef={botRef}
              active={active}
              count={count}
              waiting={waiting}
              onClick={handleClick}
              readMenu={readMenu}
            />
          ) : (
            <GoatBotConversationRow
              name={name}
              avatar={main?.avatar ?? null}
              slackEnabled={slackEnabled}
              active={active}
              count={count}
              waiting={waiting}
              onClick={handleClick}
              readMenu={readMenu}
              preview={null}
              at={shell?.updatedAt ?? null}
            />
          )}
          {main ? <GoatBotMainMenu environmentId={main.environmentId} main={main} /> : null}
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
  );
}

function GoatBotSidebarPreview({
  name,
  avatar,
  slackEnabled,
  botRef,
  active,
  count,
  waiting,
  onClick,
  readMenu,
}: {
  name: string;
  avatar: string | null;
  slackEnabled: boolean;
  botRef: GoatBotRef;
  active: boolean;
  count: number | undefined;
  waiting: {
    environmentId: EnvironmentId | null;
    governed: boolean;
    count: number | undefined;
    state: "ready" | "pending" | "unavailable";
  };
  onClick: () => void;
  readMenu: GoatBotReadMenuProps;
}) {
  const threadRef = scopeThreadRef(botRef.environmentId, botRef.threadId);
  const shell = useThreadShell(threadRef);
  const items = useThreadVisibleTurnItems(
    resolveThreadDetailRef(threadRef, { shellExists: shell !== null, waitForShell: true }),
  );
  const localLastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[scopedThreadKey(threadRef)],
  );
  // The preview reads the chat as it shows: no cards for the tasks its work list opens.
  const work = useBotThreads(botRef.environmentId, null);
  const rows = buildGoatBotTimeline({
    visibleTurnItems: items,
    pendingInputs: [],
    readers: goatBotItemReaders,
    taskId: null,
    knownTaskIds: work.rows.flatMap((row) => (row.kind === "task" ? [row.task.taskId] : [])),
    conversationOnly: work.supported,
    answerReferences: true,
  });
  const preview = goatBotConversationPreview({
    rows,
    lastVisitedAt: resolveThreadLastVisitedAt(shell?.lastVisitedAt, localLastVisitedAt),
    active,
  });
  return (
    <GoatBotConversationRow
      name={name}
      avatar={avatar}
      slackEnabled={slackEnabled}
      active={active}
      count={count}
      waiting={waiting}
      onClick={onClick}
      readMenu={readMenu}
      preview={preview}
      at={preview?.at ?? shell?.updatedAt ?? null}
    />
  );
}

function GoatBotConversationRow({
  name,
  avatar,
  slackEnabled,
  active,
  count,
  waiting,
  onClick,
  readMenu,
  preview,
  at,
}: {
  name: string;
  avatar: string | null;
  slackEnabled: boolean;
  active: boolean;
  count: number | undefined;
  waiting: {
    environmentId: EnvironmentId | null;
    governed: boolean;
    count: number | undefined;
    state: "ready" | "pending" | "unavailable";
  };
  onClick: () => void;
  readMenu: GoatBotReadMenuProps;
  preview: GoatBotConversationPreview | null;
  at: string | null;
}) {
  return (
    <SidebarMenuButton
      size="lg"
      isActive={active}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      {...readMenu}
      render={<Link to={GOAT_BOT_PATH} />}
    >
      {/* The face's label leads the link's name; the dot is said after the name. */}
      <span
        className="flex size-2.5 shrink-0 items-center justify-center group-data-[collapsible=icon]:absolute group-data-[collapsible=icon]:right-0 group-data-[collapsible=icon]:top-0"
        aria-hidden
      >
        {preview?.unread ? <span className="size-2.5 rounded-full bg-info" /> : null}
      </span>
      <GoatBotMainAvatar
        size="md"
        place="list"
        surface="sidebar"
        emoji={avatar}
        countInLabel
        waitingOverride={waiting.governed ? (count ?? null) : undefined}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 group-data-[collapsible=icon]:hidden">
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={
              preview?.unread
                ? "min-w-0 flex-1 truncate font-semibold text-sidebar-foreground"
                : "min-w-0 flex-1 truncate"
            }
          >
            {name}
            {preview?.unread ? <span className="sr-only">, unread</span> : null}
          </span>
          {at ? (
            <span
              data-slot="goat-bot-relative-time"
              className="shrink-0 text-xs font-normal text-sidebar-muted-foreground"
            >
              <RelativeTimeLabel timestamp={at} />
            </span>
          ) : null}
          <GoatBotRowSignals
            environmentId={waiting.environmentId}
            botId={BotId.make("main")}
            governed={waiting.governed}
            waiting={count}
            waitingState={waiting.state}
          />
          {count !== undefined && count > 0 ? (
            <Badge size="sm" variant="secondary" aria-hidden>
              {count}
            </Badge>
          ) : null}
        </span>
        <span className="flex min-w-0 items-center gap-1">
          <Badge size="sm" variant="secondary">
            Main
          </Badge>
          {slackEnabled && (
            <Badge size="sm" variant="secondary">
              Slack
            </Badge>
          )}
          {preview ? (
            <span
              className={
                preview.unread
                  ? "min-w-0 flex-1 truncate text-xs font-normal text-sidebar-foreground/75"
                  : "min-w-0 flex-1 truncate text-xs font-normal text-sidebar-muted-foreground"
              }
            >
              {preview.text}
            </span>
          ) : null}
        </span>
      </span>
      {/* Room for the row's options button, which sits over the right edge. */}
      <span aria-hidden className="w-5 shrink-0 group-data-[collapsible=icon]:hidden" />
    </SidebarMenuButton>
  );
}
