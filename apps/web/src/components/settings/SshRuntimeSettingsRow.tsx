import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  sshRuntimeBuildOrder,
  sshRuntimePhaseText,
  sshRuntimeRecoveryText,
  sshRuntimeStatusText,
  sshRuntimeTargetKey,
} from "@goat/client-runtime/state/sshRuntime";
import {
  buildSshKeyAuthInstructions,
  type DesktopSshEnvironmentTarget,
  type DesktopSshPreparationProgress,
  type EnvironmentId,
  type SshRuntimeUpdateMode,
} from "@goat/contracts";
import { useContext, useEffect, useRef, useState } from "react";

import { sshRuntime } from "~/state/sshRuntime";
import { useCheckForUpdateWhenHostIsNewer } from "../sidebar/newerHostUpdateCheck";
import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";

type SshRuntimeSettingsRowProps = {
  readonly target: DesktopSshEnvironmentTarget;
  readonly environmentId: EnvironmentId;
  readonly enabled: boolean;
  readonly pendingAdd?: boolean;
  readonly connecting?: boolean;
  readonly preparationInSubtitle?: boolean;
  readonly preparationProgress?: Pick<DesktopSshPreparationProgress, "phase">;
  readonly originLabel?: string;
  readonly onRetry?: () => void;
  /** Starts a connection retry that is waiting on its backoff, alongside the status refresh. */
  readonly onRefreshConnection?: (() => void) | undefined;
  readonly onReviewTrust?: () => void;
  readonly onOpenApproval?: () => void;
};

/** Reset local actions when the saved route changes or is switched off. */
export function SshRuntimeSettingsRow(props: SshRuntimeSettingsRowProps) {
  return (
    <SshRuntimeSettingsRowContent
      key={`${sshRuntimeTargetKey(props)}:${props.enabled}`}
      {...props}
    />
  );
}

/** Runtime actions always address the original saved route, even while it is offline. */
function SshRuntimeSettingsRowContent({
  target,
  environmentId,
  enabled,
  onRetry,
  onRefreshConnection,
  originLabel,
  pendingAdd,
  connecting,
  preparationProgress,
  preparationInSubtitle,
  onReviewTrust,
  onOpenApproval,
}: SshRuntimeSettingsRowProps) {
  const registry = useContext(RegistryContext);
  const { alias, hostname, username, port } = target;
  const [input] = useState(() => ({ environmentId, target: { alias, hostname, username, port } }));
  const result = useAtomValue(sshRuntime.statusAtom(input));
  const status = result?.status;
  useCheckForUpdateWhenHostIsNewer([status?.runtimeVersion]);
  const phase =
    preparationProgress !== undefined
      ? preparationProgress.phase
      : status?.state === "preparing"
        ? (status.phase ?? "connecting")
        : null;
  const phaseText = enabled && phase !== null ? sshRuntimePhaseText(phase) : null;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const lifetime = useRef(0);

  useEffect(() => {
    lifetime.current += 1;
    if (enabled) void sshRuntime.refresh.run(registry, input);
    else {
      sshRuntime.forget(registry, input);
    }
    return () => {
      lifetime.current += 1;
      sshRuntime.invalidate(registry, input);
    };
  }, [registry, input, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const state = result?.status?.state;
    const delay =
      connecting || busy || state === "preparing"
        ? 1_000
        : state === "update_waiting"
          ? 10_000
          : null;
    if (delay === null) return;
    const timer = setTimeout(() => void sshRuntime.refresh.run(registry, input), delay);
    return () => clearTimeout(timer);
  }, [registry, input, result, enabled, busy, connecting]);

  // A connection attempt that ended (a Retry, or a reconnect) decided the runtime's state; read it.
  const wasConnecting = useRef(connecting);
  useEffect(() => {
    if (wasConnecting.current && !connecting && enabled)
      void sshRuntime.refresh.run(registry, input);
    wasConnecting.current = connecting;
  }, [registry, input, enabled, connecting]);

  const update = async (mode: SshRuntimeUpdateMode) => {
    if (!enabled || busy) return;
    const generation = lifetime.current;
    setBusy(true);
    setCommandError(null);
    const outcome = await sshRuntime.update.run(registry, { ...input, mode });
    if (generation === lifetime.current) {
      setBusy(false);
      if (outcome._tag === "Failure")
        setCommandError(
          `Couldn't update the runtime on ${target.alias || target.hostname}. Try again.`,
        );
    }
  };
  const canUpdate =
    !connecting &&
    status !== undefined &&
    (status.state === "update_waiting" ||
      status.state === "failed" ||
      status.state === "stopped" ||
      (status.state === "ready" && (sshRuntimeBuildOrder(status) ?? 0) < 0));
  const authInstructions =
    status?.keyAuth ??
    (status?.state === "auth_failed" && originLabel
      ? buildSshKeyAuthInstructions({
          originLabel,
          host: target.alias || target.hostname,
          user: target.username ?? "your SSH user",
          port: target.port ?? 22,
          ...(status.publicKey ? { publicKey: status.publicKey, generatedKey: true } : {}),
        })
      : null);
  const recovery =
    (result?.kind === "error" && result.code === "host_unreachable") ||
    (status?.state === "untrusted" && onReviewTrust)
      ? null
      : (authInstructions?.instruction ??
        (status === undefined ? null : sshRuntimeRecoveryText(status)));
  const fix = result?.kind === "error" ? result.fix : status?.failure?.fix;
  const copyCommand = authInstructions?.command ?? fix?.command;
  const showRetry =
    onRetry !== undefined &&
    (status?.state === "auth_failed" || result?.kind === "error" || status?.state === "failed");
  const publicKey = status?.keyAuth?.publicKey ?? status?.publicKey;
  const copyText = publicKey ?? copyCommand;
  const errorMessage =
    result?.kind === "error"
      ? result.code === "host_unreachable"
        ? `Can't reach ${target.alias || target.hostname}. Check that it's running and reachable, then try again.`
        : result.message
      : null;

  return (
    <div className="mt-1 max-w-lg space-y-1 text-xs text-muted-foreground">
      {!preparationInSubtitle ? (
        <p role="status" aria-live="polite">
          {phaseText}
        </p>
      ) : null}
      {status ? (
        <div>
          {pendingAdd && status.state !== "preparing" && phaseText === null ? (
            <p>{sshRuntimeStatusText(status)}</p>
          ) : null}
          {recovery && status.state !== "trust_pending" && phaseText === null ? (
            <p>
              {recovery}
              {status.state === "auth_failed" ? " GOAT connects with SSH keys only." : ""}
            </p>
          ) : null}
          {status.state === "trust_pending" ? (
            onOpenApproval ? (
              <Button variant="link" size="xs" onClick={onOpenApproval}>
                Open the host approval card
              </Button>
            ) : (
              <p>Review the request in its original thread.</p>
            )
          ) : null}
        </div>
      ) : null}
      {errorMessage && phaseText === null ? <p role="alert">{errorMessage}</p> : null}
      {result?.kind === "error" &&
      result.code !== "host_unreachable" &&
      fix &&
      recovery === null &&
      phaseText === null ? (
        <p>{fix.instruction}</p>
      ) : null}
      {commandError && result?.kind !== "error" && phaseText === null ? (
        <p role="alert">{commandError}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {status?.state === "untrusted" && onReviewTrust ? (
          <Button variant="outline" size="xs" disabled={busy} onClick={onReviewTrust}>
            Review fingerprint
          </Button>
        ) : null}
        {showRetry ? (
          <Button variant="outline" size="xs" disabled={busy} onClick={onRetry}>
            Retry
          </Button>
        ) : null}
        {canUpdate ? (
          status?.state === "update_waiting" ? (
            <Button
              variant="outline"
              size="xs"
              disabled={!enabled || busy}
              onClick={() => setConfirmOpen(true)}
            >
              Update now
            </Button>
          ) : (
            <Button
              variant="outline"
              size="xs"
              disabled={!enabled || busy}
              onClick={() => void update("when_idle")}
            >
              Update runtime
            </Button>
          )
        ) : null}
        {!showRetry ? (
          <Button
            variant="ghost"
            size="xs"
            disabled={!enabled || busy}
            onClick={() => {
              void sshRuntime.refresh.run(registry, input);
              onRefreshConnection?.();
            }}
          >
            Refresh status
          </Button>
        ) : null}
        {copyText && !(result?.kind === "error" && result.code === "host_unreachable") ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={() =>
              void navigator.clipboard
                .writeText(copyText)
                .catch(() =>
                  setCommandError(
                    publicKey
                      ? "Could not copy the public key. Try again."
                      : "Could not copy the command. Try again.",
                  ),
                )
            }
          >
            {publicKey ? "Copy public key" : "Copy setup command"}
          </Button>
        ) : null}
      </div>
      <AlertDialog
        open={confirmOpen && enabled && status?.state === "update_waiting"}
        onOpenChange={setConfirmOpen}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Update now</AlertDialogTitle>
            <AlertDialogDescription>
              Running agent work gets up to a minute to finish, then continues on the new version.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              disabled={!enabled || busy || status?.state !== "update_waiting"}
              onClick={() => {
                setConfirmOpen(false);
                void update("now");
              }}
            >
              Update now
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
