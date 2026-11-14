import type { Page } from "playwright-core";
import { expect, it, vi } from "vite-plus/test";
import type { ActionChannel } from "./actionChannel.ts";
import { guardedNavigate } from "./ServerBrowserNavigate.ts";

const channel = { call: <T>(run: () => T) => run() } as unknown as ActionChannel;
const timeout = () => Object.assign(new Error("Navigation timed out"), { name: "TimeoutError" });

it("returns after a committed page's load event times out", async () => {
  const goto = vi.fn(async (_url: string, options: { waitUntil: string }) => {
    if (options.waitUntil !== "commit") throw timeout();
    return null;
  });
  const waitForLoadState = vi.fn(async () => {
    throw timeout();
  });
  const page = { goto, waitForLoadState } as unknown as Page;
  await expect(
    guardedNavigate(
      { page, control: { track: () => {} } },
      "https://example.com/",
      "load",
      4_000,
      channel,
    ),
  ).resolves.toBeUndefined();
  expect(goto).toHaveBeenCalledWith(
    "https://example.com/",
    expect.objectContaining({ waitUntil: "commit" }),
  );
  expect(waitForLoadState).toHaveBeenCalledWith(
    "load",
    expect.objectContaining({ timeout: expect.any(Number) }),
  );
});

it("still fails when navigation never commits", async () => {
  const page = {
    goto: async () => {
      throw timeout();
    },
  } as unknown as Page;
  await expect(
    guardedNavigate(
      { page, control: { track: () => {} } },
      "https://example.com/",
      "load",
      4_000,
      channel,
    ),
  ).rejects.toMatchObject({ tag: "PreviewAutomationTimeoutError" });
});
