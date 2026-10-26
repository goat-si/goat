import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type OrchestrationV2ThreadLauncher,
  type ScopedThreadRef,
  type ThreadId,
} from "@goat/contracts";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import type { EnvironmentProject } from "@goat/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import { ChevronDownIcon, GlobeIcon, MessagesSquareIcon } from "~/components/solar";
import {
  memo,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { isTrailingDoubleClick } from "../Sidebar.logic";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { useThreadActionMenu } from "~/hooks/useThreadActionMenu";
import { readLocalApi } from "~/localApi";
import { threadEnvironment } from "../../state/threads";
import { canShareWithGuestAtom } from "./guestShareAvailability";
import { useAtomValue } from "@effect/atom-react";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { ProjectFavicon } from "../ProjectFavicon";
import { GoatBotModeButton } from "../goatBot/GoatBotModeButton";
import { ThreadNotesButton } from "../../notes/ThreadNotesButton";
import { AgentScreenCardsToggle } from "../preview/sessions/AgentScreenCardsToggle";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { describeThreadLauncher } from "./threadLauncher.logic";
import { textDirection } from "~/textDirection";
import { useClientSettings } from "../../hooks/useSettings";
import { GuestShareIndicator } from "./GuestShareControls";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  activeThreadTitle: string;
  /** Presentation-only title; renames still compare against activeThreadTitle. */
  displayTitle?: string | undefined;
  /**
   * The thread is the global agent. Its project is the machine's hidden
   * no-project folder, so the header shows the agent itself instead of a
   * project crumb. activeProject still feeds menu actions such as Copy path.
   */
  globalAgent?: boolean | undefined;
  isServerThread: boolean;
  activeProject: EnvironmentProject | null;
  parentThreadLink: { threadId: ThreadId; title: string } | null;
  launcherThreadLink?:
    | {
        ref: ScopedThreadRef;
        title: string;
        kind: OrchestrationV2ThreadLauncher["kind"];
        /** The launching machine's name for a launch from another machine. */
        machine: string | null;
        /** False when the launcher thread is not loaded here, so it cannot be opened. */
        available: boolean;
      }
    | null
    | undefined;
  onOpenThread: (threadId: ThreadId) => void;
  onOpenScopedThread?: ((ref: ScopedThreadRef) => void) | undefined;
  rightPanelOpen: boolean;
  onNewThreadInProject: () => void;
  onOpenProjectSettings?: (() => void) | undefined;
  /** Present when this thread can open a side chat. */
  onToggleSideChat?: (() => void) | undefined;
  sideChatOpen?: boolean | undefined;
  sideChatShortcutLabel?: string | null | undefined;
}

function resolveRenameCommit(input: {
  readonly title: string;
  readonly originalTitle: string;
}): { action: "commit"; title: string } | { action: "reject-empty" } | { action: "noop" } {
  const trimmed = input.title.trim();
  if (trimmed.length === 0) return { action: "reject-empty" };
  if (trimmed === input.originalTitle) return { action: "noop" };
  return { action: "commit", title: trimmed };
}

// Delay the input-swallowing native menu through the double-click rename interval.
const TITLE_MENU_OPEN_DELAY_MS = 500;
export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  activeThreadTitle,
  displayTitle,
  globalAgent = false,
  isServerThread,
  activeProject,
  parentThreadLink,
  launcherThreadLink,
  onOpenThread,
  onOpenScopedThread,
  rightPanelOpen,
  onNewThreadInProject,
  onOpenProjectSettings,
  onToggleSideChat,
  sideChatOpen = false,
  sideChatShortcutLabel = null,
}: ChatHeaderProps) {
  const relatedThreadLink = parentThreadLink ?? (onOpenScopedThread ? launcherThreadLink : null);
  const launcherOnly =
    parentThreadLink === null && relatedThreadLink !== null ? launcherThreadLink : null;
  const relatedThreadUnavailable = launcherOnly?.available === false;
  const relatedThreadTooltip = launcherOnly
    ? describeThreadLauncher(launcherOnly)
    : relatedThreadLink?.title;
  const shownTitle = displayTitle ?? activeThreadTitle;
  // A fixed label is not the thread's own title, so editing it inline would
  // rename something the header never shows.
  const canRenameInline = displayTitle === undefined;
  const activeProjectName = activeProject?.isScratch ? "No project" : activeProject?.title;
  const showProjectCrumb = activeProject !== null && !globalAgent;
  const activeProjectCwd = activeProject?.workspaceRoot ?? null;
  const interfaceFont = useClientSettings((settings) => settings.fontFamilySans);
  const breadcrumbContainerRef = useRef<HTMLDivElement>(null);
  const [collapseParentTitle, setCollapseParentTitle] = useState(false);
  const activeThreadRef = scopeThreadRef(activeThreadEnvironmentId, activeThreadId);
  const canOperateThread = useEnvironmentScope(
    activeThreadEnvironmentId,
    AuthOrchestrationOperateScope,
  );
  const canShareWithGuest = useAtomValue(canShareWithGuestAtom(activeThreadEnvironmentId));
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const [renaming, setRenaming] = useState<{
    threadId: ThreadId;
    environmentId: EnvironmentId;
    title: string;
  } | null>(null);
  if (
    renaming !== null &&
    (renaming.threadId !== activeThreadId ||
      renaming.environmentId !== activeThreadEnvironmentId ||
      !canOperateThread)
  ) {
    setRenaming(null);
  }
  const renamingTitle =
    canOperateThread &&
    renaming?.threadId === activeThreadId &&
    renaming.environmentId === activeThreadEnvironmentId
      ? renaming.title
      : null;
  const isRenamingTitle = renamingTitle !== null;
  useEffect(() => {
    const list = breadcrumbContainerRef.current?.querySelector("ol");
    if (!list || !relatedThreadLink) return;
    const measure = () => {
      const gap = Number.parseFloat(getComputedStyle(list).columnGap) || 0;
      const width = Array.from(list.children).reduce(
        (total, item) => {
          const label = item.querySelector('[data-slot="workspace-breadcrumb-text"]');
          const ellipsis = item.querySelector("[data-parent-breadcrumb-ellipsis]");
          return (
            total +
            (item.firstElementChild?.getBoundingClientRect().width ?? 0) +
            (label && getComputedStyle(label).maxWidth === "none"
              ? label.scrollWidth - label.clientWidth
              : 0) -
            (ellipsis?.getBoundingClientRect().width ?? 0)
          );
        },
        gap * (list.children.length - 1),
      );
      setCollapseParentTitle(width > list.clientWidth);
    };
    measure();
    const frame = requestAnimationFrame(measure);
    document.fonts.addEventListener("loadingdone", measure);
    const stopObserving = observeResize(list, measure);
    return () => {
      cancelAnimationFrame(frame);
      document.fonts.removeEventListener("loadingdone", measure);
      stopObserving();
    };
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Title, font and rename changes resize the breadcrumb text without resizing the list, so it re-measures.
    activeProjectName,
    showProjectCrumb,
    shownTitle,
    relatedThreadLink,
    interfaceFont,
    isRenamingTitle,
  ]);
  const renameCommittedRef = useRef(false);
  const startRename = () => {
    if (
      !isServerThread ||
      !readEnvironmentScope(activeThreadEnvironmentId, AuthOrchestrationOperateScope)
    )
      return;
    renameCommittedRef.current = false;
    setRenaming({
      environmentId: activeThreadEnvironmentId,
      threadId: activeThreadId,
      title: activeThreadTitle,
    });
  };
  const commitRename = (title: string) => {
    setRenaming(null);
    if (!readEnvironmentScope(activeThreadEnvironmentId, AuthOrchestrationOperateScope)) return;
    const resolution = resolveRenameCommit({ title, originalTitle: activeThreadTitle });
    if (resolution.action === "reject-empty") {
      toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
      return;
    }
    if (resolution.action === "noop") return;
    void updateThreadMetadata({
      environmentId: activeThreadEnvironmentId,
      input: { threadId: activeThreadId, title: resolution.title },
    }).then((result) => {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Failed to rename thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    });
  };
  const { openMenu, closeMenu } = useThreadActionMenu({
    threadRef: isServerThread ? activeThreadRef : null,
    projectCwd: activeProjectCwd,
    onStartRename: startRename,
    globalAgent,
  });
  const titleButtonRef = useRef<HTMLButtonElement | null>(null);
  const titleMenuTimerRef = useRef<number | null>(null);
  const cancelPendingTitleMenu = () => {
    if (titleMenuTimerRef.current === null) return;
    clearTimeout(titleMenuTimerRef.current);
    titleMenuTimerRef.current = null;
  };
  useEffect(
    () => () => {
      if (titleMenuTimerRef.current === null) return;
      clearTimeout(titleMenuTimerRef.current);
      titleMenuTimerRef.current = null;
    },
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A pending title menu belongs to the thread that was clicked, so switching threads drops it.
    [activeThreadEnvironmentId, activeThreadId],
  );
  const openTitleMenuNow = () => {
    cancelPendingTitleMenu();
    const rect = titleButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    openMenu({ x: rect.left, y: rect.bottom + 4 });
  };
  const openMenuFromTitle = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (isTrailingDoubleClick(event.detail)) return;
    const clickedChevron =
      (event.target as HTMLElement).closest("[data-thread-title-chevron]") !== null;
    if (event.detail === 0 || clickedChevron || window.desktopBridge === undefined) {
      openTitleMenuNow();
      return;
    }
    cancelPendingTitleMenu();
    titleMenuTimerRef.current = window.setTimeout(() => {
      titleMenuTimerRef.current = null;
      openTitleMenuNow();
    }, TITLE_MENU_OPEN_DELAY_MS);
  };
  const handleTitleDoubleClick = (event: ReactMouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if ((event.target as HTMLElement).closest("[data-thread-title-chevron]") !== null) return;
    cancelPendingTitleMenu();
    closeMenu();
    startRename();
  };
  const handleHeaderContextMenu = (event: ReactMouseEvent) => {
    if (renamingTitle !== null) return;
    if (!isServerThread && onOpenProjectSettings === undefined) return;
    cancelPendingTitleMenu();
    event.preventDefault();
    if (!isServerThread) {
      const api = readLocalApi();
      if (!api) return;
      void api.contextMenu
        .show([{ id: "project-settings", label: "Project settings", icon: "settings" }], {
          x: event.clientX,
          y: event.clientY,
        })
        .then((action) => {
          if (action === "project-settings") onOpenProjectSettings?.();
        });
      return;
    }
    openMenu({ x: event.clientX, y: event.clientY });
  };
  const handleRenameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      renameCommittedRef.current = true;
      commitRename(event.currentTarget.value);
    } else if (event.key === "Escape") {
      renameCommittedRef.current = true;
      setRenaming(null);
    }
  };
  return (
    <div
      ref={breadcrumbContainerRef}
      className={cn(
        "flex min-w-0 flex-1 items-center gap-2 sm:gap-3",
        rightPanelOpen ? "pr-10" : "pr-24",
      )}
      onContextMenu={handleHeaderContextMenu}
    >
      <WorkspaceBreadcrumb
        ariaLabel="Thread breadcrumb"
        className="flex-1 overflow-clip [overflow-clip-margin:2px]"
      >
        {showProjectCrumb && activeProject ? (
          <>
            <WorkspaceBreadcrumbItem className="shrink">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={`New thread in ${activeProjectName}`}
                      onClick={onNewThreadInProject}
                      className="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    />
                  }
                >
                  <ProjectFavicon project={activeProject} className="size-3.5" />
                  <WorkspaceBreadcrumbText className="max-w-24 sm:max-w-40">
                    {activeProjectName}
                  </WorkspaceBreadcrumbText>
                </TooltipTrigger>
                <TooltipPopup side="top">New thread in {activeProjectName}</TooltipPopup>
              </Tooltip>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator>
              <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
            </WorkspaceBreadcrumbSeparator>
          </>
        ) : null}
        {relatedThreadLink ? (
          <>
            <WorkspaceBreadcrumbItem>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={
                        relatedThreadUnavailable
                          ? relatedThreadTooltip
                          : `${parentThreadLink ? "Open parent thread" : launcherThreadLink?.kind === "promotion" ? "Open original parent thread" : "Open launching thread"}: ${relatedThreadLink.title}`
                      }
                      aria-disabled={relatedThreadUnavailable || undefined}
                      onClick={() => {
                        if (parentThreadLink) onOpenThread(parentThreadLink.threadId);
                        else if (launcherThreadLink?.available)
                          onOpenScopedThread?.(launcherThreadLink.ref);
                      }}
                      className={cn(
                        "inline-flex min-w-0 max-w-full items-center rounded-sm text-muted-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        relatedThreadUnavailable
                          ? "cursor-default"
                          : "cursor-pointer transition-colors hover:text-foreground",
                      )}
                    />
                  }
                >
                  <WorkspaceBreadcrumbText
                    aria-hidden
                    className={collapseParentTitle ? "w-0" : undefined}
                  >
                    {relatedThreadLink.title}
                  </WorkspaceBreadcrumbText>
                  {collapseParentTitle ? (
                    <span aria-hidden data-parent-breadcrumb-ellipsis>
                      ...
                    </span>
                  ) : null}
                </TooltipTrigger>
                <TooltipPopup side="top">{relatedThreadTooltip}</TooltipPopup>
              </Tooltip>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator>
              <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
            </WorkspaceBreadcrumbSeparator>
          </>
        ) : null}
        <WorkspaceBreadcrumbItem current className="min-w-10 flex-1">
          {globalAgent && renamingTitle === null ? (
            <GlobeIcon
              aria-hidden
              data-global-agent-mark=""
              className="mr-1.5 size-3.5 shrink-0 text-muted-foreground"
            />
          ) : null}
          {renamingTitle !== null ? (
            <input
              autoFocus
              dir="auto"
              aria-label="Thread title"
              className="min-w-0 flex-1 rounded-sm bg-transparent text-sm font-medium text-foreground outline-none ring-1 ring-inset ring-ring/50 focus:ring-ring"
              defaultValue={renamingTitle}
              onBlur={(event) => {
                if (renameCommittedRef.current) return;
                if (
                  event.relatedTarget instanceof HTMLElement &&
                  event.relatedTarget.closest("button")
                ) {
                  setRenaming(null);
                  return;
                }
                commitRename(event.currentTarget.value);
              }}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={handleRenameKeyDown}
            />
          ) : isServerThread ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    ref={titleButtonRef}
                    type="button"
                    aria-label={`Thread actions for ${shownTitle}`}
                    aria-haspopup="menu"
                    onClick={openMenuFromTitle}
                    onDoubleClick={
                      canOperateThread && canRenameInline ? handleTitleDoubleClick : undefined
                    }
                    onBlur={cancelPendingTitleMenu}
                    className="group/thread-title inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  />
                }
              >
                <h2 className="min-w-0" dir={textDirection(shownTitle)}>
                  <WorkspaceBreadcrumbText>{shownTitle}</WorkspaceBreadcrumbText>
                </h2>
                <ChevronDownIcon
                  aria-hidden
                  data-thread-title-chevron
                  className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/thread-title:opacity-100 group-focus-visible/thread-title:opacity-100"
                />
              </TooltipTrigger>
              <TooltipPopup side="top">{shownTitle}</TooltipPopup>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <h2
                    aria-label={shownTitle}
                    className="min-w-0 flex-1"
                    dir={textDirection(shownTitle)}
                  />
                }
              >
                <WorkspaceBreadcrumbText>{shownTitle}</WorkspaceBreadcrumbText>
              </TooltipTrigger>
              <TooltipPopup side="top">{shownTitle}</TooltipPopup>
            </Tooltip>
          )}
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      <AgentScreenCardsToggle />
      {isServerThread ? (
        <ThreadNotesButton
          environmentId={activeThreadEnvironmentId}
          threadId={activeThreadId}
          projectTitle={activeProject && !activeProject.isScratch ? activeProject.title : null}
        />
      ) : null}
      {onToggleSideChat ? (
        <Tooltip>
          <TooltipTrigger render={<span className="flex shrink-0" />}>
            <Toggle
              className="shrink-0 [-webkit-app-region:no-drag]"
              pressed={sideChatOpen}
              onPressedChange={onToggleSideChat}
              aria-label="Toggle side chat"
              variant="ghost"
              size="sm"
            >
              <MessagesSquareIcon className="size-4" />
            </Toggle>
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            Side chat{sideChatShortcutLabel ? ` (${sideChatShortcutLabel})` : ""}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {globalAgent ? (
        <div className="flex shrink-0 items-center">
          <GoatBotModeButton to="bot" />
        </div>
      ) : null}
      {isServerThread ? <GuestShareIndicator threadRef={activeThreadRef} /> : null}
    </div>
  );
});
