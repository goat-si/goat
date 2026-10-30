import type { CDPSession, Page } from "playwright-core";
import { makeActionChannel } from "./actionChannel.ts";
import * as PageOperations from "./ServerBrowserPage.ts";

export const testActionChannel = (
  page: Page,
  cdp: CDPSession,
  signal = new AbortController().signal,
) =>
  makeActionChannel({
    page,
    cdp,
    signal,
    controlGeneration: () => {},
    isFenced: () => false,
    blockedFrame: () => false,
  });

export const testActionGate = (
  page: Page,
  cdp: CDPSession,
  gate: () => void | Promise<void> = () => {},
) => Object.assign(gate, { channel: testActionChannel(page, cdp) });

export const testActionPage = {
  ...PageOperations,
  click: (...[page, input, pointer, gate]: Parameters<typeof PageOperations.click>) =>
    PageOperations.click(
      page,
      input,
      pointer,
      Object.assign(gate ?? (() => {}), {
        channel: gate?.channel ?? testActionChannel(page, {} as CDPSession, gate?.signal),
      }),
    ),
};
