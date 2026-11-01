import {
  buildGoatBotTimeline,
  goatBotConversationPreview,
  goatBotItemReaders,
  type GoatBotConversationPreview,
  type GoatBotRef,
} from "@goat/client-runtime/goatBot";
import { scopeThreadRef, scopedThreadKey } from "@goat/client-runtime/environment";
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
import { GoatBotAvatar } from "./GoatBotAvatar";
import { useGoatBotPreferred } from "./GoatBotModeButton";
import { GoatBotChannelContext } from "./goatBotChannelPort";
import { useGoatBotHome } from "./useGoatBotHome";
import { useGoatBotWaitingCount } from "./useGoatBotWaitingCount";
import { useGoatBotReadMenu } from "./useGoatBotReadMenu";

type GoatBotReadMenuProps = ReturnType<typeof useGoatBotReadMenu>;

/** GOAT Bot's pinned place at the top of the thread list, hidden in thread mode. */
export function GoatBotSidebarRow() {
  useGoatBotHome();
  const port = useContext(GoatBotChannelContext);
  const enabled = useGoatBotPreferred();
  return enabled ? <GoatBotSidebarObserver key={port ? "port" : "none"} /> : null;
}

/** Observes the bot without creating a bot thread. */
function GoatBotSidebarObserver() {
  const count = useGoatBotWaitingCount();
  const readMenu = useGoatBotReadMenu(count);
  const botRef = useGlobalAgentStore((state) => state.botRef);
  const pathname = useLocation({ select: (location) => location.pathname });
  const params = useParams({ strict: false });
  const active = isGoatBotRoute(pathname, resolveThreadRouteTarget(params), botRef);
  const { isMobile, setOpenMobile } = useSidebar();
  const threadRef = botRef ? scopeThreadRef(botRef.environmentId, botRef.threadId) : null;
  const shell = useThreadShell(threadRef);
  const handleClick = () => {
    if (isMobile) setOpenMobile(false);
  };
  return (
    <SidebarGroup className="z-[1]">
      <SidebarMenu>
        <SidebarMenuItem>
          {botRef && shell?.lastVisitedAt !== undefined ? (
            <GoatBotSidebarPreview
              key={`${botRef.environmentId}:${botRef.threadId}`}
              botRef={botRef}
              active={active}
              count={count}
              onClick={handleClick}
              readMenu={readMenu}
            />
          ) : (
            <GoatBotConversationRow
              active={active}
              count={count}
              onClick={handleClick}
              readMenu={readMenu}
              preview={null}
              at={shell?.updatedAt ?? null}
            />
          )}
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
  );
}

function GoatBotSidebarPreview({
  botRef,
  active,
  count,
  onClick,
  readMenu,
}: {
  botRef: GoatBotRef;
  active: boolean;
  count: number | undefined;
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
  const rows = buildGoatBotTimeline({
    visibleTurnItems: items,
    pendingInputs: [],
    readers: goatBotItemReaders,
  });
  const preview = goatBotConversationPreview({
    rows,
    lastVisitedAt: resolveThreadLastVisitedAt(shell?.lastVisitedAt, localLastVisitedAt),
    active,
  });
  return (
    <GoatBotConversationRow
      active={active}
      count={count}
      onClick={onClick}
      readMenu={readMenu}
      preview={preview}
      at={preview?.at ?? shell?.updatedAt ?? null}
    />
  );
}

function GoatBotConversationRow({
  active,
  count,
  onClick,
  readMenu,
  preview,
  at,
}: {
  active: boolean;
  count: number | undefined;
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
      <span
        className="flex size-2.5 shrink-0 items-center justify-center group-data-[collapsible=icon]:absolute group-data-[collapsible=icon]:right-0 group-data-[collapsible=icon]:top-0"
        aria-hidden={!preview?.unread}
      >
        {preview?.unread ? (
          <span
            className="size-2.5 rounded-full bg-info"
            role="img"
            aria-label="Unread GOAT Bot messages"
          />
        ) : null}
      </span>
      <GoatBotAvatar size="sm" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 group-data-[collapsible=icon]:hidden">
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={
              preview?.unread
                ? "min-w-0 flex-1 truncate font-semibold text-sidebar-foreground"
                : "min-w-0 flex-1 truncate"
            }
          >
            GOAT Bot
          </span>
          {at ? (
            <span
              data-slot="goat-bot-relative-time"
              className="shrink-0 text-xs font-normal text-sidebar-muted-foreground"
            >
              <RelativeTimeLabel timestamp={at} />
            </span>
          ) : null}
          {count !== undefined && count > 0 ? (
            <Badge size="sm" variant="secondary">
              {count}
            </Badge>
          ) : null}
        </span>
        {preview ? (
          <span
            className={
              preview.unread
                ? "truncate text-xs font-normal text-sidebar-foreground/75"
                : "truncate text-xs font-normal text-sidebar-muted-foreground"
            }
          >
            {preview.text}
          </span>
        ) : null}
      </span>
    </SidebarMenuButton>
  );
}
