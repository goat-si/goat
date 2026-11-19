import { gtFallback, useGT } from "gt-react";
import type { DesktopBridge, DesktopUpdateState } from "@goat/contracts";
import { TriangleAlertIcon } from "~/components/solar";
import { type ComponentProps, useId, useRef, useState } from "react";

import { flushSync } from "react-dom";
import { settlePromise, squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import { isElectron } from "../../env";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { cn } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  canCheckForUpdate,
  getDesktopUpdateDisabledReason,
  type DesktopUpdateTranslate,
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateInstallError,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateCheckError,
  getDesktopUpdateDownloadedVersion,
  getDesktopUpdateIdleTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  translateDesktopUpdateMessage,
} from "../desktopUpdate.logic";
import {
  downloadLocalUpdate,
  showDesktopUpdateDownloadedToast,
  toastUpdateError,
} from "../desktopUpdate.toast";
import { useCheckProviderUpdates } from "../ProviderUpdatesAction";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Popover, PopoverCreateHandle, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  DesktopUpdateStatusIcon,
  type DesktopUpdateStatusIconState,
  shouldContinueDesktopUpdateCheckAnimation,
  shouldShowDesktopUpdateCheckIcon,
} from "./DesktopUpdateStatusIcon";
import { SidebarUpdateReleaseNotes } from "./SidebarUpdateReleaseNotes";
import { SidebarUpdateCapsule } from "./SidebarUpdateCapsule";
import { type UpdateDialogSelection, UpdateEverythingDialog } from "./UpdateEverythingDialog";
import {
  describeUpdateTabs,
  type UpdateEverythingRun,
  type UpdateRunLocalState,
} from "./updateEverything.logic";
import {
  clearSavedUpdateEverythingResult,
  saveUpdateEverythingResult,
  useUpdateEverythingRun,
} from "./updateEverythingRun";
import { type ReportLocalUpdateError, useUpdateEverything } from "./useUpdateEverything";

type SidebarUpdatePopoverChangeDetails = Parameters<
  NonNullable<ComponentProps<typeof Popover>["onOpenChange"]>
>[1];
type SidebarUpdatePopoverHandle = ReturnType<typeof PopoverCreateHandle>;

function shouldUseSidebarUpdateReleaseNotesPopover(
  showUpdateDetails: boolean,
  state: DesktopUpdateState | null,
): boolean {
  return showUpdateDetails && (state?.releaseNotes.length ?? 0) > 0;
}

function handleSidebarUpdateReleaseNotesPopoverOpenChange(
  _open: boolean,
  details: Pick<SidebarUpdatePopoverChangeDetails, "reason" | "cancel">,
): void {
  if (details.reason === "trigger-press") details.cancel();
}

function openSidebarUpdateReleaseNotesPopoverOnForwardTab(
  event: { readonly key: string; readonly shiftKey: boolean },
  handle: Pick<SidebarUpdatePopoverHandle, "open">,
  triggerId: string,
): void {
  if (event.key !== "Tab" || event.shiftKey) return;
  // Hover-open popovers do not manage focus. Promote this one before native Tab runs.
  flushSync(() => handle.open(triggerId));
}

function resolveSidebarUpdatePresentation({
  action,
  showsEverything,
  run,
  isDownloading,
  showCheckIcon,
  checkFailed,
}: {
  readonly action: ReturnType<typeof resolveDesktopUpdateButtonAction>;
  readonly showsEverything: boolean;
  readonly run: UpdateEverythingRun | null;
  readonly isDownloading: boolean;
  readonly showCheckIcon: boolean;
  readonly checkFailed: boolean;
}) {
  const showUpdateDetails = action !== "none" || showsEverything || run !== null || isDownloading;
  const iconStatus: DesktopUpdateStatusIconState = showCheckIcon
    ? "checking"
    : isDownloading
      ? "downloading"
      : run !== null
        ? run.localVersion !== null && action === "install"
          ? "downloaded"
          : "everything"
        : showsEverything
          ? "everything"
          : action === "install"
            ? "downloaded"
            : action === "download"
              ? "available"
              : checkFailed
                ? "check-failed"
                : "idle";

  return {
    iconStatus,
    showUpdateDetails,
    showUpdateIconState: showUpdateDetails && !showCheckIcon,
  } as const;
}

/**
 * The first tooltip line, naming what the button updates: this GOAT app, the
 * providers and servers on connected machines, or both. One button covers all
 * of them, so the icon alone cannot say which.
 */
export function resolveSidebarUpdateHeading(
  {
    local,
    remote,
    run,
    checking,
  }: {
    /** This app has an update to download, downloading, or to install. */
    readonly local: boolean;
    /** Remote work the button would run now, or null when none. */
    readonly remote: { readonly providers: boolean; readonly servers: boolean } | null;
    readonly run: Pick<UpdateEverythingRun, "localVersion" | "machines"> | null;
    readonly checking: boolean;
  },
  gt: DesktopUpdateTranslate = gtFallback,
): string {
  if (run !== null) {
    if (run.localVersion !== null) return gt("Updating everything");
    const providers = run.machines.some((machine) => machine.updatesProviders);
    const servers = run.machines.some(
      (machine) => machine.server !== null || machine.sshRuntime !== null,
    );
    if (providers && !servers) return gt("Updating providers");
    if (servers && !providers) return gt("Updating servers");
    return gt("Updating providers and servers");
  }
  if (remote !== null) {
    if (local) return gt("Update everything");
    if (remote.providers && !remote.servers) return gt("Provider updates");
    if (remote.servers && !remote.providers) return gt("Server updates");
    return gt("Provider and server updates");
  }
  if (local) return gt("GOAT app update");
  return checking ? gt("Checking for GOAT app updates…") : gt("Check for GOAT app updates");
}

export type SidebarUpdatePlacement = "footer" | "rail";

export function SidebarUpdateArchitectureWarning() {
  return isElectron ? <SidebarUpdateArchitectureWarningContent /> : null;
}

function SidebarUpdateArchitectureWarningContent() {
  const gt = useGT();
  const state = useDesktopUpdateState();
  const visible = shouldShowArm64IntelBuildWarning(state);
  const description = state && visible ? getArm64IntelBuildWarningDescription(state, gt) : null;

  if (!visible || !description) return null;

  return (
    <Alert variant="warning">
      <TriangleAlertIcon />
      <AlertTitle>{gt("Intel build on Apple Silicon")}</AlertTitle>
      <AlertDescription>{description}</AlertDescription>
    </Alert>
  );
}

export async function installLocalUpdate(
  bridge: DesktopBridge,
  gt: DesktopUpdateTranslate,
  reportError: ReportLocalUpdateError = toastUpdateError,
): Promise<boolean> {
  try {
    const result = await bridge.installUpdate();
    const actionError = getDesktopUpdateInstallError(result);
    if (actionError) {
      reportError(gt("Could not install update"), actionError);
      return false;
    }
    if (!result.accepted) showDesktopUpdateDownloadedToast(bridge, result.state, gt);
    return result.accepted;
  } catch (error) {
    reportError(
      gt("Could not install update"),
      error instanceof Error ? error.message : gt("An unexpected error occurred."),
    );
    return false;
  }
}

export function SidebarUpdatePill({
  placement = "footer",
}: {
  placement?: SidebarUpdatePlacement;
}) {
  return <SidebarUpdateControl placement={placement} />;
}

function SidebarUpdateControl({ placement }: { placement: SidebarUpdatePlacement }) {
  const gt = useGT();
  const inRail = placement === "rail";
  const state = useDesktopUpdateState();
  const [isActionPending, setIsActionPending] = useState(false);
  const [providerCheck, setProviderCheck] = useState<"button" | "dialog" | null>(null);
  const [providerCheckFailures, setProviderCheckFailures] = useState<ReadonlyArray<string>>([]);
  const isCheckingProviders = providerCheck === "button";
  const [isConfirmingEverything, setIsConfirmingEverything] = useState(false);
  const [checkAnimationKey, setCheckAnimationKey] = useState(0);
  const [releaseNotesPopoverHandle] = useState(() => PopoverCreateHandle());
  const suppressReleaseNotesFocusOpen = useRef(false);
  const releaseNotesPopupRef = useRef<HTMLDivElement>(null);
  const releaseNotesTriggerId = useId();
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");

  const updateStatus = state?.status;
  const [isCheckAnimationLatched, setIsCheckAnimationLatched] = useState(
    () => !prefersReducedMotion && updateStatus === "checking",
  );
  const [latchInputs, setLatchInputs] = useState({ prefersReducedMotion, updateStatus });
  if (
    latchInputs.prefersReducedMotion !== prefersReducedMotion ||
    latchInputs.updateStatus !== updateStatus
  ) {
    setLatchInputs({ prefersReducedMotion, updateStatus });
    if (prefersReducedMotion) {
      setIsCheckAnimationLatched(false);
    } else if (updateStatus === "checking") {
      setIsCheckAnimationLatched(true);
    }
  }

  const action = state ? resolveDesktopUpdateButtonAction(state) : "none";
  const isDownloading = state?.status === "downloading";
  const localUpdateVersion =
    state && action !== "none" ? getDesktopUpdateDownloadedVersion(state) : null;
  const everything = useUpdateEverything(localUpdateVersion, state?.channel ?? null);
  const checkProviderUpdates = useCheckProviderUpdates();
  const runsEverything = everything.hasUpdates && !isDownloading;
  const run = useUpdateEverythingRun();
  const isRunningEverything = run !== null;
  const showCheckIcon = shouldShowDesktopUpdateCheckIcon({
    isAnimationLatched: isCheckAnimationLatched,
    isChecking: state?.status === "checking" || isCheckingProviders,
    prefersReducedMotion,
  });
  const { iconStatus, showUpdateDetails, showUpdateIconState } = resolveSidebarUpdatePresentation({
    action,
    showsEverything: runsEverything,
    run,
    isDownloading,
    showCheckIcon,
    checkFailed: getDesktopUpdateCheckError(state) !== null,
  });
  const idleTooltip =
    !showUpdateDetails && !showCheckIcon && !runsEverything && !run
      ? getDesktopUpdateIdleTooltip(state, gt)
      : null;
  const heading =
    idleTooltip?.title ??
    resolveSidebarUpdateHeading(
      {
        local: action !== "none" || isDownloading,
        remote: runsEverything ? everything.remote : null,
        run,
        checking: showCheckIcon,
      },
      gt,
    );
  const detail = runsEverything
    ? describeUpdateTabs(everything.counts)
    : showUpdateDetails
      ? state
        ? getDesktopUpdateButtonTooltip(state, gt)
        : gt("Update available")
      : null;
  const installationDetail =
    (state?.installationNotice
      ? translateDesktopUpdateMessage(state.installationNotice, gt)
      : null) ??
    idleTooltip?.detail ??
    (state && !state.enabled && state.message
      ? translateDesktopUpdateMessage(state.message, gt)
      : null);
  // A failed automatic download raises no toast, so the button is where its reason shows.
  const downloadError =
    state?.enabled && state.errorContext === "download" && state.message
      ? translateDesktopUpdateMessage(state.message, gt)
      : null;
  const tooltip = [
    heading,
    detail,
    installationDetail && !detail?.includes(installationDetail) ? installationDetail : null,
    downloadError,
  ]
    .filter(Boolean)
    .join("\n");
  const ariaLabel = idleTooltip?.detail
    ? `${heading}: ${idleTooltip.detail}`
    : detail === null
      ? heading
      : `${heading}: ${detail.split("\n")[0]}`;
  const disabled = showCheckIcon
    ? true
    : runsEverything
      ? false
      : showUpdateDetails
        ? isDesktopUpdateButtonDisabled(state)
        : !canCheckForUpdate(state);
  const isInteractionDisabled = disabled || isActionPending || isRunningEverything;
  const showReleaseNotesPopover =
    !isRunningEverything && shouldUseSidebarUpdateReleaseNotesPopover(showUpdateDetails, state);

  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const [releaseNotesTriggerFocusVisible, setReleaseNotesTriggerFocusVisible] = useState(false);
  // Release notes close when they stop applying, and open when they start
  // applying while the trigger already holds keyboard focus.
  const [releaseNotesShownBefore, setReleaseNotesShownBefore] = useState(showReleaseNotesPopover);
  if (releaseNotesShownBefore !== showReleaseNotesPopover) {
    setReleaseNotesShownBefore(showReleaseNotesPopover);
    setReleaseNotesOpen(showReleaseNotesPopover && releaseNotesTriggerFocusVisible);
  }

  const handleAction = async () => {
    const bridge = window.desktopBridge;
    if (isInteractionDisabled) return;

    if (runsEverything) {
      setIsConfirmingEverything(true);
      // Machines that still cache an older latest version add their rows while the dialog is open.
      setProviderCheck("dialog");
      setProviderCheckFailures([]);
      void checkProviderUpdates({ quiet: true })
        .then(setProviderCheckFailures)
        .finally(() => setProviderCheck(null));
      return;
    }

    if (!bridge || !state) return;
    setIsActionPending(true);

    if (action === "download") {
      void downloadLocalUpdate(bridge, gt, { notifyDownloaded: true }).finally(() =>
        setIsActionPending(false),
      );
      return;
    }

    if (action === "install") {
      let confirmed = false;
      try {
        confirmed = await ensureLocalApi().dialogs.confirm(
          getDesktopUpdateInstallConfirmationMessage(state, gt),
          { initialFocus: "confirm" },
        );
      } catch (error) {
        setIsActionPending(false);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Could not confirm update"),
            description: error instanceof Error ? error.message : gt("Update confirmation failed."),
          }),
        );
        return;
      }
      if (!confirmed) {
        setIsActionPending(false);
        return;
      }
      void installLocalUpdate(bridge, gt).finally(() => setIsActionPending(false));
      return;
    }

    if (!prefersReducedMotion) {
      setIsCheckAnimationLatched(true);
      setCheckAnimationKey((key) => key + 1);
    }
    const appCheck = bridge
      .checkForUpdate()
      .then((result) => {
        if (result.checked) return;
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Could not check for updates"),
            description:
              getDesktopUpdateDisabledReason(result.state, gt) ??
              result.state.message ??
              gt("Automatic updates are not available in this build."),
          }),
        );
      })
      .catch((error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Could not check for updates"),
            description: error instanceof Error ? error.message : gt("Update check failed."),
          }),
        );
      });
    setProviderCheck("button");
    const providersChecked = checkProviderUpdates().finally(() => setProviderCheck(null));
    void Promise.allSettled([appCheck, providersChecked]).then(() => setIsActionPending(false));
  };

  const runEverything = async ({ rows }: UpdateDialogSelection) => {
    const bridge = window.desktopBridge;
    setIsConfirmingEverything(false);
    setIsActionPending(true);
    const result = await settlePromise(() =>
      everything.runUpdates(rows, {
        ...(bridge && action === "download"
          ? {
              downloadLocal: (reportError) =>
                downloadLocalUpdate(bridge, gt, { notifyDownloaded: false, reportError }),
            }
          : {}),
        ...(bridge && action !== "none"
          ? { installLocal: (reportError) => installLocalUpdate(bridge, gt, reportError) }
          : {}),
      }),
    );
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not update everything"),
          description: error instanceof Error ? error.message : gt("An unexpected error occurred."),
        }),
      );
    }
    setIsActionPending(false);
  };

  const handleCheckAnimationIteration = () => {
    setIsCheckAnimationLatched(
      shouldContinueDesktopUpdateCheckAnimation({
        isChecking: state?.status === "checking" || isCheckingProviders,
        prefersReducedMotion,
      }),
    );
  };

  if (!isElectron && !runsEverything && !isRunningEverything) return null;

  const renderStatusIcon = (size: "sm" | "md") => (
    <DesktopUpdateStatusIcon
      key={showCheckIcon ? checkAnimationKey : iconStatus}
      downloadPercent={state?.downloadPercent ?? null}
      isCheckAnimating={showCheckIcon && !prefersReducedMotion}
      onCheckAnimationIteration={handleCheckAnimationIteration}
      size={size}
      status={iconStatus}
    />
  );
  const statusIcon = renderStatusIcon("sm");
  const controlIcon = inRail ? renderStatusIcon("md") : statusIcon;
  // An icon alone read as "check for updates" while a downloaded update waited for
  // busy backends, so the footer names the action. The rail has no room for text.
  const restartLabel = !inRail && iconStatus === "downloaded" ? gt("Restart to update") : null;
  const confirmDialog = (
    <UpdateEverythingDialog
      open={isConfirmingEverything}
      onOpenChange={setIsConfirmingEverything}
      everything={everything}
      onConfirm={(selection) => void runEverything(selection)}
      checking={providerCheck === "dialog"}
      checkFailures={providerCheckFailures}
    />
  );

  if (run !== null) {
    const local: UpdateRunLocalState =
      run.localVersion === null
        ? null
        : state?.status === "downloading"
          ? { status: "downloading", percent: state.downloadPercent }
          : { status: "waiting" };
    const runningControl = (
      <>
        <SidebarUpdateCapsule
          run={run}
          local={local}
          icon={statusIcon}
          {...(run.localVersion === null && action === "install" && window.desktopBridge
            ? {
                onRestart: async () => {
                  saveUpdateEverythingResult({
                    localVersion: localUpdateVersion,
                    updatedServers: 0,
                    updatedProviders: 0,
                    failures: [],
                    restarting: [],
                  });
                  if (!(await installLocalUpdate(window.desktopBridge!, gt))) {
                    clearSavedUpdateEverythingResult();
                  }
                },
              }
            : {})}
        />
        {confirmDialog}
      </>
    );
    return inRail ? (
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label={heading}
              className="inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-sidebar-control-surface text-sidebar-foreground outline-hidden ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
            />
          }
        >
          {controlIcon}
        </PopoverTrigger>
        <PopoverPopup side="right" align="end" padding="compact" width="sm">
          <div className="flex min-w-0">{runningControl}</div>
        </PopoverPopup>
      </Popover>
    ) : (
      <SidebarMenuItem className="@container/sidebar-update ml-auto flex min-w-8 flex-1">
        {runningControl}
      </SidebarMenuItem>
    );
  }

  const updateButton = (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-disabled={isInteractionDisabled || undefined}
      className={cn(
        "inline-flex items-center justify-center outline-hidden ring-ring transition-colors focus-visible:ring-2 focus-visible:ring-inset",
        // The rail's accent fill means "current page", so waiting updates keep the control fill.
        inRail
          ? "size-10 shrink-0 rounded-lg"
          : restartLabel
            ? "h-8 gap-1.5 rounded-full pr-3 pl-2 text-xs font-medium"
            : "size-8 rounded-full",
        isInteractionDisabled ? "cursor-not-allowed" : "cursor-pointer",
        showUpdateIconState
          ? cn(
              "bg-sidebar-control-surface text-sidebar-foreground",
              !isInteractionDisabled && (inRail ? "hover:bg-accent" : "hover:bg-sidebar-row-hover"),
            )
          : inRail
            ? cn(
                "text-sidebar-muted-foreground",
                !isInteractionDisabled && "hover:bg-accent hover:text-accent-foreground",
              )
            : cn(
                "text-(--sidebar-icon-color)",
                !isInteractionDisabled &&
                  "hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
              ),
        disabled && !showUpdateIconState && "opacity-60",
      )}
      onClick={handleAction}
      onBlur={() => {
        suppressReleaseNotesFocusOpen.current = false;
        setReleaseNotesTriggerFocusVisible(false);
      }}
      onFocus={(event) => {
        const focusVisible = event.currentTarget.matches(":focus-visible");
        setReleaseNotesTriggerFocusVisible(focusVisible);
        if (!showReleaseNotesPopover || !focusVisible) return;
        if (suppressReleaseNotesFocusOpen.current) {
          suppressReleaseNotesFocusOpen.current = false;
          return;
        }
        flushSync(() => releaseNotesPopoverHandle.open(releaseNotesTriggerId));
      }}
      onKeyDown={(event) => {
        if (!showReleaseNotesPopover) return;
        openSidebarUpdateReleaseNotesPopoverOnForwardTab(
          event,
          releaseNotesPopoverHandle,
          releaseNotesTriggerId,
        );
      }}
    >
      {controlIcon}
      {restartLabel ? <span className="whitespace-nowrap">{restartLabel}</span> : null}
    </button>
  );

  const control = (
    <>
      <Popover
        handle={releaseNotesPopoverHandle}
        open={releaseNotesOpen && showReleaseNotesPopover}
        triggerId={releaseNotesTriggerId}
        onOpenChange={(open, details) => {
          if (open && !showReleaseNotesPopover) {
            details.cancel();
            return;
          }
          handleSidebarUpdateReleaseNotesPopoverOpenChange(open, details);
          if (!details.isCanceled) setReleaseNotesOpen(open);
        }}
      >
        <Tooltip disabled={showReleaseNotesPopover}>
          <TooltipTrigger
            id={releaseNotesTriggerId}
            render={
              <PopoverTrigger
                {...(!showReleaseNotesPopover
                  ? {
                      "aria-controls": undefined,
                      "aria-expanded": undefined,
                      "aria-haspopup": undefined,
                    }
                  : {})}
                closeDelay={150}
                handle={releaseNotesPopoverHandle}
                id={releaseNotesTriggerId}
                openOnHover={showReleaseNotesPopover}
                render={updateButton}
              />
            }
          />
          {!showReleaseNotesPopover ? (
            <TooltipPopup
              align="center"
              side={inRail ? "right" : "top"}
              variant={showUpdateDetails ? "glass" : "default"}
            >
              {idleTooltip?.detail ? (
                <div className="text-left">
                  <div className="font-medium">{idleTooltip.title}</div>
                  <div className="text-muted-foreground">{idleTooltip.detail}</div>
                </div>
              ) : (
                <span className="whitespace-pre-line">{tooltip}</span>
              )}
            </TooltipPopup>
          ) : null}
        </Tooltip>
        {showReleaseNotesPopover && state ? (
          <PopoverPopup
            align={inRail ? "end" : "center"}
            aria-label="Update release notes"
            initialFocus={false}
            onKeyDownCapture={(event) => {
              if (
                event.key === "Escape" &&
                releaseNotesPopupRef.current?.contains(document.activeElement)
              ) {
                suppressReleaseNotesFocusOpen.current = true;
              }
            }}
            ref={releaseNotesPopupRef}
            side={inRail ? "right" : "top"}
            tooltipStyle
          >
            <SidebarUpdateReleaseNotes
              shell={window.desktopBridge}
              state={state}
              tooltip={tooltip}
            />
          </PopoverPopup>
        ) : null}
      </Popover>
      {confirmDialog}
    </>
  );

  return inRail ? (
    <div className="flex shrink-0">{control}</div>
  ) : (
    <SidebarMenuItem className="ml-auto shrink-0">{control}</SidebarMenuItem>
  );
}
