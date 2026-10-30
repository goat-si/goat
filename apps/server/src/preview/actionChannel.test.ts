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
      context: () => ({ newCDPSession: calls }),
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
    expect(() => channel.sendFor(cdp)("Runtime.evaluate", { expression: "1" })).toThrow();
    expect(() => channel.newCDPSession(page)).toThrow();
    expect(() => channel.detach(cdp)).toThrow();
    expect(() => channel.ownerFrame(element)).toThrow();
    expect(() => channel.dispose(element)).toThrow();
    expect(() => channel.mouse.down()).toThrow();
    expect(() => channel.mouse.up()).toThrow();
    expect(() => channel.mouse.move(1, 2)).toThrow();
    expect(() => channel.mouse.wheel(1, 2)).toThrow();
    expect(() => channel.evaluate(element, () => 1, undefined)).toThrow();
    expect(() => channel.setInputFiles(element, [])).toThrow();
    expect(calls).not.toHaveBeenCalled();
  }),
);

it.effect("fenced tabs and blocked frames refuse a command synchronously", () =>
  Effect.sync(() => {
    const calls = vi.fn();
    const page = {
      mouse: { down: calls, up: calls, move: calls, wheel: calls },
    } as unknown as Page;
    const cdp = { send: calls } as unknown as CDPSession;
    let fenced = false;
    let blocked = false;
    const channel = makeActionChannel({
      page,
      cdp,
      signal: new AbortController().signal,
      controlGeneration: () => {},
      isFenced: () => fenced,
      blockedFrame: () => blocked,
    });
    fenced = true;
    expect(() => channel.mouse.move(1, 2)).toThrow(/blocked/);
    fenced = false;
    blocked = true;
    expect(() => channel.send("Runtime.evaluate", { expression: "1" })).toThrow(/blocked/);
    expect(calls).not.toHaveBeenCalled();
  }),
);

it.effect("a control-generation change refuses a send synchronously", () =>
  Effect.sync(() => {
    const calls = vi.fn();
    const page = {
      mouse: { down: calls, up: calls, move: calls, wheel: calls },
    } as unknown as Page;
    const cdp = { send: calls } as unknown as CDPSession;
    let changed = false;
    const channel = makeActionChannel({
      page,
      cdp,
      signal: new AbortController().signal,
      controlGeneration: () => {
        if (changed) throw new BrowserControlInterrupted("Control changed.");
      },
      isFenced: () => false,
      blockedFrame: () => false,
    });
    changed = true;
    expect(() => channel.mouse.down()).toThrow(/Control changed/);
    expect(calls).not.toHaveBeenCalled();
  }),
);

it.effect("the explicit release bypass resets the pressed button after a cut", () =>
  Effect.gen(function* () {
    const send = vi.fn(async () => ({}));
    const page = { mouse: {} } as unknown as Page;
    const cdp = { send } as unknown as CDPSession;
    const controller = yield* Effect.sync(() => new AbortController());
    const channel = makeActionChannel({
      page,
      cdp,
      signal: controller.signal,
      controlGeneration: () => {},
      isFenced: () => false,
      blockedFrame: () => false,
    });
    controller.abort(new BrowserControlInterrupted("Blocked host", "blocked_url"));
    yield* Effect.promise(() => channel.releasePressedButton({ x: 3, y: 4 }));
    expect(send).toHaveBeenCalledExactlyOnceWith("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: 3,
      y: 4,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
  }),
);
