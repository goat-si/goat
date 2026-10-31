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
  type: async (...[page, input, gate, readiness]: Parameters<typeof PageOperations.type>) => {
    const channel =
      gate?.channel ??
      testActionChannel(page, await page.context().newCDPSession(page), gate?.signal);
    return PageOperations.type(
      page,
      input,
      Object.assign(gate ?? (() => {}), { channel }),
      readiness,
    );
  },
  press: async (...[page, input, gate]: Parameters<typeof PageOperations.press>) => {
    const channel =
      gate?.channel ??
      testActionChannel(page, await page.context().newCDPSession(page), gate?.signal);
    return PageOperations.press(page, input, Object.assign(gate ?? (() => {}), { channel }));
  },
  hover: async (...[page, input, pointer, gate]: Parameters<typeof PageOperations.hover>) => {
    const channel =
      gate?.channel ??
      testActionChannel(page, await page.context().newCDPSession(page), gate?.signal);
    return PageOperations.hover(
      page,
      input,
      pointer,
      Object.assign(gate ?? (() => {}), { channel }),
    );
  },
  drag: async (...[page, input, pointer, gate]: Parameters<typeof PageOperations.drag>) => {
    const channel =
      gate?.channel ??
      testActionChannel(page, await page.context().newCDPSession(page), gate?.signal);
    return PageOperations.drag(
      page,
      input,
      pointer,
      Object.assign(gate ?? (() => {}), { channel }),
    );
  },
  scroll: async (...[page, input, gate]: Parameters<typeof PageOperations.scroll>) => {
    const channel =
      gate?.channel ??
      testActionChannel(page, await page.context().newCDPSession(page), gate?.signal);
    return PageOperations.scroll(page, input, Object.assign(gate ?? (() => {}), { channel }));
  },
};
