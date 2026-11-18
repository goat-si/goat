import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const PAINT_TIMEOUT_MS = 1_000;

export const confirmPreviewPaint = Effect.fn("PreviewManager.confirmPaint")(function* (
  debuggee: Pick<Electron.Debugger, "sendCommand"> | undefined,
) {
  if (!debuggee) return false;
  const confirmed = yield* Effect.promise(async () => {
    try {
      const tree = (await debuggee.sendCommand("Page.getFrameTree")) as
        | { frameTree?: { frame?: { id?: unknown } } }
        | undefined;
      const frameId = tree?.frameTree?.frame?.id;
      if (typeof frameId !== "string") return false;
      const world = (await debuggee.sendCommand("Page.createIsolatedWorld", {
        frameId,
        worldName: "goat-preview-still-image",
      })) as { executionContextId?: unknown } | undefined;
      if (typeof world?.executionContextId !== "number") return false;
      const response = (await debuggee.sendCommand("Runtime.evaluate", {
        expression: `new Promise(resolve => { let frame; const timer = setTimeout(() => { cancelAnimationFrame(frame); resolve(false); }, ${PAINT_TIMEOUT_MS}); frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => { clearTimeout(timer); resolve(true); }); }); })`,
        contextId: world.executionContextId,
        awaitPromise: true,
        returnByValue: true,
      })) as { result?: { value?: unknown }; exceptionDetails?: unknown } | undefined;
      return !response?.exceptionDetails && response?.result?.value === true;
    } catch {
      return false;
    }
  }).pipe(Effect.timeoutOption(PAINT_TIMEOUT_MS));
  return Option.getOrElse(confirmed, () => false);
});
