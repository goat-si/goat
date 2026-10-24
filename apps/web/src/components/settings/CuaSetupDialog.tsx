import type { CuaHostStatus, DesktopCuaGrants, DesktopCuaVerification } from "@goat/contracts";
import { useRef, useState } from "react";

import { CircleAlertIcon, CircleCheckIcon } from "~/components/solar";
import { PermissionContinueButton } from "../permissions/PermissionChecklist";
import {
  OnboardingBody,
  OnboardingFooter,
  OnboardingHeader,
  OnboardingPopup,
} from "../onboarding/OnboardingDialog";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { CuaGrantSteps, useCuaGrants } from "./CuaGrantSteps";
import {
  CUA_WAYLAND_NOTE,
  computerUseUnavailable,
  cuaHostRequirements,
  cuaNeedsRelaunch,
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
  onReveal,
  onRelaunch,
  onEnable,
  onVerify,
  onClose,
}: {
  enabled: boolean;
  hostLabel: string;
  status: CuaHostStatus;
  /** This desktop runs the host, so it can grant macOS permissions and prove them. */
  localMac: boolean;
  /** The grants of the app computer use runs as: the helper when GOAT ships one. */
  onCheck: () => Promise<DesktopCuaGrants>;
  /** Opens the pane with the panel to drag that app into its list. */
  onAllow: (permission: CuaPermission) => Promise<void>;
  onReveal?: (() => Promise<void>) | undefined;
  /** Quits and reopens GOAT; absent where the desktop cannot. */
  onRelaunch?: (() => Promise<void>) | undefined;
  /** Turns the setting on; resolves to an error message when it could not be saved. */
  onEnable: () => Promise<string | null>;
  onVerify: () => Promise<DesktopCuaVerification>;
  onClose: (outcome: "enabled" | "dismissed") => void;
}) {
  const [busy, setBusy] = useState<"allow" | "enable" | "verify" | "relaunch" | null>(null);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [isOn, setIsOn] = useState(enabled);
  const [verification, setVerification] = useState<DesktopCuaVerification | null>(null);
  const [opened, setOpened] = useState<CuaPermission | null>(null);
  const checked = useCuaGrants(
    onCheck,
    localMac && busy === null && verification?.verified !== true,
  );
  const holder = checked.grants && checked.grants.principal !== "unusable" ? checked.grants : null;
  const unusable = checked.grants?.principal === "unusable" ? checked.grants.message : null;
  const granted =
    !localMac ||
    (holder !== null && checked.error === null && holder.accessibility && holder.screenRecording);

  const run = async (
    kind: "allow" | "enable" | "verify" | "relaunch",
    action: () => Promise<void>,
  ) => {
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
      await onAllow(target).then(
        () => setOpened(target),
        () => setError("Could not open System Settings. Try again."),
      );
    });
  const relaunch = onRelaunch
    ? () =>
        run("relaunch", async () => {
          await onRelaunch().catch(() =>
            setError("Could not reopen GOAT. Quit it and open it again."),
          );
        })
    : undefined;
  const needsRelaunch =
    localMac &&
    onRelaunch !== undefined &&
    cuaNeedsRelaunch({ grants: holder, opened, verification });
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
      <OnboardingPopup showCloseButton={busy === null}>
        <OnboardingHeader
          host={hostLabel}
          title={verified ? "Computer use is ready" : `Let agents use ${hostLabel}`}
          description={
            verified
              ? "From their next turn, agents can see and use apps on this Mac."
              : `Agents see and use apps on ${hostLabel} in the background, without taking over your cursor.`
          }
        />
        <OnboardingBody>
          <div className="space-y-3">
            {localMac && !verified ? (
              unusable ? (
                <p role="alert" className="text-destructive">
                  {unusable}
                </p>
              ) : holder ? (
                <CuaGrantSteps
                  grants={holder}
                  opened={opened}
                  busy={busy !== null}
                  onOpen={(target) => void allow(target)}
                  onReveal={
                    onReveal
                      ? () =>
                          void onReveal().catch(() =>
                            setError(`Could not show ${holder.name} in Finder.`),
                          )
                      : undefined
                  }
                />
              ) : checked.error === null ? (
                <p role="status" className="text-muted-foreground">
                  Checking permissions…
                </p>
              ) : null
            ) : null}
            {!localMac ? (
              <p className="text-muted-foreground">
                {cuaHostRequirements(status.platform, hostLabel)}
              </p>
            ) : null}
            {status.display && status.display.capability !== "available" ? (
              <p
                role={status.display.capability === "unavailable" ? "alert" : undefined}
                className={
                  status.display.capability === "unavailable"
                    ? "text-destructive"
                    : "text-muted-foreground"
                }
              >
                {status.display.reason}
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
            {error || (localMac && checked.error) ? (
              <p role="alert" className="text-xs text-destructive">
                {error ?? checked.error}
              </p>
            ) : null}
            {needsRelaunch ? (
              <div className="flex items-center gap-3 rounded-lg border px-3 py-2">
                <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                  macOS applies some permissions only to a newly opened app. Quit and reopen GOAT,
                  then come back here.
                </p>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => void relaunch?.()}
                >
                  {busy === "relaunch" ? "Reopening…" : "Quit & reopen"}
                </Button>
              </div>
            ) : null}
          </div>
        </OnboardingBody>
        <OnboardingFooter hint="Turn it off any time in Settings → Integrations.">
          {verified ? (
            <Button onClick={close}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" disabled={busy !== null} onClick={close}>
                {isOn ? "Close" : "Later"}
              </Button>
              <PermissionContinueButton
                ready={granted && (isOn || !computerUseUnavailable(status))}
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
        </OnboardingFooter>
      </OnboardingPopup>
    </Dialog>
  );
}
