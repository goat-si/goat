import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  sshRuntimeRecoveryText,
  sshRuntimeStatusText,
  sshRuntimeTargetKey,
} from "@goat/client-runtime/state/sshRuntime";
import type {
  DesktopSshEnvironmentTarget,
  EnvironmentId,
  SshRuntimeUpdateMode,
} from "@goat/contracts";
import { useContext, useEffect, useMemo, useRef, useState } from "react";

import { sshRuntime } from "~/state/sshRuntime";
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
}: SshRuntimeSettingsRowProps) {
  const registry = useContext(RegistryContext);
  const { alias, hostname, username, port } = target;
  const input = useMemo(
    () => ({ environmentId, target: { alias, hostname, username, port } }),
    [environmentId, alias, hostname, username, port],
  );
  const result = useAtomValue(sshRuntime.statusAtom(input));
  const status = result?.status;
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
      busy || state === "preparing" ? 1_000 : state === "update_waiting" ? 10_000 : null;
    if (delay === null) return;
    const timer = setTimeout(() => void sshRuntime.refresh.run(registry, input), delay);
    return () => clearTimeout(timer);
  }, [registry, input, result, enabled, busy]);

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
    status !== undefined &&
    (status.state === "update_waiting" ||
      status.state === "failed" ||
      status.state === "stopped" ||
      (status.state === "ready" && status.runtimeVersion !== status.requestedVersion));
  const recovery = status === undefined ? null : sshRuntimeRecoveryText(status);
  const fix = result?.kind === "error" ? result.fix : status?.failure?.fix;
  const errorMessage =
    result?.kind === "error"
      ? result.code === "host_unreachable"
        ? `Can't reach ${target.alias || target.hostname}. Check that it's running and reachable, then try again.`
        : result.message
      : null;

  return (
    <div className="mt-1 max-w-lg space-y-1 text-xs text-muted-foreground">
      {status ? (
        <div role="status">
          {status.state === "preparing" ? <p>{`Setting up GOAT on ${status.host}…`}</p> : null}
          {status.state === "preparing" ? <p>{sshRuntimeStatusText(status)}</p> : null}
          {recovery ? <p>{recovery}</p> : null}
        </div>
      ) : null}
      {errorMessage ? <p role="alert">{errorMessage}</p> : null}
      {result?.kind === "error" &&
      result.code !== "host_unreachable" &&
      fix &&
      recovery === null ? (
        <p>{fix.instruction}</p>
      ) : null}
      {commandError && result?.kind !== "error" ? <p role="alert">{commandError}</p> : null}
      <div className="flex items-center gap-2">
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
        <Button
          variant="ghost"
          size="xs"
          disabled={!enabled || busy}
          onClick={() => void sshRuntime.refresh.run(registry, input)}
        >
          Refresh status
        </Button>
        {fix?.command ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void navigator.clipboard.writeText(fix.command!)}
          >
            Copy command
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
