import type { CDPSession } from "playwright-core";
import { BrowserControlInterrupted, type SessionControl } from "./SessionControl.ts";
import { captureViewport } from "./ServerBrowserPage.ts";

export const captureFinalRecordingFrame = async (
  cdp: CDPSession,
  quality: number,
  control: SessionControl,
) => {
  if (control.isPrivate) return undefined;
  try {
    return await control.observe(async () => {
      await cdp.send("Runtime.evaluate", {
        expression: `(async () => {
        const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await paint();
        await Promise.allSettled(document.getAnimations()
          .filter(animation => animation.playState === "running" && animation.effect?.getComputedTiming().iterations !== Infinity)
          .map(animation => animation.finished));
        await paint();
      })()`,
        awaitPromise: true,
      });
      return captureViewport(cdp, { format: "jpeg", quality });
    });
  } catch (cause) {
    if (cause instanceof BrowserControlInterrupted && cause.reason === "privateMode")
      return undefined;
    throw cause;
  }
};
