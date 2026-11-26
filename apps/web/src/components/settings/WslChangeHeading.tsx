import { useGT } from "gt-react";
import { AlertDialogTitle, AlertDialogDescription } from "../ui/alert-dialog";

export type PendingWslChange =
  | { readonly kind: "disable"; readonly wasWslOnly: boolean }
  | { readonly kind: "distro"; readonly nextDistro: string | null }
  | { readonly kind: "enable"; readonly nextDistro: string | null }
  | { readonly kind: "wsl-only"; readonly nextValue: boolean };

export function WslChangeHeading({
  pendingWslChange,
}: {
  pendingWslChange: PendingWslChange | null;
}) {
  const gt = useGT();
  return (
    <>
      <AlertDialogTitle>
        {pendingWslChange?.kind === "disable"
          ? pendingWslChange.wasWslOnly
            ? gt("Turn off WSL and switch back to Windows?")
            : gt("Disable WSL backend?")
          : pendingWslChange?.kind === "distro"
            ? gt("Switch WSL distro?")
            : pendingWslChange?.kind === "enable"
              ? gt("Start the WSL backend")
              : pendingWslChange?.nextValue
                ? gt("Run only the WSL backend?")
                : gt("Re-enable the Windows backend?")}
      </AlertDialogTitle>
      <AlertDialogDescription>
        {pendingWslChange?.kind === "disable"
          ? pendingWslChange.wasWslOnly
            ? gt(
                "GOAT will restart on the Windows backend. Threads and projects opened against WSL stay safe inside the distro and become available again when you re-enable WSL.",
              )
            : gt(
                "The WSL backend will stop. Threads and projects opened against WSL stay safe inside the distro, but they'll be unavailable in GOAT until you re-enable WSL.",
              )
          : pendingWslChange?.kind === "distro"
            ? gt(
                "GOAT will restart the WSL backend on the new distro. Sessions still running on the current distro will be interrupted.",
              )
            : pendingWslChange?.kind === "enable"
              ? gt(
                  "Run the WSL backend alongside the Windows one, or stop the Windows backend and use only WSL? You can change this later from Settings.",
                )
              : pendingWslChange?.nextValue
                ? gt(
                    "GOAT will restart and start only the WSL backend. Your Windows-side projects won't be accessible until you turn this off again.",
                  )
                : gt("GOAT will restart and bring the Windows backend back up alongside WSL.")}
      </AlertDialogDescription>
    </>
  );
}
