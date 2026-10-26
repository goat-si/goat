import type { ComputerUseOverlayCommand } from "@goat/contracts";
import * as Effect from "effect/Effect";

/** A timed-out acknowledgement may have left the overlay visible; retry the same hide once. */
export const confirmCaptureHide = Effect.fn("ComputerUseCaptureHide.confirmCaptureHide")(function* <
  E,
>(
  channel: (command: ComputerUseOverlayCommand) => Effect.Effect<void, E>,
  captureHideConfirmed: () => boolean,
) {
  if (captureHideConfirmed()) return true;
  yield* channel({ op: "hide", reason: "capture" });
  return captureHideConfirmed();
});
