import type { Page } from "playwright-core";
import { makeActionChannel } from "./actionChannel.ts";

export async function historyTestChannel(page: Page, isFenced: () => boolean = () => false) {
  const cdp = await page.context().newCDPSession(page);
  return makeActionChannel({
    page,
    cdp,
    signal: new AbortController().signal,
    controlGeneration: () => {},
    isFenced,
    blockedFrame: () => false,
  });
}
