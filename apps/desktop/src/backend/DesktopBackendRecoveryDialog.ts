import * as Effect from "effect/Effect";
import type * as ElectronDialog from "../electron/ElectronDialog.ts";
import type { BackendInstanceSpec } from "./DesktopBackendManager.ts";
const recoveryReason = (reason: string) => {
  switch (reason) {
    case "crash-loop":
      return "The server stopped repeatedly. Automatic restarts have reached their limit.";
    case "blocked":
      return "GOAT could not confirm that the previous server stopped. Recovery is paused.";
    case "record-unavailable":
      return "GOAT could not read or save its recovery state. Automatic restarts are disabled.";
    default:
      return reason;
  }
};
export const makeRecoveryDialog = (
  dialog: Pick<ElectronDialog.ElectronDialog["Service"], "showMessageBox">,
  openLogs: (path: string) => Effect.Effect<void>,
): NonNullable<BackendInstanceSpec["onRecoveryPaused"]> => {
  let showing = false;
  return Effect.fn("DesktopBackendPool.showRecovery")(
    function* (actions: Parameters<NonNullable<BackendInstanceSpec["onRecoveryPaused"]>>[0]) {
      if (showing) return;
      showing = true;
      yield* Effect.gen(function* () {
        const choice = yield* dialog.showMessageBox({
          type: "error",
          title: "Server recovery paused",
          message: `${actions.label}: automatic server recovery is paused`,
          detail: `${recoveryReason(actions.reason)}\n\nLogs: ${actions.logPath}`,
          buttons: ["Retry server", "Stop server", "Open logs", "Close"],
          cancelId: 3,
          defaultId: 3,
        });
        if (choice.response === 0) yield* actions.retry;
        if (choice.response === 1) yield* actions.stop;
        if (choice.response === 2) yield* openLogs(actions.logPath);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            showing = false;
          }),
        ),
      );
    },
    Effect.catchCause((cause) =>
      Effect.logError("Could not show server recovery actions", { cause }),
    ),
  );
};
