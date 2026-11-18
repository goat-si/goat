import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { PreviewNavStatus } from "./Manager.ts";

export const makeNavigationProbe = (debuggee: Pick<Electron.Debugger, "sendCommand">) => {
  let dialog = false;
  let attached = true;
  return {
    close() {
      attached = false;
    },
    observe(method: string) {
      if (method === "Page.javascriptDialogOpening") dialog = true;
      if (method === "Page.javascriptDialogClosed") dialog = false;
    },
    beforeNavigation: Effect.fn("PreviewManager.leaveBusyPage")(function* (
      isCurrent: () => boolean,
    ) {
      if (!attached || dialog || !isCurrent()) return;
      const answered = yield* Effect.promise(() =>
        debuggee.sendCommand("Runtime.evaluate", { expression: "0" }).then(
          () => undefined,
          () => undefined,
        ),
      ).pipe(Effect.timeoutOption(1_000));
      if (Option.isNone(answered) && attached && !dialog && isCurrent()) {
        void debuggee.sendCommand("Runtime.terminateExecution").catch(() => undefined);
      }
    }),
  };
};

export const computeNavStatus = (wc: Electron.WebContents): PreviewNavStatus => {
  const url = wc.getURL();
  const title = wc.getTitle();
  if (url === "" || url === "about:blank") return { kind: "Idle" };
  // isLoading() includes late iframes whose completion may never clear the tab's loading bar.
  if (wc.isLoadingMainFrame()) return { kind: "Loading", url, title };
  return { kind: "Success", url, title };
};
