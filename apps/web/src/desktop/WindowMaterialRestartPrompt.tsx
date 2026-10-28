import { isSystemMaterialRequested, type DesktopWindowMaterialReason } from "@goat/contracts";
import { useEffect, useState } from "react";
import { useClientSettings, useClientSettingsHydrated } from "../hooks/useSettings";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";

export function canRelaunchForWindowMaterial(): boolean {
  return typeof window !== "undefined" && Boolean(window.desktopBridge?.relaunchForWindowMaterial);
}

export function WindowMaterialRestartDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const restart = async () => {
    const relaunch = window.desktopBridge?.relaunchForWindowMaterial;
    if (!relaunch) return;
    setRestarting(true);
    setError(null);
    try {
      await relaunch();
    } catch {
      setError("Couldn't restart GOAT. Quit and reopen it to use Liquid Glass.");
      setRestarting(false);
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (restarting) return;
        onOpenChange(next);
        if (!next) setError(null);
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Restart GOAT to use Liquid Glass?</AlertDialogTitle>
          <AlertDialogDescription>
            Liquid Glass applies once GOAT reopens its window. Agents and terminals running in GOAT
            on this computer will stop.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <p className="px-6 pb-4 text-sm text-destructive">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogClose disabled={restarting} render={<Button variant="outline" />}>
            Later
          </AlertDialogClose>
          <Button disabled={restarting} onClick={() => void restart()}>
            {restarting ? (
              <>
                <Spinner size="sm" />
                Restarting…
              </>
            ) : (
              "Restart now"
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

const wantsSystemGlass = (
  settings: Parameters<typeof isSystemMaterialRequested>[0] & {
    readonly glassOpacity: number;
  },
) => isSystemMaterialRequested(settings) && settings.glassOpacity < 100;

/**
 * Asks once after a settings change made in this window turns system glass on and the window
 * reports it needs a restart. Settings change only through this window's writes once hydrated.
 */
export function WindowMaterialRestartPrompt({
  reason,
}: {
  readonly reason: DesktopWindowMaterialReason | null;
}) {
  const hydrated = useClientSettingsHydrated();
  const wanted = useClientSettings(wantsSystemGlass);
  const [seenWanted, setSeenWanted] = useState<boolean | null>(null);
  const [requested, setRequested] = useState(false);
  const [open, setOpen] = useState(false);
  if (hydrated && wanted !== seenWanted) {
    setSeenWanted(wanted);
    setRequested(seenWanted === false && wanted);
  }
  if (open && reason !== null && reason !== "restart") setOpen(false);
  const due = requested && reason === "restart";

  // oxlint-disable-next-line goat/react-effect-budget -- a modal must wait for a held slider's pointerup
  useEffect(() => {
    if (!due) return;
    let cancelled = false;
    const show = () => {
      if (cancelled) return;
      setRequested(false);
      setOpen(true);
    };
    if (document.querySelector("input[type='range']:active") === null) {
      queueMicrotask(show);
    } else {
      window.addEventListener("pointerup", show, { once: true });
    }
    return () => {
      cancelled = true;
      window.removeEventListener("pointerup", show);
    };
  }, [due]);

  return <WindowMaterialRestartDialog open={open} onOpenChange={setOpen} />;
}
