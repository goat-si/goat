import type { SourceControlProviderKind } from "@goat/contracts";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import { useProjects, useServerConfigs, useThreadShells } from "~/state/entities";
import { visibleThreadPullRequests } from "@goat/shared/threadPullRequests";
import { threadPullRequestKeysEqual } from "@goat/client-runtime/thread-pull-requests";
import type {
  EnvironmentId,
  PreviewSessionSnapshot,
  ProjectId,
  PullRequestState,
} from "@goat/contracts";
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { horizontalListSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  SmartphoneIcon as Smartphone,
  FileDiffIcon as FileDiff,
  FilesIcon as Files,
  GlobeIcon as Globe2,
  MessagesSquareIcon,
  TerminalIcon as TerminalSquare,
} from "~/components/solar";
import { Volume as Volume2, VolumeOff } from "~/components/solar/nodes";
import { type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

import type { DesktopPreviewOverlay } from "~/previewStateStore";
import type { RightPanelSurface } from "~/rightPanelStore";
import { cn } from "~/lib/utils";
import { MorphIcon } from "~/components/MorphIcon";
import { AndroidIcon, AppleIcon } from "~/components/Icons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { PanelTabCloseButton } from "~/components/ui/panel-tab-close-button";
import { faviconUrlForOrigin } from "~/lib/favicon";
import { useDeviceState } from "~/state/device";
import {
  newestPullRequestSummary,
  pullRequestEnvironment,
  useSharedPullRequestSummary,
} from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";

import { FaviconImage } from "./preview/PreviewFaviconIcon";
import { previewBridge } from "./preview/previewBridge";
import { PierreEntryIcon } from "./chat/PierreEntryIcon";
import { resolvePullRequestState } from "./pullRequest/pullRequestPresentation";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";


/** Forgejo serves pull requests on its web host; other forges key the host from the repository. */
function pullRequestHostOf(
  identity: {
    readonly canonicalKey?: string | undefined;
    readonly locator?: { readonly remoteUrl: string } | undefined;
  },
  kind: SourceControlProviderKind,
): string {
  if (kind === "forgejo") {
    try {
      const remote = new URL(identity.locator?.remoteUrl ?? "");
      if (remote.protocol === "http:" || remote.protocol === "https:") {
        return remote.host.toLowerCase();
      }
    } catch {
      // SSH remotes do not name the web host.
    }
  }
  const host = identity.canonicalKey?.split("/")[0]?.trim();
  return host === undefined || host.length === 0 ? kind : host.toLowerCase();
}

export interface PullRequestTabStatus {
  projectId: string;
  repository: string;
  number: number;
  state: PullRequestState;
  isDraft: boolean;
}

export type PullRequestTabStatusSeed = Pick<PullRequestTabStatus, "state" | "isDraft">;

const TAB_DRAG_MODIFIERS = [restrictToHorizontalAxis, restrictToFirstScrollableAncestor];

export type TabAudioState = "none" | "audible" | "muted";

function PreviewFavicon({ capturedUrl, url }: { capturedUrl: string | null; url: string | null }) {
  const publicProviderUrl = faviconUrlForOrigin(url, 32);
  return (
    <FaviconImage
      sources={[capturedUrl, publicProviderUrl]}
      fallback={<Globe2 className="size-3 shrink-0" />}
      className="size-3 shrink-0 rounded-sm object-contain"
    />
  );
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

export function previewFaviconOf(
  surface: RightPanelSurface,
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>,
  desktopByTabId: Readonly<Record<string, DesktopPreviewOverlay>>,
): { url: string | null; capturedUrl: string | null } {
  const snapshot =
    surface.kind === "preview" && surface.resourceId ? sessions[surface.resourceId] : null;
  const url = !snapshot || snapshot.navStatus._tag === "Idle" ? null : snapshot.navStatus.url;
  const favicon = snapshot ? (desktopByTabId[snapshot.tabId]?.favicon ?? null) : null;
  const capturedUrl = favicon && url && sameOrigin(favicon.pageUrl, url) ? favicon.dataUrl : null;
  return { url, capturedUrl };
}

function SurfaceIcon({
  surface,
  previewUrl,
  previewCapturedUrl,
  theme,
  environmentId,
  pullRequestStatusSeed,
}: {
  surface: RightPanelSurface;
  previewUrl: string | null;
  previewCapturedUrl: string | null;
  theme: "light" | "dark";
  environmentId: EnvironmentId | null;
  pullRequestStatusSeed: PullRequestTabStatusSeed | undefined;
}) {
  switch (surface.kind) {
    case "preview":
      return <PreviewFavicon capturedUrl={previewCapturedUrl} url={previewUrl} />;
    case "diff":
      return <FileDiff className="size-3 shrink-0" />;
    case "files":
      return <Files className="size-3 shrink-0" />;
    case "file":
      return (
        <PierreEntryIcon
          pathValue={surface.relativePath}
          kind="file"
          theme={theme}
          className="size-3"
        />
      );
    case "terminal":
      return <TerminalSquare className="size-3 shrink-0" />;
    case "pull-request":
      return (
        <PullRequestSurfaceIcon
          surface={surface}
          environmentId={environmentId}
          seed={pullRequestStatusSeed}
        />
      );
    case "pull-requests":
      return <PullRequestGlyph.link className="size-3 shrink-0" />;
    case "side-chat":
      return <MessagesSquareIcon className="size-3 shrink-0" />;
    case "device":
      return surface.target?.platform === "ios" ? (
        <AppleIcon className="size-3 shrink-0" />
      ) : surface.target?.platform === "android" ? (
        <AndroidIcon className="size-3 shrink-0" />
      ) : (
        <Smartphone className="size-3 shrink-0" />
      );
  }
}

export function resolvePullRequestTabLink(
  threads: readonly Pick<EnvironmentThreadShell, "environmentId" | "pullRequests">[],
  environmentId: EnvironmentId | null,
  host: string | null,
  reference: { repository: string; number: number },
) {
  if (environmentId === null || host === null) return undefined;
  let newest: EnvironmentThreadShell["pullRequests"][number] | undefined;
  for (const thread of threads) {
    if (thread.environmentId !== environmentId) continue;
    for (const link of visibleThreadPullRequests(thread.pullRequests)) {
      if (
        !threadPullRequestKeysEqual(link, {
          host,
          repository: reference.repository,
          number: reference.number,
        })
      )
        continue;
      if (
        newest === undefined ||
        (link.snapshot?.syncedAt ?? "") > (newest.snapshot?.syncedAt ?? "")
      )
        newest = link;
    }
  }
  return newest;
}

function PullRequestSurfaceIcon({
  surface,
  environmentId,
  seed,
}: {
  surface: Extract<RightPanelSurface, { kind: "pull-request" }>;
  environmentId: EnvironmentId | null;
  seed: PullRequestTabStatusSeed | undefined;
}) {
  const resolvedEnvironmentId =
    (surface.environmentId as EnvironmentId | undefined) ?? environmentId;
  const projects = useProjects();
  const threads = useThreadShells();
  const project = projects.find(
    (entry) => entry.environmentId === resolvedEnvironmentId && entry.id === surface.projectId,
  );
  const identity = project?.repositoryIdentity;
  const host =
    surface.host ??
    (identity?.provider
      ? pullRequestHostOf(identity, identity.provider as SourceControlProviderKind)
      : null);
  const configs = useServerConfigs();
  const capabilities =
    resolvedEnvironmentId === null
      ? undefined
      : configs.get(resolvedEnvironmentId)?.environment.capabilities;
  const linkedSnapshot =
    capabilities?.threadPullRequests === true
      ? (resolvePullRequestTabLink(threads, resolvedEnvironmentId, host, surface)?.snapshot ?? null)
      : null;
  const detail = useEnvironmentQuery(
    resolvedEnvironmentId === null || capabilities?.pullRequests !== true || linkedSnapshot !== null
      ? null
      : pullRequestEnvironment.detail({
          environmentId: resolvedEnvironmentId,
          input: {
            projectId: surface.projectId as ProjectId,
            ...(capabilities?.threadPullRequests === true && surface.host !== undefined
              ? { host: surface.host }
              : {}),
            repository: surface.repository,
            number: surface.number,
          },
        }),
  ).data;
  const reference = {
    projectId: surface.projectId as ProjectId,
    repository: surface.repository,
    number: surface.number,
  };
  const sharedSummary = useSharedPullRequestSummary(resolvedEnvironmentId, reference, null);
  const status = linkedSnapshot ?? newestPullRequestSummary(detail, sharedSummary) ?? seed ?? null;
  if (status === null) {
    return <PullRequestGlyph.pullRequest className="size-3 shrink-0 text-muted-foreground" />;
  }
  const presentation = resolvePullRequestState({
    state: status.state,
    isDraft: status.isDraft ?? detail?.isDraft ?? seed?.isDraft ?? false,
  });
  return <presentation.Icon className={cn("size-3 shrink-0", presentation.toneClassName)} />;
}

export type PanelTabKeyAction =
  | { readonly type: "focus"; readonly index: number }
  | { readonly type: "activate" }
  | { readonly type: "close" };

/**
 * Keyboard behavior for the panel tab list. Arrows move focus without opening the tab, since a
 * browser or terminal surface is costly to start; Enter or Space opens it and Delete closes it.
 */
export function panelTabKeyAction(
  key: string,
  index: number,
  count: number,
): PanelTabKeyAction | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowRight":
      return { type: "focus", index: (index + 1) % count };
    case "ArrowLeft":
      return { type: "focus", index: (index - 1 + count) % count };
    case "Home":
      return { type: "focus", index: 0 };
    case "End":
      return { type: "focus", index: count - 1 };
    case "Enter":
    case " ":
      return { type: "activate" };
    case "Delete":
    case "Backspace":
      return { type: "close" };
    default:
      return null;
  }
}

export function SortableTabList(props: {
  surfaces: readonly RightPanelSurface[];
  onMove: ((surfaceId: string, toIndex: number) => void) | undefined;
  children: ReactNode;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const surfaceIds = props.surfaces.map((surface) => surface.id);
  const { onMove, surfaces } = props;
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const toIndex = surfaces.findIndex((surface) => surface.id === over.id);
    if (toIndex >= 0) onMove?.(String(active.id), toIndex);
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={TAB_DRAG_MODIFIERS}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={surfaceIds} strategy={horizontalListSortingStrategy}>
        {props.children}
      </SortableContext>
    </DndContext>
  );
}

interface RightPanelTabHandlers {
  onActivate: (surface: RightPanelSurface) => void;
  onClose: (surface: RightPanelSurface) => void;
  onAuxClick: (event: ReactMouseEvent, surface: RightPanelSurface) => void;
  onContextMenu: (event: ReactMouseEvent, surface: RightPanelSurface) => void;
  onStartRename: (surfaceId: string) => void;
  onFinishRename: (surfaceId: string, title: string) => void;
}

// Chromium on Linux only suppresses primary-selection paste when mouseup is cancelled.
function preventTabMiddleButtonDefault(event: ReactMouseEvent) {
  if (event.button !== 1) return;
  event.preventDefault();
}

// One tab owns its sortable state and receives only its own values, so the
// compiled subtree is reused unless this tab's surface, title or state changed.
// The handlers must be stable: the tab list re-renders on every parent render.
export function RightPanelTab(
  props: RightPanelTabHandlers & {
    surface: RightPanelSurface;
    dragDisabled: boolean;
    active: boolean;
    pending: boolean;
    title: string;
    audio: TabAudioState;
    audioRuntimeTabId: string | null;
    previewUrl: string | null;
    previewCapturedUrl: string | null;
    theme: "light" | "dark";
    environmentId: EnvironmentId | null;
    pullRequestStatusSeed: PullRequestTabStatusSeed | undefined;
    renaming: boolean;
    canRename: boolean;
    ownsDesktopTitleBar: boolean;
    tabId: string;
    panelId: string;
  },
) {
  const {
    surface,
    title,
    audio,
    audioRuntimeTabId,
    onActivate,
    onClose,
    onAuxClick,
    onContextMenu,
    onStartRename,
    onFinishRename,
  } = props;
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: surface.id,
    disabled: props.dragDisabled,
  });
  const content = (
    <>
      <PanelTabCloseButton
        label={`Close ${title}`}
        size="lg"
        tabIndex={-1}
        onClick={(event) => {
          event.stopPropagation();
          onClose(surface);
        }}
      >
        <SurfaceIcon
          surface={surface}
          previewUrl={props.previewUrl}
          previewCapturedUrl={props.previewCapturedUrl}
          theme={props.theme}
          environmentId={props.environmentId}
          pullRequestStatusSeed={props.pullRequestStatusSeed}
        />
        {props.pending ? (
          <span
            className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-current"
            aria-hidden
          />
        ) : null}
      </PanelTabCloseButton>
      {audio === "none" || !audioRuntimeTabId ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                tabIndex={-1}
                className="cursor-pointer flex size-5 shrink-0 items-center justify-center rounded-md hover:bg-muted"
                aria-label={audio === "muted" ? `Unmute ${title}` : `Mute ${title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  void previewBridge
                    ?.setAudioMuted(audioRuntimeTabId, audio !== "muted")
                    .catch(() => undefined);
                }}
              >
                <MorphIcon className="size-3.5" icon={audio === "muted" ? VolumeOff : Volume2} />
              </button>
            }
          />
          <TooltipPopup>{audio === "muted" ? "Unmute tab" : "Mute tab"}</TooltipPopup>
        </Tooltip>
      )}
      {props.renaming ? (
        <input
          aria-label="Device tab name"
          className="w-28 min-w-0 rounded-sm bg-background px-1 outline-none ring-1 ring-inset ring-ring"
          defaultValue={title}
          ref={(element) => {
            element?.focus();
            element?.select();
          }}
          onBlur={(event) => onFinishRename(surface.id, event.currentTarget.value)}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              event.currentTarget.value = title;
              event.currentTarget.blur();
            }
          }}
        />
      ) : (
        <Tooltip>
          <TooltipTrigger render={<span className="min-w-0 truncate">{title}</span>} />
          <TooltipPopup>
            {surface.kind === "device" ? (
              <DeviceTabTooltip
                surface={surface}
                environmentId={props.environmentId}
                title={title}
              />
            ) : (
              title
            )}
          </TooltipPopup>
        </Tooltip>
      )}
    </>
  );
  return (
    <div
      role="tab"
      id={props.tabId}
      aria-label={title}
      aria-selected={props.active}
      aria-controls={props.active ? props.panelId : undefined}
      tabIndex={props.active ? 0 : -1}
      data-active-tab={props.active}
      onClick={() => onActivate(surface)}
      onDoubleClick={() => {
        if (surface.kind === "device" && props.canRename) onStartRename(surface.id);
      }}
      onMouseDown={preventTabMiddleButtonDefault}
      onMouseUp={preventTabMiddleButtonDefault}
      onAuxClick={(event) => onAuxClick(event, surface)}
      onContextMenu={(event) => onContextMenu(event, surface)}
      {...listeners}
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "cursor-pointer group/tab flex h-8 max-w-48 shrink-0 select-none items-center gap-1.5 rounded-(--control-radius) pr-2.5 pl-1.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        props.ownsDesktopTitleBar && "[-webkit-app-region:no-drag]",
        props.active
          ? "bg-accent text-foreground ring-1 ring-inset ring-border"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground active:bg-accent/80",
        isDragging && "relative z-10 shadow-sm",
      )}
    >
      {content}
    </div>
  );
}

function DeviceTabTooltip(props: {
  surface: Extract<RightPanelSurface, { kind: "device" }>;
  environmentId: EnvironmentId | null;
  title: string;
}) {
  const target = props.surface.target;
  const { state } = useDeviceState(target ? props.environmentId : null);
  const device = target
    ? state.devices.find((entry) => entry.hostId === target.hostId && entry.id === target.deviceId)
    : undefined;
  const host = target ? state.hosts.find((entry) => entry.id === target.hostId) : undefined;
  return (
    <div className="flex flex-col gap-0.5">
      <span>{props.title}</span>
      {target ? (
        <span className="text-muted-foreground">
          {host?.label ?? "Device host"} ·{" "}
          {device?.version ?? (target.platform === "ios" ? "iOS" : "Android")}
        </span>
      ) : null}
    </div>
  );
}
