import type { ComputerUseOverlayCommand } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { overlayCallCaptures } from "./ComputerUseOverlay.ts";

export const CAPTURE_HIDE_UNCONFIRMED =
  "GOAT could not confirm that its cursor overlay was hidden. This capture did not run; wait for the helper and observe again.";

/** A timed-out acknowledgement may have left the overlay visible; retry the same hide once. */
const confirmCaptureHide = Effect.fn("ComputerUseCaptureHide.confirmCaptureHide")(function* <E>(
  channel: (command: ComputerUseOverlayCommand) => Effect.Effect<void, E>,
  captureHideConfirmed: () => boolean,
) {
  if (captureHideConfirmed()) return true;
  yield* channel({ op: "hide", reason: "capture" });
  return captureHideConfirmed();
});

/** False when a capturing call would run while the helper may still draw over it. */
export const captureHidden = Effect.fn("ComputerUseCaptureHide.captureHidden")(function* (
  overlay: ((command: ComputerUseOverlayCommand) => Effect.Effect<void>) | undefined,
  name: unknown,
  args: unknown,
) {
  if (
    !overlayCallCaptures(typeof name === "string" ? name : "", args) ||
    overlay === undefined ||
    !("captureHideConfirmed" in overlay) ||
    typeof overlay.captureHideConfirmed !== "function"
  )
    return true;
  return yield* confirmCaptureHide(overlay, overlay.captureHideConfirmed as () => boolean);
});
