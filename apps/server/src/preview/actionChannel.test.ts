import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { CDPSession, ElementHandle, Page } from "playwright-core";
import { expect, vi } from "vite-plus/test";
import { makeActionChannel } from "./actionChannel.ts";
import { BrowserControlInterrupted } from "./SessionControl.ts";

it.effect("an aborted action refuses every command before it reaches the browser", () =>
  Effect.sync(() => {
    const calls = vi.fn();
    const page = {
      mouse: { down: calls, up: calls, move: calls, wheel: calls },
    } as unknown as Page;
    const cdp = { send: calls } as unknown as CDPSession;
    const element = { evaluate: calls, setInputFiles: calls } as unknown as ElementHandle;
    const controller = new AbortController();
    const channel = makeActionChannel({
      page,
      cdp,
      signal: controller.signal,
      controlGeneration: () => {},
      isFenced: () => false,
      blockedFrame: () => false,
    });
    controller.abort(new BrowserControlInterrupted("Blocked host", "blocked_url"));
    expect(() => channel.send("Runtime.evaluate", { expression: "1" })).toThrow();
    expect(() => channel.mouse.down()).toThrow();
    expect(() => channel.mouse.up()).toThrow();
    expect(() => channel.mouse.move(1, 2)).toThrow();
    expect(() => channel.mouse.wheel(1, 2)).toThrow();
    expect(() => channel.evaluate(element, () => 1, undefined)).toThrow();
    expect(() => channel.setInputFiles(element, [])).toThrow();
    expect(calls).not.toHaveBeenCalled();
  }),
);
