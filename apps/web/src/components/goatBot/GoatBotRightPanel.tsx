import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeProjectRef } from "@goat/client-runtime/environment";
import {
  AuthPreviewOperateScope,
  AuthTerminalOperateScope,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
} from "@goat/contracts";
import { resolveTerminalSessionLabel } from "@goat/shared/terminalLabels";
import {
  lazy,
  Suspense,
  useContext,
  useEffect,
  useEffectEvent,
  useState,
  type ReactNode,
} from "react";

import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { isCommandPaletteOpen } from "~/commandPaletteBus";
import { isElectron } from "~/env";
import { useDesktopPanelMenu } from "~/hooks/useDesktopPanelMenu";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { useRightPanelSurfaceClose } from "~/hooks/useRightPanelSurfaceClose";
import { resolveShortcutCommand, shortcutLabelForCommand } from "~/keybindings";
import { isEditableFocused } from "~/lib/editableFocus";
import { cn } from "~/lib/utils";
import { isPreviewFocused } from "~/lib/previewFocus";
import { getTerminalFocusOwner } from "~/lib/terminalFocus";
import { usePanelAnimationSettings, usePanelPresence } from "~/panelAnimations";
import {
  previewMiniPlayerSourceKey,
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
} from "~/previewMiniPlayerStore";
import { isPreviewSupportedInRuntime, useThreadPreviewState } from "~/previewStateStore";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "~/rightPanelLayout";
import {
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
  type RightPanelSurface,
} from "~/rightPanelStore";
import { useDeviceState } from "~/state/device";
import {
  useEnvironmentSupportsServerBrowser,
  useProject,
  useQuietThreadShell,
} from "~/state/entities";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { useKnownTerminalSessions } from "~/state/terminalSessions";

import { BackgroundThreadContext } from "../chat/backgroundThread";
import { shouldRenderPreviewMiniPlayer } from "../ChatView.logic";
import { ChatCanvas } from "../chat/ChatCanvas";
import { ChatRightPanel } from "../chat/ChatRightPanel";
import { DeviceSetupDialogHost } from "../chat/ChatOverlayHosts";
import { PanelLayoutControls, WorkspaceTitlebarControls } from "../chat/PanelLayoutControls";
import type { ChatShortcutCommands } from "../chat/useChatShortcuts";
import { usePanelTerminalActions } from "../chat/usePanelTerminalActions";
import { useRightPanelActions } from "../chat/useRightPanelActions";
import { PersistentThreadTerminalPanel } from "../PersistentThreadTerminals";
import { PreviewSessionSync } from "../preview/PreviewSessionSync";
import { ThreadPreviewMiniPlayer } from "../preview/ThreadPreviewMiniPlayer";
import type { RightPanelLauncherSurface } from "../rightPanelSurfaceAvailability";
import { useThreadTerminalActions } from "../terminal/useThreadTerminalActions";

const PreviewPanel = lazy(() =>
  import("../preview/PreviewPanel").then((module) => ({ default: module.PreviewPanel })),
);
const DevicePanel = lazy(() =>
  import("../device/DevicePanel").then((module) => ({ default: module.DevicePanel })),
);

// The bot's folder is not a Git checkout and its thread links no pull requests, and the files
// panel files its line comments into a coding composer the bot's chat never reads.
const BOT_SURFACES: ReadonlySet<RightPanelLauncherSurface> = new Set([
  "browser",
  "terminal",
  "device",
]);
const NO_PENDING_SURFACES: ReadonlySet<string> = new Set();
const notOffered = () => {};

/**
 * The bot thread's right panel: the ordinary thread panel, its header toggle and shortcuts, with
 * the surfaces that make sense beside a bot. `children` renders the chat with the header toggle.
 */
export function GoatBotRightPanelFrame({
  threadRef,
  children,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly children: (panelControls: ReactNode) => ReactNode;
}) {
  const background = useContext(BackgroundThreadContext);
  const { environmentId } = threadRef;
  const threadKey = scopedThreadKey(threadRef);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shell = useQuietThreadShell(threadRef);
  const project = useProject(shell ? scopeProjectRef(shell.environmentId, shell.projectId) : null);
  const panelState = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, threadRef),
  );
  const activeSurface = useRightPanelStore((state) =>
    selectActiveRightPanelSurface(state.byThreadKey, threadRef),
  );
  const previewState = useThreadPreviewState(threadRef);
  const serverBrowser = useEnvironmentSupportsServerBrowser(environmentId);
  const browserAvailable = isPreviewSupportedInRuntime() || serverBrowser;
  const canOperatePreview = useEnvironmentScope(environmentId, AuthPreviewOperateScope);
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const { state: deviceState, loaded: deviceStateLoaded } = useDeviceState(environmentId);
  const miniPlayer = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayer(state.byThreadKey, threadRef),
  );
  const knownSessions = useKnownTerminalSessions({
    environmentId,
    threadId: threadRef.threadId,
  });
  const terminalLabelsById = new Map(
    (knownSessions ?? [])
      .filter((session) => session.target.threadId === threadRef.threadId)
      .map((session) => [
        session.target.terminalId,
        resolveTerminalSessionLabel(session.target.terminalId, session.state.summary),
      ]),
  );

  const open = panelState.isOpen;
  const sheet =
    useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY) && panelState.maximized !== true;
  const maximized = open && panelState.maximized === true;
  const previewPanelOpen = activeSurface?.kind === "preview" && browserAvailable;
  const { active: animationsActive, durationMs } = usePanelAnimationSettings();
  const presenceValue = { activeSurface, surfaces: panelState.surfaces };
  const presence = usePanelPresence(open, presenceValue, animationsActive, threadKey, durationMs);
  const renderedSurface = presence.value?.activeSurface ?? null;
  const [layoutElement, setLayoutElement] = useState<HTMLElement | null>(null);

  const surfaceClose = useRightPanelSurfaceClose({ threadRef, terminalLabelsById });
  const terminalActions = useThreadTerminalActions(threadRef);
  const panelTerminals = usePanelTerminalActions({
    threadRef,
    activeSurface,
    terminalLabelsById,
    terminalActions,
  });
  const actions = useRightPanelActions({
    isCloudThread: false,
    activeThreadRef: threadRef,
    activeProject: project,
    activeRightPanelSurface: activeSurface,
    activePreviewState: previewState,
    deviceState,
    deviceStateLoaded,
    pullRequestPanelTarget: null,
    threadPanelPresentation: "inline",
    isServerThread: true,
    isGitRepo: false,
    browserAvailable,
    canOperatePreview,
    diffOpen: false,
    previewPanelOpen,
    rightPanelOpen: open,
    canMaximizeRightPanel: open,
    rightPanelMaximized: maximized,
    supportsPullRequests: false,
    pullRequestsSurfaceAvailable: false,
    gitCwd: null,
    activeProjectCwd: project?.workspaceRoot ?? null,
    onDiffPanelOpen: undefined,
    closeRightPanelSurface: surfaceClose.closeSurface,
  });
  const closeActiveSurface = () => {
    if (activeSurface) surfaceClose.closeSurface(activeSurface);
  };

  const getShortcutContext = (target: EventTarget | null = document.activeElement) => ({
    terminalFocus: getTerminalFocusOwner() !== null,
    terminalOpen: false,
    previewFocus: isPreviewFocused(),
    previewOpen: previewPanelOpen,
    rightPanelOpen: open,
    editableFocus: isEditableFocused(target),
    isWeb: !isElectron,
    isDesktop: isElectron,
  });
  const panelTerminalCommand =
    (run: () => void) =>
    ({ terminalFocusOwner }: { readonly terminalFocusOwner: string | null }) => {
      if (terminalFocusOwner !== "right-panel" || !canOperateTerminal) return false;
      run();
    };
  const commands: ChatShortcutCommands = {
    "rightPanel.toggle": actions.shortcuts["rightPanel.toggle"],
    "rightPanel.toggleMaximized": actions.shortcuts["rightPanel.toggleMaximized"],
    "rightPanel.close": actions.shortcuts["rightPanel.close"],
    "terminal.new": panelTerminalCommand(panelTerminals.addTerminalSurfaceStable),
    "terminal.split": panelTerminalCommand(() => panelTerminals.splitPanelTerminalStable()),
    "terminal.splitVertical": panelTerminalCommand(panelTerminals.splitPanelTerminalVerticalStable),
    "terminal.close": panelTerminalCommand(() => {
      if (activeSurface?.kind === "terminal")
        panelTerminals.requestClosePanelTerminalStable(activeSurface.activeTerminalId);
    }),
  };
  const onShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (isCommandPaletteOpen()) return;
    const terminalFocusOwner = getTerminalFocusOwner();
    if (event.defaultPrevented && terminalFocusOwner === null) return;
    const command = resolveShortcutCommand(event, keybindings, {
      context: getShortcutContext(event.target),
    });
    const run = command === null ? undefined : commands[command];
    if (!run || run({ event, terminalFocusOwner }) === false) return;
    event.preventDefault();
    event.stopPropagation();
  });
  // oxlint-disable-next-line goat/react-effect-budget -- Window shortcuts for the panel while this bot thread is in front.
  useEffect(() => {
    if (background) return;
    const onKeyDown = (event: KeyboardEvent) => onShortcut(event);
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [background]);
  useDesktopPanelMenu(
    !background,
    actions.toggleRightPanelStable,
    actions.toggleRightPanelMaximizedStable,
    closeActiveSurface,
  );

  const toggleControls = (
    <PanelLayoutControls
      showThreadPanelControl={false}
      showTerminalControl={false}
      terminalAvailable={false}
      terminalOpen={false}
      terminalShortcutLabel={null}
      threadPanelOpen={false}
      threadPanelPresentation="inline"
      threadPanelShortcutLabel={null}
      onToggleThreadPanel={notOffered}
      onToggleTerminal={notOffered}
      rightPanelAvailable
      rightPanelOpen={open}
      rightPanelShortcutLabel={shortcutLabelForCommand(keybindings, "rightPanel.toggle")}
      onToggleRightPanel={actions.toggleRightPanelStable}
      rightPanelMaximized={maximized}
      onToggleMaximized={sheet ? actions.toggleRightPanelMaximizedStable : undefined}
    />
  );
  const titlebarControls = (
    <WorkspaceTitlebarControls
      showMaximizeControl={!sheet}
      rightPanelOpen={open}
      animationsActive={animationsActive}
      maximized={maximized}
      onToggleMaximized={actions.toggleRightPanelMaximizedStable}
    >
      {toggleControls}
    </WorkspaceTitlebarControls>
  );
  // As in a thread: beside an inline panel the controls float over it; otherwise the header
  // holds them, since a no-drag descendant is the only way past its desktop drag region.
  const controlsAtRoot = presence.present && !sheet;
  const controlsInPanel = sheet && presence.present && open;
  const headerControls = (
    <>
      {isElectron && controlsAtRoot ? (
        <span
          aria-hidden
          className="pointer-events-none fixed top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] h-[var(--workspace-topbar-height)] w-28 [-webkit-app-region:no-drag]"
        />
      ) : null}
      {controlsAtRoot || controlsInPanel ? null : titlebarControls}
    </>
  );

  return (
    <div ref={setLayoutElement} className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <DeviceSetupDialogHost threadKey={threadKey} threadRef={threadRef} state={deviceState} />
      {canOperatePreview && serverBrowser ? <PreviewSessionSync threadRef={threadRef} /> : null}
      {controlsAtRoot ? titlebarControls : null}
      <div
        className={cn("relative flex min-h-0 min-w-0", maximized ? "w-0 flex-none" : "flex-1")}
        inert={maximized}
      >
        {/* The floated browser's frame; the bot's centered chat does not move aside for it. */}
        <ChatCanvas composerOverlayElement={null}>
          {children(headerControls)}
          {miniPlayer &&
          shouldRenderPreviewMiniPlayer(miniPlayer.source, renderedSurface) &&
          (miniPlayer.source.kind === "device" || canOperatePreview) ? (
            <ThreadPreviewMiniPlayer
              key={`${miniPlayer.source.kind === "device" ? environmentId : threadKey}:${previewMiniPlayerSourceKey(miniPlayer.source)}`}
              threadRef={threadRef}
              miniPlayer={miniPlayer}
            />
          ) : null}
        </ChatCanvas>
      </div>
      {presence.present ? (
        <ChatRightPanel
          sheet={sheet}
          workspaceLayoutElement={layoutElement}
          widthStorageKey={`goat:preview-panel-width:${threadKey}`}
          sheetAnimationDurationMs={animationsActive ? durationMs : 0}
          onCloseSheet={actions.closePreviewPanelStable}
          open={open}
          keybindings={keybindings}
          getShortcutContext={getShortcutContext}
          maximized={maximized}
          layoutControls={
            open ? <div className="mr-px flex items-center">{toggleControls}</div> : null
          }
          surfaces={presence.value?.surfaces ?? []}
          environmentId={environmentId}
          activeSurfaceId={renderedSurface?.id ?? null}
          pendingSurfaceIds={NO_PENDING_SURFACES}
          previewSessions={previewState.sessions}
          desktopByTabId={previewState.desktopByTabId}
          previewRuntimeTabId={(tabId) =>
            previewRuntimeTabId(threadRef, previewState.serverEpoch, tabId)
          }
          terminalLabelsById={terminalLabelsById}
          onActivate={actions.activateRightPanelSurfaceStable}
          onCloseSurface={surfaceClose.closeSurface}
          onRenameDevice={(surfaceId, title) =>
            useRightPanelStore.getState().renameDevice(threadRef, surfaceId, title)
          }
          onCloseOtherSurfaces={surfaceClose.closeOtherSurfaces}
          onCloseSurfacesToRight={surfaceClose.closeSurfacesToRight}
          onCloseAllSurfaces={surfaceClose.closeAllSurfaces}
          onMoveSurface={actions.moveRightPanelSurfaceStable}
          onCopyFilePath={actions.copyRightPanelFilePathStable}
          onAddBrowser={() => actions.createBrowserSurface()}
          onAddBrowserInProfile={actions.createBrowserSurfaceStable}
          onDuplicateBrowser={actions.duplicateBrowserSurfaceStable}
          onAddTerminal={panelTerminals.addTerminalSurfaceStable}
          onAddDiff={notOffered}
          onAddFiles={notOffered}
          onAddPullRequest={notOffered}
          onAddPullRequests={notOffered}
          onAddDevice={actions.addDeviceSurfaceStable}
          browserAvailable={canOperatePreview && browserAvailable}
          terminalAvailable={project !== null && canOperateTerminal}
          diffAvailable={false}
          filesAvailable={false}
          pullRequestAvailable={false}
          pullRequestsAvailable={false}
          deviceAvailable
          offeredSurfaces={BOT_SURFACES}
        >
          <GoatBotPanelSurface
            surface={renderedSurface}
            threadRef={threadRef}
            visible={open}
            keybindings={keybindings}
            terminals={panelTerminals}
            onCloseSurface={surfaceClose.closeSurface}
          />
        </ChatRightPanel>
      ) : null}
    </div>
  );
}

function GoatBotPanelSurface(props: {
  readonly surface: RightPanelSurface | null;
  readonly threadRef: ScopedThreadRef;
  readonly visible: boolean;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly terminals: ReturnType<typeof usePanelTerminalActions>;
  readonly onCloseSurface: (surface: RightPanelSurface) => void;
}) {
  const { surface, threadRef, visible, terminals } = props;
  switch (surface?.kind) {
    case "preview":
      return (
        <Suspense fallback={null}>
          <PreviewPanel
            mode="embedded"
            threadRef={threadRef}
            tabId={surface.resourceId}
            visible={visible}
          />
        </Suspense>
      );
    case "terminal":
      return (
        <PersistentThreadTerminalPanel
          visible={visible}
          threadRef={threadRef}
          surface={surface}
          launchContext={null}
          keybindings={props.keybindings}
          onSplitTerminal={terminals.splitPanelTerminalStable}
          onSplitTerminalVertical={terminals.splitPanelTerminalVerticalStable}
          onNewTerminal={terminals.addTerminalSurfaceStable}
          onActiveTerminalChange={terminals.activatePanelTerminalStable}
          onCloseTerminal={terminals.closePanelTerminalStable}
        />
      );
    case "device":
      return (
        <Suspense fallback={null}>
          <DevicePanel
            mode="embedded"
            threadRef={threadRef}
            key={surface.id}
            surface={surface}
            visible={visible}
            onDismissSetup={() => {
              props.onCloseSurface(surface);
              useRightPanelStore.getState().show(threadRef);
            }}
          />
        </Suspense>
      );
    default:
      return null;
  }
}
