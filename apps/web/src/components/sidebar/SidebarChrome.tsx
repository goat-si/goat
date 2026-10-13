import { ArrowLeftIcon, ChartNoAxesColumnIcon, SettingsIcon } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useCallback } from "react";
import { Link, useLocation, useNavigate, useParams } from "@tanstack/react-router";

import { useGlobalAgentStore } from "../../globalAgentStore";
import { globalAgentLogoTarget, isGoatBotRoute, isGlobalAgentRoute } from "../../globalAgentRoute";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { usePullRequestsSupported } from "../../state/environments";
import { GoatWordmark } from "../GoatWordmark";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  SidebarStageBackdrop,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
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
import { SidebarViewToggles } from "./SidebarViewToggles";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const isOnSettings = useLocation({
    select: (location) =>
      location.pathname === "/settings" || location.pathname.startsWith("/settings/"),
  });
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    environmentIdentificationMode === "artwork",
  );
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;

  return (
    // The titlebar row, not a padded SidebarHeader: it aligns to the window controls.
    <div
      className={cn(
        "relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 pr-3",
        isElectron && "drag-region",
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      {/* Match the fixed control's inset and border compensation inside the sheet's safe area. */}
      <div className="relative top-[calc(var(--workspace-controls-top)-env(safe-area-inset-top))] z-10 ml-[calc(var(--workspace-controls-left)+1px-env(safe-area-inset-left))] flex shrink-0 items-center md:hidden">
        <SidebarTrigger
          // Over the stage artwork: the media viewer's control-on-imagery treatment.
          variant={backdropVariant ? "media-navigation" : "ghost"}
          className="relative top-auto translate-y-0"
          aria-label="Toggle main sidebar"
        />
      </div>
      {/* One visible line: the pill wraps onto the clipped second line once it no longer fits.
          The padding keeps the brand's focus ring inside the clip. */}
      <div className="relative z-10 flex h-8 min-w-0 flex-1 flex-wrap content-start items-center gap-x-2 overflow-hidden py-0.5">
        <SidebarBrand onBackdrop={backdropVariant !== null} />
        {pillLabel ? (
          <div className="ml-1 flex h-7 items-center">
            <Badge data-environment-identification="pill" size="sm" variant="secondary">
              {pillLabel}
            </Badge>
          </div>
        ) : null}
      </div>
      {!isOnSettings ? <SidebarViewToggles onBackdrop={backdropVariant !== null} /> : null}
    </div>
  );
});

// Measures the brand at its titlebar inset, plus the header's right padding and the
// sidebar border, so the sidebar minimum follows font size, zoom and macOS window controls.
export function SidebarBrandWidthProbe({
  onWidthChange,
}: {
  onWidthChange: (width: number) => void;
}) {
  const observeWidth = useCallback(
    (probe: HTMLDivElement) => {
      return observeResize(probe, ([entry]) => {
        if (entry) onWidthChange(entry.borderBoxSize[0]?.inlineSize ?? probe.offsetWidth);
      });
    },
    [onWidthChange],
  );

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none invisible fixed top-0 left-0 flex w-max items-center gap-2 border-r border-transparent pr-3"
      ref={observeWidth}
    >
      <div className="ml-[calc(var(--workspace-titlebar-content-left)-0.375rem)] flex px-1.5">
        <SidebarBrandContents onBackdrop={false} wordmark={false} />
      </div>
      <span className="flex items-center gap-1">
        <span className="size-8 sm:size-7" />
        <span className="size-8 sm:size-7" />
      </span>
    </div>
  );
}

function SidebarBrand({
  onBackdrop,
  placement = "header",
}: {
  onBackdrop: boolean;
  placement?: "header" | "collapsed";
}) {
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
        "relative z-10 h-7 w-fit min-w-0 shrink-0 items-center overflow-hidden rounded-md px-1.5 outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset",
        placement === "header"
          ? "ml-[calc(var(--workspace-titlebar-content-left)-0.375rem)] hidden md:flex"
          : "pointer-events-auto flex [-webkit-app-region:no-drag]",
        onBackdrop ? "text-white" : "text-foreground",
        active && !onBackdrop ? "bg-sidebar-row-selected" : null,
        active && onBackdrop ? "bg-white/15" : null,
      )}
      to={logo.to}
    >
      {/* The sidebar header is too narrow for the wordmark beside its controls; the collapsed
          titlebar has room for it. */}
      <SidebarBrandContents onBackdrop={onBackdrop} wordmark={placement === "collapsed"} />
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
  const observeWidth = useCallback(
    (probe: HTMLDivElement) => {
      return observeResize(probe, ([entry]) => {
        if (entry) onWidthChange(entry.borderBoxSize[0]?.inlineSize ?? probe.offsetWidth);
      });
    },
    [onWidthChange],
  );

  return (
    <div
      ref={observeWidth}
      data-collapsed-brand=""
      aria-hidden={!visible}
      className={cn(
        // oxlint-disable-next-line shadcn/no-arbitrary-values -- Match the measured titlebar control gap.
        "hidden shrink-0 items-center pl-[var(--workspace-titlebar-control-gap)] md:flex",
        visible ? "pointer-events-auto" : "invisible pointer-events-none",
      )}
    >
      {visible ? (
        <SidebarBrand placement="collapsed" onBackdrop={false} />
      ) : (
        // Keep the measured width without adding a focus target or a no-drag region.
        <span className="flex h-7 w-fit min-w-0 shrink-0 items-center overflow-hidden rounded-md px-1.5">
          <SidebarBrandContents onBackdrop={false} wordmark />
        </span>
      )}
    </div>
  );
}

/** The visible brand and both width probes measure the same waiting badge. */
function SidebarBrandContents({
  onBackdrop,
  wordmark,
}: {
  onBackdrop: boolean;
  wordmark: boolean;
}) {
  const waitingCount = useGoatBotWaitingCount();
  return (
    <>
      <SidebarBrandMark onBackdrop={onBackdrop} wordmark={wordmark} />
      {waitingCount !== undefined && waitingCount > 0 ? (
        <span className="ml-1 text-xs">{waitingCount}</span>
      ) : null}
    </>
  );
}

function SidebarBrandMark({ onBackdrop, wordmark }: { onBackdrop: boolean; wordmark: boolean }) {
  if (!wordmark) return <GoatWordmark aria-hidden className="size-4 shrink-0" />;
  return (
    // Center the visible capitals, without the font's ascender/descender space.
    // Padding keeps ascenders and round-letter overshoot inside the truncation clip.
    <span className="inline-flex min-w-0 items-center gap-1.5 text-sm">
      <GoatWordmark aria-hidden className="size-4 shrink-0" />
      <span
        className={cn(
          // oxlint-disable-next-line shadcn/no-arbitrary-values -- Brand letter spacing follows the approved wordmark.
          "font-brand truncate font-bold tracking-[0.04em] [text-box:trim-both_cap_alphabetic] supports-[text-box:trim-both_cap_alphabetic]:py-1",
          onBackdrop ? "text-white" : "text-foreground",
        )}
      >
        GOAT
      </span>
    </span>
  );
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
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile, setOpenMobile]);
  const handlePullRequestsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({
      to: "/pull-requests",
      search: readPullRequestListPreferences(),
    });
  }, [closeMobileSidebar, navigate]);
  const handleSettingsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/settings" });
  }, [closeMobileSidebar, navigate]);

  const handleUsageClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/usage" });
  }, [isMobile, navigate, setOpenMobile]);

  const handleBackClick = useCallback(() => {
    closeMobileSidebar();
    void navigateToMainApp();
  }, [closeMobileSidebar, navigateToMainApp]);

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
