import type { CDPSession, Page } from "playwright-core";
import { makeActionChannel } from "./actionChannel.ts";

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
