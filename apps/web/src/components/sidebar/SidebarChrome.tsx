import { ArrowLeftIcon, ChartNoAxesColumnIcon, SettingsIcon } from "~/components/solar";
import type { ReactNode } from "react";
import { memo } from "react";
import { Link, useLocation, useNavigate, useParams } from "@tanstack/react-router";

import { useGlobalAgentStore } from "../../globalAgentStore";
import { globalAgentLogoTarget, isGoatBotRoute, isGlobalAgentRoute } from "../../globalAgentRoute";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { usePullRequestsSupported } from "../../state/environments";
import { GoatLogotype } from "../GoatLogotype";
import { GoatWordmark } from "../GoatWordmark";
import { useBrandChannel } from "./brandChannel";
import { BrandChannelPill } from "./BrandChannelPill";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { isSidebarUtilityPage, useNavigateToMainApp } from "./mainAppLocation";
import { SidebarThreadUndoNotice } from "./SidebarThreadUndoNotice";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { observeResize } from "~/lib/observeResize";
import { useGoatBotPreferred } from "../goatBot/GoatBotModeButton";
import { useGoatBotWaitingCount } from "../goatBot/useGoatBotWaitingCount";
import { useDestinationRailVisible } from "./DestinationRail";
import {
  SidebarPriorityCountBadge,
  SidebarViewToggles,
  useSidebarPriorityCount,
} from "./SidebarViewToggles";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const isOnSettings = useLocation({
    select: (location) =>
      location.pathname === "/settings" || location.pathname.startsWith("/settings/"),
  });
  const channel = useBrandChannel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const showChannel = environmentIdentificationMode === "pill" && channel !== "stable";

  return (
    <div
      className={cn(
        "relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 pr-3",
        isElectron && "drag-region",
      )}
    >
      {showChannel ? (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-0 top-0 h-0.5",
            channel === "dev" ? "bg-channel-dev" : "bg-channel-nightly",
          )}
        />
      ) : null}
      {/* Match the fixed control's inset and border compensation inside the sheet's safe area. */}
      <div className="relative top-[calc(var(--workspace-controls-top)-env(safe-area-inset-top))] z-10 ml-[calc(var(--workspace-controls-left)+1px-env(safe-area-inset-left))] flex shrink-0 items-center md:hidden">
        <SidebarTrigger
          variant="ghost"
          className="relative top-auto translate-y-0"
          aria-label="Toggle main sidebar"
        />
      </div>
      <div className="relative z-10 flex h-8 min-w-0 flex-1 flex-wrap content-start items-center gap-x-2 overflow-hidden py-0.5">
        <SidebarBrand />
        {showChannel ? (
          <div className="ml-1 flex h-7 items-center">
            <BrandChannelPill channel={channel} />
          </div>
        ) : null}
      </div>
      {!isOnSettings ? <SidebarViewToggles /> : null}
    </div>
  );
});

export function SidebarBrandWidthProbe({
  onWidthChange,
}: {
  onWidthChange: (width: number) => void;
}) {
  const priorityCount = useSidebarPriorityCount();
  const observeWidth = (probe: HTMLDivElement) => {
    return observeResize(probe, ([entry]) => {
      if (entry) onWidthChange(entry.borderBoxSize[0]?.inlineSize ?? probe.offsetWidth);
    });
  };

  return (
    // The channel pill is left out: the header wraps it onto a clipped row when the sidebar is
    // narrow, and the channel strip still marks the build, so it must not raise the minimum width.
    <div
      aria-hidden="true"
      className="pointer-events-none invisible fixed top-0 left-0 flex w-max items-center gap-2 border-r border-transparent pr-3"
      ref={observeWidth}
    >
      <div className="ml-[calc(var(--workspace-titlebar-content-left)-0.375rem)] flex px-1.5">
        <SidebarBrandContents wordmark />
      </div>
      <span className="flex items-center gap-1">
        <span className="size-8 sm:size-7" />
        <SidebarPriorityCountBadge priorityCount={priorityCount} />
        <span className="size-8 sm:size-7" />
      </span>
    </div>
  );
}

function SidebarBrand({ placement = "header" }: { placement?: "header" | "collapsed" }) {
  const enabled = useGoatBotPreferred();
  const botRef = useGlobalAgentStore((state) => state.botRef);
  const logo = globalAgentLogoTarget(enabled);
  const globalAgentRef = useGlobalAgentStore((state) => state.ref);
  const pathname = useLocation({ select: (location) => location.pathname });
  const params = useParams({ strict: false });
  const target = resolveThreadRouteTarget(params);
  const active = enabled
    ? isGoatBotRoute(pathname, target, botRef)
    : isGlobalAgentRoute(pathname, target, globalAgentRef);
  return (
    <Link
      aria-label={logo.label}
      aria-current={active ? "page" : undefined}
      data-active={active}
      className={cn(
        // Padding holds the selected fill off the mark. The left margin keeps the letters at
        // the titlebar inset; the right padding stays in flow (and in the width probe above) so
        // the header's overflow clip never cuts the selected fill at the minimum sidebar width.
        "relative z-10 h-7 w-fit min-w-0 max-w-full shrink-0 items-center overflow-hidden rounded-md px-1.5 outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset",
        placement === "header"
          ? "ml-[calc(var(--workspace-titlebar-content-left)-0.375rem)] hidden md:flex"
          : "pointer-events-auto flex [-webkit-app-region:no-drag]",
        "text-foreground",
        active ? "bg-sidebar-row-selected" : null,
      )}
      to={logo.to}
    >
      <SidebarBrandContents wordmark />
    </Link>
  );
}

export function SidebarCollapsedBrand({
  visible,
  onWidthChange,
}: {
  visible: boolean;
  onWidthChange: (width: number) => void;
}) {
  const channel = useBrandChannel();
  const showChannel = useEnvironmentIdentificationMode() === "pill" && channel !== "stable";
  const observeWidth = (probe: HTMLDivElement) =>
    observeResize(probe, ([entry]) => {
      if (entry) onWidthChange(entry.borderBoxSize[0]?.inlineSize ?? probe.offsetWidth);
    });

  return (
    <div
      ref={observeWidth}
      data-collapsed-brand=""
      aria-hidden={!visible}
      className={cn(
        // oxlint-disable-next-line shadcn/no-arbitrary-values -- Match the measured titlebar control gap.
        "hidden shrink-0 items-center gap-2 pl-[var(--workspace-titlebar-control-gap)] md:flex",
        visible ? "pointer-events-auto" : "invisible pointer-events-none",
      )}
    >
      {visible ? (
        <SidebarBrand placement="collapsed" />
      ) : (
        // Keep the measured width without adding a focus target or a no-drag region.
        <span className="flex h-7 w-fit min-w-0 shrink-0 items-center overflow-hidden rounded-md px-1.5">
          <SidebarBrandContents wordmark />
        </span>
      )}
      {showChannel ? <BrandChannelPill channel={channel} /> : null}
    </div>
  );
}

/** The visible brand and both width probes measure the same waiting badge. */
function SidebarBrandContents({ wordmark }: { wordmark: boolean }) {
  const waitingCount = useGoatBotWaitingCount();
  return (
    <>
      <SidebarBrandMark wordmark={wordmark} />
      {waitingCount !== undefined && waitingCount > 0 ? (
        <span className="ml-1 text-xs">{waitingCount}</span>
      ) : null}
    </>
  );
}

function SidebarBrandMark({ wordmark }: { wordmark: boolean }) {
  if (!wordmark) return <GoatWordmark aria-hidden className="size-4 shrink-0" />;
  return <GoatLogotype className="text-foreground" />;
}

function SidebarUtilityItem({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton aria-label={label} onClick={onClick} size="icon">
              {icon}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

export const SidebarUtilityMenu = memo(function SidebarUtilityMenu() {
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const { isMobile, setOpenMobile } = useSidebar();
  const isOnUtilityPage = useLocation({
    select: (location) => isSidebarUtilityPage(location.pathname),
  });
  const pullRequestsSupported = usePullRequestsSupported();
  // The destination rail carries Home, Settings, Pull requests, Usage and the update button.
  const railVisible = useDestinationRailVisible();
  const closeMobileSidebar = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
  };
  const handlePullRequestsClick = () => {
    closeMobileSidebar();
    void navigate({
      to: "/pull-requests",
      search: readPullRequestListPreferences(),
    });
  };
  const handleSettingsClick = () => {
    closeMobileSidebar();
    void navigate({ to: "/settings" });
  };

  const handleUsageClick = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/usage" });
  };

  const handleBackClick = () => {
    closeMobileSidebar();
    void navigateToMainApp();
  };

  if (railVisible) return null;

  return (
    <SidebarMenu className="flex-row items-center">
      {isOnUtilityPage ? (
        <SidebarMenuItem className="min-w-0 flex-1">
          <SidebarMenuButton onClick={handleBackClick}>
            <ArrowLeftIcon />
            <span>Back</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : (
        <>
          <SidebarUtilityItem
            icon={<SettingsIcon />}
            label="Settings"
            onClick={handleSettingsClick}
          />
          {pullRequestsSupported ? (
            <SidebarUtilityItem
              icon={<PullRequestGlyph.pullRequest />}
              label="Pull Requests"
              onClick={handlePullRequestsClick}
            />
          ) : null}
          <SidebarUtilityItem
            icon={<ChartNoAxesColumnIcon />}
            label="Usage"
            onClick={handleUsageClick}
          />
        </>
      )}
      <SidebarUpdatePill />
    </SidebarMenu>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  return (
    <SidebarFooter>
      <SidebarThreadUndoNotice />
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      <SidebarUtilityMenu />
    </SidebarFooter>
  );
});
