// @effect-diagnostics globalTimers:off - The final frame is a Playwright promise outside the Effect runtime.
import type { CDPSession } from "playwright-core";
import { BrowserControlInterrupted, type SessionControl } from "./SessionControl.ts";
import { captureViewport } from "./ServerBrowserPage.ts";

// How long Chromium gets to draw a recording's last frame; one that stopped drawing never does.
const FRAME_ANSWER_MS = 1_000;

/** The final frame, or undefined when its capture fails or does not answer in time. */
export const answeredFinalFrame = <A>(capture: Promise<A>) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), FRAME_ANSWER_MS);
  });
  return Promise.race([capture.catch(() => undefined), late]).finally(() => clearTimeout(timer));
};

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
