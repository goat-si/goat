import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import { expect } from "vite-plus/test";
import type { ServerBrowserViewer } from "./ServerBrowser.ts";
import { makeSession, mockCopy } from "./ServerBrowserTestFixtures.ts";

export const assertBusyCopy = (
  viewer: ServerBrowserViewer,
  pageSession: ReturnType<typeof makeSession>,
  frameSession: ReturnType<typeof makeSession>,
) =>
  Effect.gen(function* () {
    const send = frameSession.send.getMockImplementation();
    if (!send) throw new Error("Missing frame session send implementation");
    const reading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    frameSession.send.mockImplementation(async (method, input) => {
      if (method === "Runtime.evaluate" && (input as { contextId?: number }).contextId === 7) {
        reading.resolve();
        await release.promise;
      }
      return send(method, input);
    });
    mockCopy.key = "copied";
    const copy = yield* viewer
      .input({ type: "key", action: "down", key: "c", code: "KeyC", modifiers: 4 })
      .pipe(Effect.forkScoped({ startImmediately: true }));
    yield* Effect.promise(() => reading.promise);
    const dispatched = pageSession.send.mock.calls.some(
      ([method, input]) =>
        method === "Input.dispatchKeyEvent" && (input as { key?: string }).key === "c",
    );
    release.resolve();
    yield* Fiber.join(copy);
    expect(dispatched).toBe(true);
  });

export const assertClipboardAccess = (
  viewer: ServerBrowserViewer,
  watcher: ServerBrowserViewer,
  getSession: () => ReturnType<typeof makeSession>,
) =>
  Effect.gen(function* () {
    const clipboard = (queue: typeof viewer.output) =>
      Queue.clear(queue).pipe(
        Effect.map((items) => items.filter((item) => item._tag === "clipboard")),
      );
    mockCopy.page = "unprompted";
    yield* viewer.input({ type: "mouse", action: "move", x: 10, y: 10 });
    yield* viewer.input({ type: "wheel", x: 10, y: 10, deltaY: 40 });
    yield* viewer.input({ type: "key", action: "down", key: "v", code: "KeyV", modifiers: 4 });
    yield* viewer.input({ type: "unknown" });
    expect(yield* clipboard(viewer.output)).toEqual([]);
    mockCopy.key = "copied";
    yield* viewer.input({ type: "key", action: "down", key: "c", code: "KeyC", modifiers: 4 });
    const cdp = getSession();
    expect(cdp.send).toHaveBeenCalledWith(
      "Input.dispatchKeyEvent",
      expect.objectContaining({ key: "c", commands: ["copy"] }),
    );
    expect(yield* clipboard(viewer.output)).toEqual([{ _tag: "clipboard", text: "copied" }]);
    mockCopy.key = "cut";
    yield* viewer.input({ type: "key", action: "down", key: "x", code: "KeyX", modifiers: 2 });
    expect(yield* clipboard(viewer.output)).toEqual([{ _tag: "clipboard", text: "cut" }]);
    mockCopy.page = "left over";
    mockCopy.key = "";
    yield* viewer.input({ type: "key", action: "down", key: "c", code: "KeyC", modifiers: 4 });
    expect(yield* clipboard(viewer.output)).toEqual([]);
    expect(yield* clipboard(watcher.output)).toEqual([]);
  });
