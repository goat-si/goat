import type { CuaHostStatus, DesktopCuaVerification } from "@goat/contracts";
import { useRef, useState } from "react";

import { CircleAlertIcon, CircleCheckIcon } from "~/components/solar";
import { MacAccessibilityIcon, MacScreenRecordingIcon } from "../Icons";
import { PermissionChecklist, PermissionContinueButton } from "../permissions/PermissionChecklist";
import { usePermissionStatus } from "../permissions/usePermissionStatus";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  CUA_PERMISSIONS,
  CUA_WAYLAND_NOTE,
  cuaHostRequirements,
  cuaVerificationRows,
  type CuaPermission,
} from "./CuaSetupDialog.logic";

export function CuaSetupDialog({
  enabled,
  hostLabel,
  status,
  localMac,
  onCheck,
  onAllow,
  onEnable,
  onVerify,
  onClose,
}: {
  enabled: boolean;
  hostLabel: string;
  status: CuaHostStatus;
  /** This desktop runs the host, so it can grant macOS permissions and prove them. */
  localMac: boolean;
  onCheck: (permission: CuaPermission) => Promise<boolean>;
  onAllow: (permission: CuaPermission) => Promise<void>;
  /** Turns the setting on; resolves to an error message when it could not be saved. */
  onEnable: () => Promise<string | null>;
  onVerify: () => Promise<DesktopCuaVerification>;
  onClose: (outcome: "enabled" | "dismissed") => void;
}) {
  const [busy, setBusy] = useState<"allow" | "enable" | "verify" | null>(null);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [isOn, setIsOn] = useState(enabled);
  const [verification, setVerification] = useState<DesktopCuaVerification | null>(null);
  const permission = usePermissionStatus(
    async () => ({
      accessibility: await onCheck("accessibility"),
      "screen-recording": await onCheck("screen-recording"),
    }),
    { accessibility: false, "screen-recording": false },
    localMac && busy === null && verification?.verified !== true,
  );
  const granted = !localMac || permission.isReady(CUA_PERMISSIONS);

  const run = async (kind: "allow" | "enable" | "verify", action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(kind);
    setError(null);
    const settle = () => {
      pending.current = false;
      setBusy(null);
    };
    // Promise handlers instead of try/finally, which React Compiler cannot optimize.
    await action().then(settle, (cause: unknown) => {
      settle();
      setError(cause instanceof Error ? cause.message : "Something went wrong. Try again.");
    });
  };
  const allow = (target: CuaPermission) =>
    run("allow", async () => {
      await onAllow(target).catch(() =>
        setError("Could not open System Settings. Try Allow again."),
      );
    });
  const verify = () =>
    run("verify", async () => {
      setVerification(
        await onVerify().catch(() => ({
          verified: false,
          steps: [
            {
              id: "restart" as const,
              ok: false,
              detail: "Could not reach computer use. Try again.",
            },
          ],
        })),
      );
    });
  const turnOn = async () => {
    let saved = false;
    await run("enable", async () => {
      const failure = await onEnable();
      if (failure === null) {
        saved = true;
        setIsOn(true);
      } else setError(failure);
    });
    if (!saved) return;
    // Only the Mac running the host can prove its grants; elsewhere the switch is the result.
    if (localMac) await verify();
    else onClose("enabled");
  };

  const rows = verification ? cuaVerificationRows(verification) : null;
  const verified = verification?.verified === true;
  const close = () => {
    if (!pending.current) onClose(isOn ? "enabled" : "dismissed");
  };

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogPopup showCloseButton={busy === null}>
        <DialogHeader>
          <DialogTitle>
            {verified ? "Computer use is ready" : `Let agents use ${hostLabel}`}
          </DialogTitle>
          <DialogDescription>
            {verified
              ? "From their next turn, agents can see and use apps on this Mac."
              : `Agents can see and use apps on ${hostLabel} in the background, without taking over your cursor. They get the computer use tools from their next turn.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-3 text-sm">
            {localMac && !verified ? (
              <PermissionChecklist
                busy={busy !== null}
                permissions={[
                  {
                    id: "accessibility",
                    icon: <MacAccessibilityIcon className="size-8 shrink-0 drop-shadow-sm" />,
                    title: "Accessibility",
                    description: "Click, type, and read controls in other apps.",
                    granted: permission.status.accessibility,
                    onAllow: () => void allow("accessibility"),
                  },
                  {
                    id: "screen-recording",
                    icon: <MacScreenRecordingIcon className="size-8 shrink-0 drop-shadow-sm" />,
                    title: "Screen Recording",
                    description: "See windows to decide what to do next.",
                    granted: permission.status["screen-recording"],
                    onAllow: () => void allow("screen-recording"),
                  },
                ]}
              />
            ) : null}
            {!localMac ? (
              <p className="text-muted-foreground">
                {cuaHostRequirements(status.platform, hostLabel)}
              </p>
            ) : null}
            {status.wayland ? <p className="text-muted-foreground">{CUA_WAYLAND_NOTE}</p> : null}
            {rows ? (
              <ul aria-label="Permission check" className="space-y-1.5">
                {rows.map((row) => (
                  <li key={row.id} className="flex items-start gap-2">
                    {row.state === "passed" ? (
                      <CircleCheckIcon
                        className="mt-0.5 size-4 shrink-0 text-success"
                        aria-hidden="true"
                      />
                    ) : row.state === "failed" ? (
                      <CircleAlertIcon
                        className="mt-0.5 size-4 shrink-0 text-destructive"
                        aria-hidden="true"
                      />
                    ) : (
                      <span className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    )}
                    <div
                      className={row.state === "not-checked" ? "text-muted-foreground" : undefined}
                    >
                      <p>
                        {row.label}
                        <span className="sr-only">
                          {row.state === "passed"
                            ? " (passed)"
                            : row.state === "failed"
                              ? " (failed)"
                              : " (not checked)"}
                        </span>
                      </p>
                      {row.detail ? (
                        <p role="alert" className="text-xs text-destructive">
                          {row.detail}
                        </p>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
            {busy === "verify" ? (
              <p role="status" className="text-xs text-muted-foreground">
                Restarting computer use and checking that it can see and read a GOAT window…
              </p>
            ) : null}
            {error || (localMac && permission.error) ? (
              <p role="alert" className="text-xs text-destructive">
                {error ?? permission.error}
              </p>
            ) : null}
            {localMac && !granted && verification === null ? (
              <p className="text-xs text-muted-foreground">
                If a permission stays off after you allow it, quit and reopen GOAT.
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          {verified ? (
            <Button onClick={close}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" disabled={busy !== null} onClick={close}>
                {isOn ? "Close" : "Later"}
              </Button>
              <PermissionContinueButton
                ready={granted}
                busy={busy !== null}
                onClick={() => void (isOn && localMac ? verify() : turnOn())}
              >
                {busy === "enable"
                  ? "Turning on…"
                  : busy === "verify"
                    ? "Checking…"
                    : !isOn
                      ? "Turn on"
                      : verification
                        ? "Try again"
                        : "Check permissions"}
              </PermissionContinueButton>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
