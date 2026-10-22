import { useAtomValue } from "@effect/atom-react";
import { AuthProvidersManageScope, type EnvironmentId } from "@goat/contracts";
import type { FleetMachineSummary } from "@goat/client-runtime/state/fleet";
import { Link, useLocation, useParams } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import {
  createContext,
  Fragment,
  lazy,
  memo,
  Suspense,
  useContext,
  useState,
  type ReactElement,
} from "react";

import {
  ActivityIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  BotIcon,
  BrainIcon,
  CalendarClockIcon,
  ChartNoAxesColumnIcon,
  FileTextIcon,
  HomeIcon,
  ListChecksIcon,
  PlugIcon,
  PlusIcon,
  RotateCcwIcon,
  ServerIcon,
  SettingsIcon,
  type IconComponent,
} from "~/components/solar";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "~/components/pullRequest/pullRequestListPreferences";

import { isElectron } from "../../env";
import { isGoatBotRoute } from "../../globalAgentRoute";
import { useGlobalAgentStore } from "../../globalAgentStore";
import {
  updateClientSettingsWith,
  useClientSettings,
  useClientSettingsHydrationStatus,
} from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { decisionInbox } from "../../state/decisionInbox";
import {
  useEnvironment,
  useEnvironments,
  usePrimaryEnvironmentId,
  usePullRequestsSupported,
} from "../../state/environments";
import { useFleetSummary } from "../../state/fleet";
import { providerReadyAtom } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { useGoatBotWaitingCount } from "../goatBot/useGoatBotWaitingCount";
import { useGoatBotReadMenu } from "../goatBot/useGoatBotReadMenu";
import {
  isMemoryEnvironmentAvailable,
  validateMemorySettingsSearch,
} from "../settings/MemorySettings.logic";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  DEFAULT_RAIL_PREFERENCES,
  moveRailItem,
  railPreferencesForHydration,
  resolveActiveDestination,
  resolveRailItems,
  setRailItemShown,
  type DestinationId,
  type RailContext,
  type RailItemId,
  type RailPreferences,
  type ResolvedRailItem,
} from "./destinationRail.logic";
import { SidebarUpdatePill } from "./SidebarUpdatePill";

// The wizard only loads once someone opens it from the rail.
const AddProviderInstanceDialog = lazy(() =>
  import("../settings/AddProviderInstanceDialog").then((module) => ({
    default: module.AddProviderInstanceDialog,
  })),
);

/** True while the desktop destination rail is on screen; the sidebar footer drops its duplicates. */
export const DestinationRailVisibleContext = createContext(false);

export function useDestinationRailVisible(): boolean {
  return useContext(DestinationRailVisibleContext);
}

// The rail owns aria-current; Link's own fuzzy matching would also mark /settings on its
// subpages.
const EXACT_MATCH = { exact: true } as const;

const RAIL_ITEMS: Record<RailItemId, { label: string; icon: IconComponent; unavailable?: string }> =
  {
    fleet: { label: "Fleet", icon: ActivityIcon },
    bot: { label: "GOAT Bot", icon: BotIcon },
    decisions: { label: "Decisions", icon: ListChecksIcon },
    usage: { label: "Usage", icon: ChartNoAxesColumnIcon },
    pullRequests: {
      label: "Pull requests",
      icon: PullRequestGlyph.pullRequest,
      unavailable: "No connected environment supports pull requests",
    },
    memory: {
      label: "Memory",
      icon: BrainIcon,
      unavailable: "No connected environment supports memory",
    },
    scheduled: { label: "Scheduled tasks", icon: CalendarClockIcon },
    hub: { label: "Hub", icon: ServerIcon },
    notes: { label: "Notes", icon: FileTextIcon },
    addProvider: {
      label: "Add provider",
      icon: PlugIcon,
      unavailable: "Needs a primary environment where you can manage providers",
    },
  };

function railItemClassName(active: boolean, shape = "size-10 justify-center") {
  return cn(
    "relative flex shrink-0 items-center rounded-lg outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&_svg]:size-5",
    shape,
    // The rail sits on the window background, where the sidebar's row fills (tuned for the
    // sidebar surface) barely show; the accent pair keeps both states visible in every theme.
    active
      ? "bg-accent text-accent-foreground"
      : "text-sidebar-muted-foreground hover:bg-accent hover:text-accent-foreground",
  );
}

function RailCount({ count }: { count: number | undefined }) {
  if (count === undefined || count <= 0) return null;
  return (
    <span
      aria-hidden
      className="absolute -top-1 -right-1 min-w-4 rounded-full bg-primary px-1 text-center text-3xs leading-4 font-medium text-primary-foreground tabular-nums"
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

function RailTooltip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup side="right">{label}</TooltipPopup>
    </Tooltip>
  );
}

function countLabel(label: string, count: number | undefined) {
  return count !== undefined && count > 0 ? `${label}, ${count} waiting` : label;
}

const FLEET_TOOLTIP_ROWS = 8;

const machineBusy = (machine: FleetMachineSummary) => machine.running + machine.attention > 0;

function machineWork(machine: FleetMachineSummary) {
  const parts = [
    machine.running > 0 ? `${machine.running} running` : null,
    machine.attention > 0 ? `${machine.attention} need you` : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "idle" : parts.join(", ");
}

/**
 * Live glance at everything running on connected machines: the rail shows one total count,
 * and the tooltip names each machine, busy machines first. Subscribes to the fleet summary
 * alone, which keeps its object while counts hold, so streamed thread updates do not repaint
 * the rail.
 */
const FleetRailItem = memo(function FleetRailItem({ active }: { active: boolean }) {
  const summary = useFleetSummary();
  const live = summary.running + summary.attention;
  const ranked = [
    ...summary.machines.filter(machineBusy),
    ...summary.machines.filter((machine) => !machineBusy(machine)),
  ];
  const tooltipRows = ranked.slice(0, FLEET_TOOLTIP_ROWS);
  const label =
    live === 0 ? "Fleet" : `Fleet, ${summary.running} running, ${summary.attention} need you`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            to="/fleet"
            aria-label={label}
            activeOptions={EXACT_MATCH}
            aria-current={active ? "page" : undefined}
            className={railItemClassName(active)}
          >
            <ActivityIcon aria-hidden />
            <RailCount count={live} />
          </Link>
        }
      />
      <TooltipPopup side="right">
        <span className="flex flex-col gap-0.5">
          <span className="font-medium">
            {live === 0
              ? "Fleet: nothing running"
              : `Fleet: ${summary.running} running, ${summary.attention} need you`}
          </span>
          {summary.machines.length > 0
            ? tooltipRows.map((machine) => (
                <span key={machine.environmentId}>
                  {machine.label}: {machineWork(machine)}
                </span>
              ))
            : null}
          {summary.machines.length > FLEET_TOOLTIP_ROWS ? (
            <span>and {summary.machines.length - FLEET_TOOLTIP_ROWS} more</span>
          ) : null}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
});

const BotRailItem = memo(function BotRailItem({ active }: { active: boolean }) {
  const botWaiting = useGoatBotWaitingCount();
  const botReadMenu = useGoatBotReadMenu(botWaiting);
  return (
    <RailTooltip label="GOAT Bot">
      <Link
        to="/bot"
        aria-label={countLabel("GOAT Bot", botWaiting)}
        activeOptions={EXACT_MATCH}
        aria-current={active ? "page" : undefined}
        className={railItemClassName(active)}
        {...botReadMenu}
      >
        <BotIcon aria-hidden />
        <RailCount count={botWaiting} />
      </Link>
    </RailTooltip>
  );
});

const DecisionsRailItem = memo(function DecisionsRailItem({ active }: { active: boolean }) {
  const { count } = useAtomValue(decisionInbox.summaryAtom);
  return (
    <RailTooltip label="Decisions">
      <Link
        to="/decisions"
        aria-label={countLabel("Decisions", count)}
        activeOptions={EXACT_MATCH}
        aria-current={active ? "page" : undefined}
        className={railItemClassName(active)}
      >
        <ListChecksIcon aria-hidden />
        <RailCount count={count} />
      </Link>
    </RailTooltip>
  );
});

// Rail items, Home included, above the divider. It follows position, not particular items, so
// it stays put as people reorder or hide items.
const RAIL_DIVIDER_AFTER = 5;

const ADD_PROVIDER_BUTTON_ID = "destination-rail-add-provider";
const CUSTOMIZE_RAIL_BUTTON_ID = "destination-rail-customize";

const unknownProviderReadyAtom = Atom.make<boolean | null>(null);

interface AddProviderTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

function RailItem(props: { id: RailItemId; active: DestinationId; onAddProvider: () => void }) {
  const isActive = (id: DestinationId) => props.active === id;
  const current = (id: DestinationId) => (isActive(id) ? ("page" as const) : undefined);
  switch (props.id) {
    case "fleet":
      return <FleetRailItem active={isActive("fleet")} />;
    case "bot":
      return <BotRailItem active={isActive("bot")} />;
    case "decisions":
      return <DecisionsRailItem active={isActive("decisions")} />;
    case "usage":
      return (
        <RailTooltip label="Usage">
          <Link
            to="/usage"
            aria-label="Usage"
            activeOptions={EXACT_MATCH}
            aria-current={current("usage")}
            className={railItemClassName(isActive("usage"))}
          >
            <ChartNoAxesColumnIcon aria-hidden />
          </Link>
        </RailTooltip>
      );
    case "pullRequests":
      return (
        <RailTooltip label="Pull requests">
          <Link
            to="/pull-requests"
            search={readPullRequestListPreferences()}
            aria-label="Pull requests"
            activeOptions={EXACT_MATCH}
            aria-current={current("pullRequests")}
            className={railItemClassName(isActive("pullRequests"))}
          >
            <PullRequestGlyph.pullRequest aria-hidden />
          </Link>
        </RailTooltip>
      );
    case "memory":
      return (
        <RailTooltip label="Memory">
          <Link
            to="/settings/memory"
            search={validateMemorySettingsSearch({})}
            aria-label="Memory"
            activeOptions={EXACT_MATCH}
            aria-current={current("memory")}
            className={railItemClassName(isActive("memory"))}
          >
            <BrainIcon aria-hidden />
          </Link>
        </RailTooltip>
      );
    case "scheduled":
      return (
        <RailTooltip label="Scheduled tasks">
          <Link
            to="/settings/scheduled-tasks"
            aria-label="Scheduled tasks"
            activeOptions={EXACT_MATCH}
            aria-current={current("scheduled")}
            className={railItemClassName(isActive("scheduled"))}
          >
            <CalendarClockIcon aria-hidden />
          </Link>
        </RailTooltip>
      );
    case "hub":
      return (
        <RailTooltip label="Hub">
          <Link
            to="/settings/hub"
            aria-label="Hub"
            activeOptions={EXACT_MATCH}
            aria-current={current("hub")}
            className={railItemClassName(isActive("hub"))}
          >
            <ServerIcon aria-hidden />
          </Link>
        </RailTooltip>
      );
    case "notes":
      return (
        <RailTooltip label="Notes">
          <Link
            to="/notes"
            search={{}}
            aria-label="Notes"
            activeOptions={EXACT_MATCH}
            aria-current={current("notes")}
            className={railItemClassName(isActive("notes"))}
          >
            <FileTextIcon aria-hidden />
          </Link>
        </RailTooltip>
      );
    case "addProvider":
      return (
        <RailTooltip label="Add provider">
          <button
            id={ADD_PROVIDER_BUTTON_ID}
            type="button"
            aria-label="Add provider"
            aria-haspopup="dialog"
            className={railItemClassName(false)}
            onClick={props.onAddProvider}
          >
            <PlugIcon aria-hidden />
          </button>
        </RailTooltip>
      );
  }
}

function updateRailPreferences(update: (preferences: RailPreferences) => RailPreferences) {
  void updateClientSettingsWith((current) => ({
    ...current,
    destinationRail: update(current.destinationRail),
  }));
}

/** The "+" menu: every rail item, whether it shows, and its place, including ones unavailable here. */
function RailCustomizeMenu(props: { items: ReadonlyArray<ResolvedRailItem> }) {
  const last = props.items.length - 1;
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <button
                  id={CUSTOMIZE_RAIL_BUTTON_ID}
                  type="button"
                  aria-label="Customize rail"
                  className={railItemClassName(false)}
                />
              }
            >
              <PlusIcon aria-hidden />
            </PopoverTrigger>
          }
        />
        <TooltipPopup side="right">Customize rail</TooltipPopup>
      </Tooltip>
      <PopoverPopup side="right" align="end" padding="compact" width="sm" aria-label="Rail items">
        <div className="flex flex-col gap-0.5 text-sm">
          <div className="px-1 pb-1 text-xs font-medium text-muted-foreground">Show in rail</div>
          <ul className="flex flex-col">
            {props.items.map((item, index) => {
              const meta = RAIL_ITEMS[item.id];
              const Icon = meta.icon;
              const checked =
                item.choice === "default" ? item.defaultShown : item.choice === "shown";
              return (
                <li key={item.id} className="flex min-h-8 items-center gap-2 rounded-md px-1">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 has-disabled:cursor-default">
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(next) =>
                        updateRailPreferences((preferences) =>
                          setRailItemShown(preferences, item.id, next),
                        )
                      }
                    />
                    <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{meta.label}</span>
                      {!item.available && meta.unavailable ? (
                        <span className="text-xs text-muted-foreground">{meta.unavailable}</span>
                      ) : null}
                    </span>
                  </label>
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`Move ${meta.label} up`}
                    disabled={index === 0}
                    onClick={() =>
                      updateRailPreferences((preferences) => moveRailItem(preferences, item.id, -1))
                    }
                  >
                    <ArrowUpIcon />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`Move ${meta.label} down`}
                    disabled={index === last}
                    onClick={() =>
                      updateRailPreferences((preferences) => moveRailItem(preferences, item.id, 1))
                    }
                  >
                    <ArrowDownIcon />
                  </Button>
                </li>
              );
            })}
          </ul>
          <div className="mt-1 border-t border-border pt-1">
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() => updateRailPreferences(() => DEFAULT_RAIL_PREFERENCES)}
            >
              <RotateCcwIcon />
              Reset to defaults
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** The desktop app-wide destination rail beside the thread sidebar. */
export const DestinationRail = memo(function DestinationRail() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const params = useParams({ strict: false });
  const botRef = useGlobalAgentStore((state) => state.botRef);
  // Bot stays selected in thread mode too: /bot redirects to the bot thread either way.
  const isBotRoute = isGoatBotRoute(pathname, resolveThreadRouteTarget(params), botRef);
  const active = resolveActiveDestination(pathname, { isBotRoute });
  const pullRequestsSupported = usePullRequestsSupported();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryEnvironment = useEnvironment(primaryEnvironmentId);
  const canManageProviders = useEnvironmentScope(primaryEnvironmentId, AuthProvidersManageScope);
  const primaryProviderReady = useAtomValue(
    primaryEnvironmentId === null
      ? unknownProviderReadyAtom
      : providerReadyAtom(primaryEnvironmentId),
  );
  const hydration = useClientSettingsHydrationStatus();
  const savedPreferences = useClientSettings((settings) => settings.destinationRail);
  const preferences = railPreferencesForHydration(hydration, savedPreferences);

  const context: RailContext = {
    environmentCount: environments.length,
    pullRequestsSupported,
    memoryAvailable: environments.some((environment) =>
      isMemoryEnvironmentAvailable(environment.serverConfig?.environment.capabilities),
    ),
    hubEnabled: environments.some(
      (environment) => environment.serverConfig?.settings.hub.enabled === true,
    ),
    canAddProvider: primaryEnvironmentId !== null && canManageProviders,
    primaryProviderReady,
  };
  const items = resolveRailItems(preferences ?? DEFAULT_RAIL_PREFERENCES, context);
  const shownItems = items.filter((item) => item.shown);

  // Pinned when opened, and rendered outside the item list, so the wizard survives its rail
  // item hiding once a provider becomes ready mid-setup.
  const [addProviderTarget, setAddProviderTarget] = useState<AddProviderTarget | null>(null);
  const openAddProvider = () => {
    if (primaryEnvironmentId === null) return;
    setAddProviderTarget({
      environmentId: primaryEnvironmentId,
      label: primaryEnvironment?.label ?? "this environment",
    });
  };
  const closeAddProvider = () => {
    setAddProviderTarget(null);
    // The dialog returns focus to its trigger; once that item has hidden, land on the menu.
    if (!document.getElementById(ADD_PROVIDER_BUTTON_ID)) {
      document.getElementById(CUSTOMIZE_RAIL_BUTTON_ID)?.focus();
    }
  };

  return (
    <nav
      aria-label="App"
      className="sticky top-0 z-20 hidden h-svh w-(--destination-rail-width) shrink-0 flex-col items-center bg-background md:flex"
      data-destination-rail=""
    >
      {/* The titlebar strip above the rail belongs to the window frame. */}
      <div
        aria-hidden
        className={cn("h-(--workspace-topbar-height) w-full shrink-0", isElectron && "drag-region")}
      />
      {/* Scrolls on short windows so the bottom controls stay reachable. */}
      <div className="flex min-h-0 w-full flex-1 scrollbar-gutter-both flex-col items-center gap-1 overflow-y-auto pt-2 pb-3">
        <RailTooltip label="Home">
          <Link
            to="/"
            aria-label="Home"
            activeOptions={EXACT_MATCH}
            aria-current={active === "home" ? "page" : undefined}
            className={railItemClassName(active === "home")}
          >
            <HomeIcon aria-hidden />
          </Link>
        </RailTooltip>
        {preferences === null
          ? null
          : shownItems.map((item, index) => (
              <Fragment key={item.id}>
                <RailItem id={item.id} active={active} onAddProvider={openAddProvider} />
                {index === RAIL_DIVIDER_AFTER - 2 && index < shownItems.length - 1 ? (
                  <div aria-hidden className="my-1.5 h-px w-6 shrink-0 bg-border" />
                ) : null}
              </Fragment>
            ))}
        <div className="flex-1" />
        <RailCustomizeMenu items={items} />
        <SidebarUpdatePill placement="rail" />
        <RailTooltip label="Settings">
          <Link
            to="/settings"
            aria-label="Settings"
            activeOptions={EXACT_MATCH}
            aria-current={active === "settings" ? "page" : undefined}
            className={railItemClassName(active === "settings")}
          >
            <SettingsIcon aria-hidden />
          </Link>
        </RailTooltip>
      </div>
      {addProviderTarget ? (
        <Suspense fallback={null}>
          <AddProviderInstanceDialog
            open
            environmentId={addProviderTarget.environmentId}
            environmentLabel={addProviderTarget.label}
            onOpenChange={(open) => {
              if (!open) closeAddProvider();
            }}
          />
        </Suspense>
      ) : null}
    </nav>
  );
});
