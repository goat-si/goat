import type {
  ContextMenuItem,
  EnvironmentId,
  PreviewSessionSnapshot,
  ResolvedKeybindingsConfig,
} from "@goat/contracts";
import { getTerminalLabel } from "@goat/shared/terminalLabels";
import {
  SmartphoneIcon as Smartphone,
  ChevronDownIcon as ChevronDown,
  ChevronLeftIcon as ChevronLeft,
  ChevronRightIcon as ChevronRight,
  FileDiffIcon as FileDiff,
  FilesIcon as Files,
  GlobeIcon as Globe2,
  PlusIcon as Plus,
  TerminalIcon as TerminalSquare,
} from "~/components/solar";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
} from "react";

import { isElectron } from "~/env";
import type { DesktopPreviewOverlay } from "~/previewStateStore";
import type { RightPanelSurface } from "~/rightPanelStore";
import { cn } from "~/lib/utils";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  type ShortcutMatchContext,
} from "~/keybindings";
import { readLocalApi } from "~/localApi";
import { useStableCallback } from "~/hooks/useStableCallback";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { Kbd } from "~/components/ui/kbd";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { useBrowserDefaults } from "~/browser/browserDefaults";
import { ScrollArea } from "~/components/ui/scroll-area";
import { useTheme } from "~/hooks/useTheme";
import type { PreviewPanelInlineSize } from "~/hooks/usePreviewPanelInlineSize";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

import { PreviewPanelShell, type PreviewPanelMode } from "./preview/PreviewPanelShell";
import { previewBridge } from "./preview/previewBridge";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import {
  type PullRequestTabStatusSeed,
  panelTabKeyAction,
  previewFaviconOf,
  RightPanelTab,
  SortableTabList,
  type TabAudioState,
} from "./RightPanelTab";
import { observeResize } from "~/lib/observeResize";

export interface RightPanelTabsProps {
  mode: PreviewPanelMode;
  maximized?: boolean;
  open?: boolean;
  keybindings: ResolvedKeybindingsConfig;
  getShortcutContext: () => ShortcutMatchContext;
  widthStorageKey?: string;
  defaultWidth?: number;
  inlineSize?: PreviewPanelInlineSize;
  layoutControls?: ReactNode;
  surfaces: readonly RightPanelSurface[];
  environmentId: EnvironmentId | null;
  activeSurfaceId: string | null;
  pendingSurfaceIds: ReadonlySet<string>;
  previewSessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  desktopByTabId: Readonly<Record<string, DesktopPreviewOverlay>>;
  /**
   * Maps a server session tab id to the desktop runtime tab id the Electron
   * preview manager is keyed by. Session ids are only unique within one server
   * process, so desktop operations must not be addressed with them.
   */
  previewRuntimeTabId?: ((tabId: string) => string) | undefined;
  terminalLabelsById: ReadonlyMap<string, string>;
  onActivate: (surface: RightPanelSurface) => void;
  onRenameDevice?: (surfaceId: string, title: string) => void;
  onCloseSurface: (surface: RightPanelSurface) => void;
  onCloseOtherSurfaces: (surface: RightPanelSurface) => void;
  onCloseSurfacesToRight: (surface: RightPanelSurface) => void;
  onCloseAllSurfaces: () => void;
  onMoveSurface?: (surfaceId: string, toIndex: number) => void;
  onCopyFilePath: (relativePath: string) => void;
  onAddBrowser: () => void;
  /**
   * Separate from `onAddBrowser` on purpose: that one is passed directly as a
   * DOM click handler, and a `(profileId?: string)` signature would silently
   * accept the MouseEvent as a profile id.
   */
  onAddBrowserInProfile: (profileId: string) => void;
  onAddTerminal: () => void;
  onAddDiff: () => void;
  onAddFiles: () => void;
  onAddPullRequest: () => void;
  onAddPullRequests: () => void;
  onAddDevice: () => void;
  browserAvailable: boolean;
  terminalAvailable: boolean;
  diffAvailable: boolean;
  filesAvailable: boolean;
  pullRequestAvailable: boolean;
  pullRequestsAvailable: boolean;
  deviceAvailable: boolean;
  pullRequestStatusSeeds?: Readonly<Record<string, PullRequestTabStatusSeed>>;
  children: ReactNode;
}

function shouldOpenDefaultBrowserProfileFromMenuClick(pointerType: string | undefined): boolean {
  return pointerType !== "touch";
}

const SURFACE_DISABLED_REASONS = {
  browser: "Browser previews are only available in the GOAT desktop app.",
  terminal: "Terminal surfaces are only available from a project thread.",
  files: "Files are only available when a project is open.",
  diff: "Diff is only available for server threads in Git repositories.",
  pullRequest: "This thread's branch has no pull request yet.",
  pullRequests: "No linked pull requests are available for this thread.",
  device: "Devices are only available from a thread.",
} as const;

// Closed keepMounted popups must stop blocking shortcuts once their exit transition ends.
const LAUNCHER_SHORTCUT_BLOCKING_LAYERS = [
  "dialog-popup",
  "alert-dialog-popup",
  "command-dialog-popup",
  "menu-popup",
  "select-popup",
  "popover-popup",
  "combobox-popup",
  "autocomplete-popup",
]
  .map((slot) => `[data-slot="${slot}"]:is([data-open],[data-ending-style])`)
  .join(",");

const SURFACE_UNAVAILABLE_HINTS = {
  browser: "Only available in the desktop app.",
  terminal: "Available when a project is open.",
  files: "Available when a project is open.",
  diff: "Available for Git repositories.",
  pullRequest: "No pull request on this branch yet.",
  pullRequests: "No linked pull requests available.",
  device: "Available from a thread.",
} as const;

type TabContextMenuAction =
  | "rename"
  | "copy-path"
  | "toggle-mute"
  | "close"
  | "close-others"
  | "close-to-right"
  | "close-all";

const TAB_SCROLL_EDGE_TOLERANCE = 1;

function tabScrollViewport(root: HTMLDivElement | null): HTMLDivElement | null {
  return root?.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]') ?? null;
}

function previewTabIdOf(
  surface: RightPanelSurface,
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>,
): string | null {
  if (surface.kind !== "preview" || !surface.resourceId) return null;
  return sessions[surface.resourceId]?.tabId ?? null;
}

/**
 * Stays disabled until desktop overlay state arrives: a server session id can
 * resolve while the preview manager's createTab is still in flight, and muting
 * then fails with a PreviewTabNotFoundError nothing surfaces to the user.
 */
function tabMuteMenuItem(input: {
  overlay: DesktopPreviewOverlay | null;
  canResolveRuntimeTabId: boolean;
}): { label: string; disabled: boolean } {
  const muted = input.overlay?.audioMuted ?? false;
  return {
    label: muted ? "Unmute tab" : "Mute tab",
    disabled: input.overlay === null || !input.canResolveRuntimeTabId,
  };
}

function tabAudioState(overlay: DesktopPreviewOverlay | null): TabAudioState {
  if (!overlay?.audible) return "none";
  return overlay.audioMuted ? "muted" : "audible";
}

type SurfaceShortcutEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "defaultPrevented" | "isComposing" | "key" | "metaKey"
>;

export function surfaceShortcutActionForKey<
  const Action extends { available: boolean; shortcut: string },
>(actions: readonly Action[], event: SurfaceShortcutEvent): Action | null {
  if (event.defaultPrevented || event.isComposing) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  return (
    actions.find(
      (action) => action.available && action.shortcut.toLowerCase() === event.key.toLowerCase(),
    ) ?? null
  );
}

/**
 * The `:not` clause lets `closest` see past non-editable islands
 * (`contenteditable="false"`) to an editable host around them, matching
 * ComposerPendingUserInputPanel's typing guard.
 */
export function surfaceShortcutTargetsTypingContext(
  target: { closest(selectors: string): unknown } | null,
): boolean {
  return (
    target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !=
    null
  );
}

function DisabledReasonTooltip(props: { reason: string; trigger: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.trigger} />
      <TooltipPopup side="top">{props.reason}</TooltipPopup>
    </Tooltip>
  );
}

function SurfaceMenuItem(props: {
  available: boolean;
  disabledReason?: string;
  shortcut: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const item = (
    <MenuItem
      className={!props.available ? "data-disabled:pointer-events-auto" : undefined}
      onClick={props.onClick}
      disabled={!props.available}
      aria-keyshortcuts={props.shortcut}
    >
      {props.children}
      <MenuShortcut>{props.shortcut}</MenuShortcut>
    </MenuItem>
  );
  if (props.available || !props.disabledReason) return item;
  return <DisabledReasonTooltip reason={props.disabledReason} trigger={item} />;
}

function RightPanelEmptyState(props: {
  onAddBrowser: () => void;
  onAddBrowserInProfile: (profileId: string) => void;
  browserProfiles: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  onAddTerminal: () => void;
  onAddDiff: () => void;
  onAddFiles: () => void;
  onAddPullRequest: () => void;
  onAddPullRequests: () => void;
  onAddDevice: () => void;
  browserAvailable: boolean;
  terminalAvailable: boolean;
  diffAvailable: boolean;
  filesAvailable: boolean;
  pullRequestAvailable: boolean;
  pullRequestsAvailable: boolean;
  deviceAvailable: boolean;
}) {
  const [highlight, setHighlight] = useState(-1);

  const actions = [
    {
      label: "Browser",
      icon: Globe2,
      shortcut: "B",
      available: props.browserAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.browser,
      onClick: props.onAddBrowser,
    },
    {
      label: "Terminal",
      icon: TerminalSquare,
      shortcut: "T",
      available: props.terminalAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.terminal,
      onClick: props.onAddTerminal,
    },
    {
      label: "Files",
      icon: Files,
      shortcut: "F",
      available: props.filesAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.files,
      onClick: props.onAddFiles,
    },
    {
      label: "Diff",
      icon: FileDiff,
      shortcut: "D",
      available: props.diffAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.diff,
      onClick: props.onAddDiff,
    },
    {
      label: "Pull request",
      icon: PullRequestGlyph.pullRequest,
      shortcut: "P",
      available: props.pullRequestAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.pullRequest,
      onClick: props.onAddPullRequest,
    },
    {
      label: "Linked pull requests",
      icon: PullRequestGlyph.link,
      shortcut: "L",
      available: props.pullRequestsAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.pullRequests,
      onClick: props.onAddPullRequests,
    },
    {
      label: "Device",
      description: "Watch an iOS Simulator or Android Emulator.",
      icon: Smartphone,
      shortcut: "M",
      available: props.deviceAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.device,
      onClick: props.onAddDevice,
    },
  ] as const;

  type SurfaceAction = (typeof actions)[number];

  const availableActions = actions.filter((action) => action.available);
  const highlightIndex =
    availableActions.length === 0 ? -1 : Math.min(highlight, availableActions.length - 1);

  const handleShortcut = useEffectEvent((event: KeyboardEvent) => {
    const action = surfaceShortcutActionForKey(availableActions, event);
    if (!action) return;
    if (document.querySelector(LAUNCHER_SHORTCUT_BLOCKING_LAYERS)) return;
    const target = event.composedPath()[0] ?? event.target;
    if (target instanceof Element && surfaceShortcutTargetsTypingContext(target)) return;
    event.preventDefault();
    event.stopPropagation();
    action.onClick();
  });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => handleShortcut(event);
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (availableActions.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      setHighlight((highlightIndex + 1) % availableActions.length);
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      setHighlight(
        highlightIndex === -1
          ? availableActions.length - 1
          : (highlightIndex - 1 + availableActions.length) % availableActions.length,
      );
      return;
    }
    if (event.key === "Enter") {
      if (event.target !== event.currentTarget) return;
      const action = availableActions[highlightIndex];
      if (!action) return;
      event.preventDefault();
      action.onClick();
    }
  };

  const isHighlighted = (action: SurfaceAction) =>
    highlightIndex !== -1 && availableActions[highlightIndex] === action;

  const actionIcon = (action: SurfaceAction, iconClassName = "size-4") => {
    const Icon = action.icon;
    return (
      <span className="relative inline-flex shrink-0">
        <Icon className={iconClassName} />
      </span>
    );
  };

  return (
    <div
      ref={focusOnMount}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      aria-label="Open a surface"
      data-surface-launcher-keys={availableActions.map((action) => action.shortcut).join("")}
      className={cn(
        "scrollbar-gutter-both flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 outline-none",
        "pb-(--workspace-topbar-height)",
      )}
    >
      <div className="w-full max-w-xs py-6">
        <h3 className="mb-3 text-center font-medium text-foreground text-sm">Open a surface</h3>
        <div className="flex flex-col gap-0.5">
          {actions.map((action) =>
            action.available ? (
              <div
                key={action.label}
                className="group relative"
                onMouseEnter={() => setHighlight(availableActions.indexOf(action))}
                onMouseLeave={() =>
                  setHighlight((current) =>
                    current === availableActions.indexOf(action) ? -1 : current,
                  )
                }
              >
                <button
                  type="button"
                  onClick={action.onClick}
                  className={cn(
                    "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) px-2.5 text-left text-sm transition-colors group-hover:bg-accent/60",
                    isHighlighted(action) && "bg-accent/60",
                  )}
                >
                  {actionIcon(action, "size-4")}
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate",
                      action.label === "Browser" && props.browserProfiles.length > 1 && "pr-7",
                    )}
                  >
                    {action.label}
                  </span>
                  <Kbd>{action.shortcut}</Kbd>
                </button>
                {action.label === "Browser" && props.browserProfiles.length > 1 ? (
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          aria-label="Open browser in a profile"
                          className="absolute top-1/2 right-8 -translate-y-1/2"
                          size="icon-xs"
                          variant="ghost-muted"
                        />
                      }
                    >
                      <ChevronDown className="size-3.5" />
                    </MenuTrigger>
                    <MenuPopup align="end" side="bottom" sideOffset={6} className="max-w-56">
                      {props.browserProfiles.map((profile) => (
                        <MenuItem
                          key={profile.id}
                          onClick={() => props.onAddBrowserInProfile(profile.id)}
                        >
                          <span className="min-w-0 truncate">{profile.name}</span>
                        </MenuItem>
                      ))}
                    </MenuPopup>
                  </Menu>
                ) : null}
              </div>
            ) : (
              <DisabledReasonTooltip
                key={action.label}
                reason={action.disabledReason}
                trigger={
                  <div
                    tabIndex={0}
                    aria-disabled="true"
                    className="flex h-8 w-full cursor-default items-center gap-2.5 rounded-(--control-radius) px-2.5 text-left text-sm opacity-50"
                  >
                    {actionIcon(action, "size-4")}
                    <span className="min-w-0 flex-1 truncate">{action.label}</span>
                    <Kbd>{action.shortcut}</Kbd>
                  </div>
                }
              />
            ),
          )}
        </div>
      </div>
    </div>
  );
}

function surfaceTitle(
  surface: RightPanelSurface,
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>,
  terminalLabelsById: ReadonlyMap<string, string>,
): string {
  switch (surface.kind) {
    case "diff":
      return "Diff";
    case "files":
      return "Files";
    case "file":
      return surface.relativePath.slice(
        Math.max(surface.relativePath.lastIndexOf("/"), surface.relativePath.lastIndexOf("\\")) + 1,
      );
    case "terminal":
      return (
        terminalLabelsById.get(surface.activeTerminalId) ??
        getTerminalLabel(surface.activeTerminalId)
      );
    case "pull-request":
      return `#${surface.number}`;
    case "pull-requests":
      return "Pull requests";
    case "side-chat":
      return "Side chat";
    case "device":
      return surface.title ?? surface.target?.name ?? "Device";
    case "preview": {
      const snapshot = surface.resourceId ? sessions[surface.resourceId] : null;
      if (!snapshot || snapshot.navStatus._tag === "Idle") return "Browser";
      if (snapshot.navStatus.title.trim().length > 0) return snapshot.navStatus.title;
      try {
        return new URL(snapshot.navStatus.url).host || "Browser";
      } catch {
        return "Browser";
      }
    }
  }
}

// Module-level so React only runs this callback ref on mount and unmount;
// a fresh function would re-attach and re-focus on every render.
function focusOnMount(node: HTMLDivElement | null) {
  node?.focus();
}

export function RightPanelTabs(props: RightPanelTabsProps) {
  const ownsDesktopTitleBar = isElectron && props.mode === "inline";
  const browserProfiles = useBrowserDefaults().profiles;
  const { resolvedTheme } = useTheme();
  const tabListRef = useRef<HTMLDivElement>(null);
  const addSurfaceTriggerRef = useRef<HTMLButtonElement>(null);
  const [renamingDevice, setRenamingDevice] = useState<string | null>(null);
  const [addSurfaceMenuOpen, setAddSurfaceMenuOpen] = useState(false);
  const [tabScrollState, setTabScrollState] = useState({
    hasOverflow: false,
    canScrollLeft: false,
    canScrollRight: false,
  });

  if (props.open === false && addSurfaceMenuOpen) setAddSurfaceMenuOpen(false);

  const onNewSurfaceKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return;
    if (
      resolveShortcutCommand(event, props.keybindings, {
        context: { ...props.getShortcutContext(), rightPanelOpen: true },
      }) !== "rightPanel.new"
    )
      return;
    if (!addSurfaceMenuOpen && document.querySelector(LAUNCHER_SHORTCUT_BLOCKING_LAYERS)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) {
      addSurfaceTriggerRef.current?.focus();
      setAddSurfaceMenuOpen(true);
    }
  });
  useEffect(() => {
    if (props.open === false) return;
    document.addEventListener("keydown", onNewSurfaceKeyDown, true);
    return () => document.removeEventListener("keydown", onNewSurfaceKeyDown, true);
  }, [props.open]);

  const updateTabScrollState = () => {
    const viewport = tabScrollViewport(tabListRef.current);
    if (!viewport) return;

    const hasOverflow = viewport.scrollWidth - viewport.clientWidth > TAB_SCROLL_EDGE_TOLERANCE;
    const canScrollLeft = hasOverflow && viewport.scrollLeft > TAB_SCROLL_EDGE_TOLERANCE;
    const canScrollRight =
      hasOverflow &&
      viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - TAB_SCROLL_EDGE_TOLERANCE;
    setTabScrollState((current) => {
      if (
        current.hasOverflow === hasOverflow &&
        current.canScrollLeft === canScrollLeft &&
        current.canScrollRight === canScrollRight
      ) {
        return current;
      }
      return { hasOverflow, canScrollLeft, canScrollRight };
    });
  };

  const scrollTabs = (direction: -1 | 1) => {
    const viewport = tabScrollViewport(tabListRef.current);
    if (!viewport) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    viewport.scrollBy({
      left: direction * Math.max(120, viewport.clientWidth * 0.75),
      behavior: reduceMotion ? "auto" : "smooth",
    });
  };

  const addSurfaceActions = [
    {
      label: "Browser",
      icon: Globe2,
      shortcut: "B",
      available: props.browserAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.browser,
      onClick: props.onAddBrowser,
    },
    {
      label: "Terminal",
      icon: TerminalSquare,
      shortcut: "T",
      available: props.terminalAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.terminal,
      onClick: props.onAddTerminal,
    },
    {
      label: "Files",
      icon: Files,
      shortcut: "F",
      available: props.filesAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.files,
      onClick: props.onAddFiles,
    },
    {
      label: "Diff",
      icon: FileDiff,
      shortcut: "D",
      available: props.diffAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.diff,
      onClick: props.onAddDiff,
    },
    {
      label: "Pull request",
      icon: PullRequestGlyph.pullRequest,
      shortcut: "P",
      available: props.pullRequestAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.pullRequest,
      onClick: props.onAddPullRequest,
    },
    {
      label: "Linked pull requests",
      icon: PullRequestGlyph.link,
      shortcut: "L",
      available: props.pullRequestsAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.pullRequests,
      onClick: props.onAddPullRequests,
    },
    {
      label: "Device",
      icon: Smartphone,
      shortcut: "M",
      available: props.deviceAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.device,
      onClick: props.onAddDevice,
    },
  ] as const;

  const handleAddSurfaceMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const action = surfaceShortcutActionForKey(addSurfaceActions, event.nativeEvent);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    setAddSurfaceMenuOpen(false);
    action.onClick();
  };

  const handleTabContextMenu = async (event: ReactMouseEvent, surface: RightPanelSurface) => {
    event.preventDefault();
    event.stopPropagation();

    const api = readLocalApi();
    if (!api) return;

    const surfaceIndex = props.surfaces.findIndex((entry) => entry.id === surface.id);
    if (surfaceIndex < 0) return;

    const items: ContextMenuItem<TabContextMenuAction>[] = [];
    if (surface.kind === "device" && props.onRenameDevice)
      items.push({ id: "rename", label: "Rename" });
    if (surface.kind === "file" && surface.attachment === undefined) {
      items.push({ id: "copy-path", label: "Copy path" });
    }
    const menuPreviewTabId = previewTabIdOf(surface, props.previewSessions);
    const menuOverlay = menuPreviewTabId ? (props.desktopByTabId[menuPreviewTabId] ?? null) : null;
    const menuMuted = menuOverlay?.audioMuted ?? false;
    if (surface.kind === "preview") {
      items.push({
        id: "toggle-mute",
        ...tabMuteMenuItem({
          overlay: menuOverlay,
          canResolveRuntimeTabId: props.previewRuntimeTabId !== undefined,
        }),
      });
    }
    items.push(
      { id: "close", label: "Close" },
      {
        id: "close-others",
        label: "Close others",
        disabled: props.surfaces.length <= 1,
      },
      {
        id: "close-to-right",
        label: "Close to the right",
        disabled: surfaceIndex >= props.surfaces.length - 1,
      },
      {
        id: "close-all",
        label: "Close all",
        disabled: props.surfaces.length === 0,
      },
    );

    const action = await api.contextMenu.show(items, { x: event.clientX, y: event.clientY });
    switch (action) {
      case "rename":
        setRenamingDevice(surface.id);
        break;
      case "copy-path":
        if (surface.kind === "file" && surface.attachment === undefined) {
          props.onCopyFilePath(surface.relativePath);
        }
        break;
      case "toggle-mute": {
        const runtimeTabId =
          menuPreviewTabId && menuOverlay
            ? (props.previewRuntimeTabId?.(menuPreviewTabId) ?? null)
            : null;
        if (runtimeTabId) {
          void previewBridge?.setAudioMuted(runtimeTabId, !menuMuted).catch(() => undefined);
        }
        break;
      }
      case "close":
        props.onCloseSurface(surface);
        break;
      case "close-others":
        props.onCloseOtherSurfaces(surface);
        break;
      case "close-to-right":
        props.onCloseSurfacesToRight(surface);
        break;
      case "close-all":
        props.onCloseAllSurfaces();
        break;
      case null:
        break;
    }
  };
  const handleTabAuxClick = (event: ReactMouseEvent, surface: RightPanelSurface) => {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    props.onCloseSurface(surface);
  };
  // Every tab receives these. Parents pass fresh closures on each render, so
  // stable forwarders keep a tab's props equal unless its own surface changed.
  const tabIdPrefix = useId();
  const panelId = `${tabIdPrefix}-panel`;
  const tabIdOf = (surfaceId: string) => `${tabIdPrefix}-tab-${surfaceId}`;
  const newSurfaceShortcut = shortcutLabelForCommand(props.keybindings, "rightPanel.new");
  const handleTabListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const tabs = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
    const index = tabs.findIndex((tab) => tab === event.target);
    const surface = props.surfaces[index];
    if (surface === undefined) return;
    const action = panelTabKeyAction(event.key, index, tabs.length);
    if (action === null) return;
    event.preventDefault();
    switch (action.type) {
      case "focus":
        tabs[action.index]?.focus();
        tabs[action.index]?.scrollIntoView({ block: "nearest", inline: "nearest" });
        break;
      case "activate":
        props.onActivate(surface);
        break;
      case "close":
        // Keep focus in the tab list instead of dropping it on the page.
        (tabs[index + 1] ?? tabs[index - 1])?.focus();
        props.onCloseSurface(surface);
        break;
    }
  };
  const onActivateTab = useStableCallback(props.onActivate);
  const onCloseTab = useStableCallback(props.onCloseSurface);
  const onTabAuxClick = useStableCallback(handleTabAuxClick);
  const onTabContextMenu = useStableCallback(
    (event: ReactMouseEvent, surface: RightPanelSurface) => {
      void handleTabContextMenu(event, surface);
    },
  );
  const onStartRenameTab = useStableCallback((surfaceId: string) => setRenamingDevice(surfaceId));
  const onFinishRenameTab = useStableCallback((surfaceId: string, title: string) => {
    props.onRenameDevice?.(surfaceId, title);
    setRenamingDevice(null);
  });

  useEffect(() => {
    if (!props.activeSurfaceId || !tabScrollState.hasOverflow) return;
    const activeTab = tabListRef.current?.querySelector<HTMLElement>("[data-active-tab='true']");
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [props.activeSurfaceId, tabScrollState.hasOverflow]);

  useEffect(() => {
    const viewport = tabScrollViewport(tabListRef.current);
    if (!viewport) return;

    const content = viewport.firstElementChild;
    const stopObserving = observeResize(
      content ? [viewport, content] : viewport,
      updateTabScrollState,
    );
    viewport.addEventListener("scroll", updateTabScrollState, { passive: true });
    updateTabScrollState();

    return () => {
      stopObserving();
      viewport.removeEventListener("scroll", updateTabScrollState);
    };
  }, [updateTabScrollState]);

  useEffect(() => {
    const viewport = tabScrollViewport(tabListRef.current);
    if (!viewport) return;

    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      let delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
      if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= viewport.clientWidth;
      if (delta === 0) return;

      const previousScrollLeft = viewport.scrollLeft;
      viewport.scrollLeft += delta;
      if (viewport.scrollLeft === previousScrollLeft) return;
      event.preventDefault();
      updateTabScrollState();
    };

    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, [updateTabScrollState]);

  return (
    <PreviewPanelShell
      mode={props.mode}
      {...(props.maximized !== undefined ? { maximized: props.maximized } : {})}
      {...(props.open !== undefined ? { open: props.open } : {})}
      {...(props.widthStorageKey !== undefined ? { widthStorageKey: props.widthStorageKey } : {})}
      {...(props.defaultWidth !== undefined ? { defaultWidth: props.defaultWidth } : {})}
      {...(props.inlineSize ? { inlineSize: props.inlineSize } : {})}
    >
      <div
        className={cn(
          "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1 pl-2",
          props.mode === "inline" && !props.layoutControls ? "pr-28" : "pr-3",
          ownsDesktopTitleBar && "drag-region",
          ownsDesktopTitleBar && "wco:pr-(--workspace-native-controls-inset)",
          props.mode === "inline" && props.maximized && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
        data-right-panel-tabbar
      >
        <ScrollArea
          radius="none"
          ref={tabListRef}
          hideScrollbars
          scrollFade
          className="min-w-0 flex-1"
          data-right-panel-tab-list
        >
          <div className="flex h-full w-max min-w-full items-center gap-1">
            <div
              role="tablist"
              aria-label="Panel tabs"
              aria-orientation="horizontal"
              className="flex items-center gap-1"
              onKeyDown={handleTabListKeyDown}
            >
              <SortableTabList surfaces={props.surfaces} onMove={props.onMoveSurface}>
                {props.surfaces.map((surface) => {
                  const previewTabId = previewTabIdOf(surface, props.previewSessions);
                  const favicon = previewFaviconOf(
                    surface,
                    props.previewSessions,
                    props.desktopByTabId,
                  );
                  return (
                    <RightPanelTab
                      key={surface.id}
                      surface={surface}
                      dragDisabled={!props.onMoveSurface || renamingDevice === surface.id}
                      active={surface.id === props.activeSurfaceId}
                      pending={props.pendingSurfaceIds.has(surface.id)}
                      title={surfaceTitle(surface, props.previewSessions, props.terminalLabelsById)}
                      audio={tabAudioState(
                        previewTabId ? (props.desktopByTabId[previewTabId] ?? null) : null,
                      )}
                      audioRuntimeTabId={
                        previewTabId ? (props.previewRuntimeTabId?.(previewTabId) ?? null) : null
                      }
                      previewUrl={favicon.url}
                      previewCapturedUrl={favicon.capturedUrl}
                      theme={resolvedTheme}
                      environmentId={props.environmentId}
                      pullRequestStatusSeed={props.pullRequestStatusSeeds?.[surface.id]}
                      renaming={renamingDevice === surface.id}
                      canRename={props.onRenameDevice !== undefined}
                      ownsDesktopTitleBar={ownsDesktopTitleBar}
                      tabId={tabIdOf(surface.id)}
                      panelId={panelId}
                      onActivate={onActivateTab}
                      onClose={onCloseTab}
                      onAuxClick={onTabAuxClick}
                      onContextMenu={onTabContextMenu}
                      onStartRename={onStartRenameTab}
                      onFinishRename={onFinishRenameTab}
                    />
                  );
                })}
              </SortableTabList>
            </div>
            {props.open !== false ? (
              <Menu open={addSurfaceMenuOpen} onOpenChange={setAddSurfaceMenuOpen}>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <MenuTrigger
                        ref={addSurfaceTriggerRef}
                        render={
                          <Button
                            aria-label="Add panel surface"
                            aria-keyshortcuts={newSurfaceShortcut ?? undefined}
                            className="shrink-0"
                            size="icon"
                            variant="ghost-muted"
                          />
                        }
                      />
                    }
                  >
                    <Plus className="size-4" />
                  </TooltipTrigger>
                  <TooltipPopup side="bottom">
                    Open a surface
                    {newSurfaceShortcut ? <Kbd className="ms-2">{newSurfaceShortcut}</Kbd> : null}
                  </TooltipPopup>
                </Tooltip>
                <MenuPopup
                  align="start"
                  side="bottom"
                  sideOffset={6}
                  onKeyDownCapture={handleAddSurfaceMenuKeyDown}
                >
                  {addSurfaceActions.map((action) => {
                    const Icon = action.icon;
                    if (action.label === "Browser" && action.available) {
                      return (
                        <MenuSub key={action.label}>
                          <MenuSubTrigger
                            className="[&>svg:last-child]:ms-0"
                            aria-keyshortcuts={action.shortcut}
                            onClick={(event) => {
                              const pointerType =
                                "pointerType" in event.nativeEvent &&
                                typeof event.nativeEvent.pointerType === "string"
                                  ? event.nativeEvent.pointerType
                                  : undefined;
                              if (!shouldOpenDefaultBrowserProfileFromMenuClick(pointerType))
                                return;
                              setAddSurfaceMenuOpen(false);
                              action.onClick();
                            }}
                          >
                            <Icon />
                            {action.label}
                            <MenuShortcut>{action.shortcut}</MenuShortcut>
                          </MenuSubTrigger>
                          <MenuSubPopup className="max-w-56">
                            {browserProfiles.map((profile) => (
                              <MenuItem
                                key={profile.id}
                                onClick={() => props.onAddBrowserInProfile(profile.id)}
                              >
                                <span className="min-w-0 truncate">{profile.name}</span>
                              </MenuItem>
                            ))}
                          </MenuSubPopup>
                        </MenuSub>
                      );
                    }
                    return (
                      <SurfaceMenuItem
                        key={action.label}
                        available={action.available}
                        disabledReason={action.disabledReason}
                        shortcut={action.shortcut}
                        onClick={action.onClick}
                      >
                        <Icon />
                        {action.label}
                      </SurfaceMenuItem>
                    );
                  })}
                </MenuPopup>
              </Menu>
            ) : null}
          </div>
        </ScrollArea>
        {tabScrollState.hasOverflow ? (
          <div
            className="flex shrink-0 items-center gap-0.5 [-webkit-app-region:no-drag]"
            role="group"
            aria-label="Scroll panel tabs"
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex">
                    <Button
                      aria-label="Scroll tabs left"
                      disabled={!tabScrollState.canScrollLeft}
                      onClick={() => scrollTabs(-1)}
                      size="icon-xs"
                      variant="ghost"
                    >
                      <ChevronLeft />
                    </Button>
                  </span>
                }
              />
              <TooltipPopup>Scroll tabs left</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex">
                    <Button
                      aria-label="Scroll tabs right"
                      disabled={!tabScrollState.canScrollRight}
                      onClick={() => scrollTabs(1)}
                      size="icon-xs"
                      variant="ghost"
                    >
                      <ChevronRight />
                    </Button>
                  </span>
                }
              />
              <TooltipPopup>Scroll tabs right</TooltipPopup>
            </Tooltip>
          </div>
        ) : null}
        {props.layoutControls}
        {ownsDesktopTitleBar && !props.layoutControls ? (
          <span aria-hidden className="hidden w-24 shrink-0 wco:block" />
        ) : null}
        {ownsDesktopTitleBar ? (
          <span
            aria-hidden
            className="pointer-events-none fixed top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] h-[var(--workspace-topbar-height)] w-28 [-webkit-app-region:no-drag]"
          />
        ) : null}
      </div>
      <div
        className="flex min-h-0 flex-1 flex-col"
        data-right-panel-surface-content
        {...(props.activeSurfaceId === null
          ? {}
          : { role: "tabpanel", id: panelId, "aria-labelledby": tabIdOf(props.activeSurfaceId) })}
      >
        {props.activeSurfaceId === null ? (
          <RightPanelEmptyState
            onAddBrowser={props.onAddBrowser}
            onAddBrowserInProfile={props.onAddBrowserInProfile}
            browserProfiles={browserProfiles}
            onAddTerminal={props.onAddTerminal}
            onAddDiff={props.onAddDiff}
            onAddFiles={props.onAddFiles}
            onAddPullRequest={props.onAddPullRequest}
            onAddPullRequests={props.onAddPullRequests}
            onAddDevice={props.onAddDevice}
            browserAvailable={props.browserAvailable}
            terminalAvailable={props.terminalAvailable}
            diffAvailable={props.diffAvailable}
            filesAvailable={props.filesAvailable}
            pullRequestAvailable={props.pullRequestAvailable}
            pullRequestsAvailable={props.pullRequestsAvailable}
            deviceAvailable={props.deviceAvailable}
          />
        ) : (
          props.children
        )}
      </div>
    </PreviewPanelShell>
  );
}
