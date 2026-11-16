// @effect-diagnostics nodeBuiltinImport:off - Stands in for an Electron debugger.
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { DesktopBrowserEvent } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as NodeEvents from "node:events";

import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(DesktopBrowserEvent));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeCdpReply = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.Number })),
);
const key = { threadId: "thread-1", tabId: "tab-1" };
/** Sends a page command whose id the fake debugger records as it receives it. */
const command = (
  host: DesktopBrowserHost.DesktopBrowserHost["Service"],
  id: number,
  method: string,
) =>
  host.handleCommandLine(
    encodeJson({
      type: "cdp",
      ...key,
      message: encodeJson({ id, method, params: { id }, sessionId: "goat-preview-page" }),
    }),
  );

const makeDebuggee = (
  options: {
    readonly deferFocus?: boolean;
    /** The guest is still loading its first page. */
    readonly loading?: boolean;
    readonly refuse?: (method: string, sessionId: string | undefined) => boolean;
  } = {},
) => {
  const emitter = new NodeEvents.EventEmitter();
  const pending: Array<() => void> = [];
  const focusChanges: Array<() => void> = [];
  const sent: Array<unknown> = [];
  /** Commands the host sends on its own (no relay id), such as ending an input hold. */
  const own: Array<{ method: string; params: unknown }> = [];
  const sendWaiters: Array<() => void> = [];
  const ownWaiters = new Map<string, () => void>();
  const focusEmulation: Array<boolean> = [];
  const debuggee = Object.assign(emitter, {
    sendCommand: (
      method: string,
      params?: { id?: number; enabled?: boolean },
      sessionId?: string,
    ) =>
      new Promise((resolve, reject) => {
        if (options.refuse?.(method, sessionId)) {
          reject(new Error("Refused"));
          return;
        }
        if (method === "Target.getTargetInfo") {
          resolve({ targetInfo: { targetId: "GUEST" } });
          return;
        }
        const expression = (params as { expression?: string } | undefined)?.expression;
        if (
          method === "Input.setIgnoreInputEvents" ||
          method === "Page.stopScreencast" ||
          (method === "Runtime.evaluate" && expression?.includes("__goatAgentInputHeld"))
        ) {
          own.push({ method, params });
          resolve({});
          ownWaiters.get(method)?.();
          return;
        }
        if (method === "Emulation.setFocusEmulationEnabled") {
          focusEmulation.push(params?.enabled === true);
          if (options.deferFocus) focusChanges.push(() => resolve({}));
          else resolve({});
          return;
        }
        sent.push(params?.id);
        pending.push(() => resolve({ method }));
        sendWaiters.shift()?.();
      }),
  });
  let destroyed = false;
  const webContents = Object.assign(new NodeEvents.EventEmitter(), {
    getURL: () => "http://localhost/",
    getTitle: () => "Page",
    getUserAgent: () => "Electron",
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    isLoadingMainFrame: () => options.loading === true,
    isDestroyed: () => destroyed,
  });
  return {
    tab: {
      webContents: webContents as unknown as Electron.WebContents,
      debugger: debuggee as unknown as Electron.Debugger,
    },
    webContents,
    emit: (method: string, params: unknown) => emitter.emit("message", {}, method, params, ""),
    navigate: () => webContents.emit("did-navigate"),
    domReady: () => webContents.emit("dom-ready"),
    destroy: () => {
      destroyed = true;
    },
    failLoad: (code: number) =>
      webContents.emit("did-fail-load", {}, code, "Failed", "http://localhost/", true),
    /** Ids of the commands the debugger received, in order. */
    sent,
    own,
    focusEmulation,
    nextSend: () => new Promise<void>((resolve) => sendWaiters.push(resolve)),
    /** Resolves when the host itself sends `method`. */
    sentOwn: (method: string) => new Promise<void>((resolve) => ownWaiters.set(method, resolve)),
    release: () => pending.splice(0).forEach((resolve) => resolve()),
    releaseFirst: () => pending.shift()?.(),
    settleFocus: () => focusChanges.splice(0).forEach((resolve) => resolve()),
  };
};

/** Commands wait behind a focus emulation change; it settles within a macrotask. */
// oxlint-disable-next-line goat/no-real-time-wait-in-tests -- a zero-delay macrotask boundary, not a wait for time
const settle = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

const takeEvents = (host: DesktopBrowserHost.DesktopBrowserHost["Service"], count: number) =>
  host.events.pipe(
    Stream.take(count),
    Stream.runCollect,
    Effect.map((lines) => lines.map((line) => decodeEvent(new TextDecoder().decode(line)))),
  );

/**
 * Ids of the replies the host sends, in order. A screenshot's reply leaves after its turn
 * has passed on, so by then the next waiting screenshot, if any, has been sent. Subscribe
 * before sending commands: a new subscriber releases the tab's relay.
 */
const watchReplies = (host: DesktopBrowserHost.DesktopBrowserHost["Service"]) =>
  Effect.gen(function* () {
    const replies = yield* Queue.unbounded<number>();
    yield* host.events.pipe(
      Stream.map((line) => decodeEvent(new TextDecoder().decode(line))),
      Stream.runForEach((event) =>
        event.type === "cdp" ? Queue.offer(replies, decodeCdpReply(event.message).id) : Effect.void,
      ),
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
    return replies;
  });

describe("DesktopBrowserHost", () => {
  it.effect.each([false, true])(
    "reloads the exact adopted guest (ignoreCache: %s)",
    (ignoreCache) =>
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* DesktopBrowserHost.make;
          const guest = makeDebuggee();
          const other = makeDebuggee();
          host.attach(key, guest.tab);
          host.attach({ ...key, tabId: "other-tab" }, other.tab);
          const reader = yield* host.events.pipe(
            Stream.map((line) => decodeEvent(new TextDecoder().decode(line))),
            Stream.filter((event) => event.type === "cdp"),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          );
          yield* Effect.yieldNow;
          yield* host.handleCommandLine(
            encodeJson({
              type: "cdp",
              ...key,
              message: encodeJson({
                id: 1,
                method: "Page.reload",
                params: { ignoreCache },
                sessionId: "goat-preview-page",
              }),
            }),
          );
          const [reply] = yield* Fiber.join(reader);
          expect(JSON.parse(reply!.message)).toMatchObject({ id: 1, result: {} });
          expect(guest.webContents.reload).toHaveBeenCalledTimes(ignoreCache ? 0 : 1);
          expect(guest.webContents.reloadIgnoringCache).toHaveBeenCalledTimes(ignoreCache ? 1 : 0);
          expect(other.webContents.reload).not.toHaveBeenCalled();
          expect(other.webContents.reloadIgnoringCache).not.toHaveBeenCalled();
        }),
      ),
  );

  it.effect("announces tabs already attached to a backend that starts later", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      host.attach(key, makeDebuggee().tab);

      expect(yield* takeEvents(host, 1)).toEqual([{ type: "attached", ...key }]);
      expect(yield* takeEvents(host, 1)).toEqual([{ type: "attached", ...key }]);
    }),
  );

  it.effect("announces a guest still loading its first page only once that page is up", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const loading = makeDebuggee({ loading: true });
      const other = { ...key, tabId: "tab-2" };
      const reader = yield* takeEvents(host, 3).pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      host.attach(key, loading.tab);
      host.setShown(key, true);
      host.attach(other, makeDebuggee().tab);
      loading.domReady();

      expect(yield* Fiber.join(reader)).toEqual([
        { type: "attached", ...other },
        { type: "attached", ...key },
        { type: "shown", ...key, shown: true },
      ]);
    }),
  );

  it.effect(
    "keeps a loading guest unannounced across a replaced navigation and a new backend",
    () =>
      Effect.gen(function* () {
        const host = yield* DesktopBrowserHost.make;
        const loading = makeDebuggee({ loading: true });
        const other = { ...key, tabId: "tab-2" };
        host.attach(key, loading.tab);
        loading.failLoad(-3);
        const reader = yield* takeEvents(host, 2).pipe(Effect.forkScoped);

        yield* Effect.yieldNow;
        host.attach(other, makeDebuggee().tab);
        loading.domReady();

        expect(yield* Fiber.join(reader)).toEqual([
          { type: "attached", ...other },
          { type: "attached", ...key },
        ]);
      }),
  );

  it.effect("reports a first page's load failure after announcing the tab", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const loading = makeDebuggee({ loading: true });
      const failure = { url: "http://localhost/", code: -102, description: "Failed" };
      // The manager listens for failures before it attaches the guest, so it reports first.
      loading.webContents.on("did-fail-load", () => host.loadFailed(key, failure));
      const reader = yield* takeEvents(host, 2).pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      host.attach(key, loading.tab);
      loading.failLoad(-102);

      expect(yield* Fiber.join(reader)).toEqual([
        { type: "attached", ...key },
        { type: "loadFailed", ...key, ...failure },
      ]);
    }),
  );

  it.effect("drops a held load failure once the waiting guest commits a new document", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const loading = makeDebuggee({ loading: true });
      const other = { ...key, tabId: "tab-2" };
      const reader = yield* takeEvents(host, 2).pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      host.attach(key, loading.tab);
      // A reattach replays a failure from the guest's previous load while a new one is in flight.
      host.loadFailed(key, { url: "http://localhost/old", code: -102, description: "Failed" });
      loading.navigate();
      loading.domReady();
      host.attach(other, makeDebuggee().tab);

      expect(yield* Fiber.join(reader)).toEqual([
        { type: "attached", ...key },
        { type: "attached", ...other },
      ]);
    }),
  );

  it.effect(
    "announces a first page that never comes up, but never a tab closed or destroyed first",
    () =>
      Effect.gen(function* () {
        const host = yield* DesktopBrowserHost.make;
        const closed = { ...key, tabId: "tab-2" };
        const destroyed = { ...key, tabId: "tab-3" };
        const destroyedGuest = makeDebuggee({ loading: true });
        const reader = yield* takeEvents(host, 1).pipe(Effect.forkScoped);

        yield* Effect.yieldNow;
        host.attach(closed, makeDebuggee({ loading: true }).tab);
        host.detach(closed);
        host.attach(destroyed, destroyedGuest.tab);
        destroyedGuest.destroy();
        host.attach(key, makeDebuggee({ loading: true }).tab);
        yield* TestClock.adjust("5 seconds");

        expect(yield* Fiber.join(reader)).toEqual([{ type: "attached", ...key }]);
      }),
  );

  it.effect("re-sends shown to a backend that starts later and when a tab attaches again", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      host.attach(key, makeDebuggee().tab);
      host.setShown(key, true);
      const reader = yield* takeEvents(host, 5).pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      host.detach(key);
      host.attach(key, makeDebuggee().tab);

      expect(yield* Fiber.join(reader)).toEqual([
        { type: "attached", ...key },
        { type: "shown", ...key, shown: true },
        { type: "detached", ...key },
        { type: "attached", ...key },
        { type: "shown", ...key, shown: true },
      ]);
    }),
  );

  it.effect("replays an explicit hidden report before announcing another tab", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const other = { ...key, tabId: "tab-2" };
      host.setShown(key, false);
      host.attach(key, makeDebuggee().tab);
      host.setShown(other, true);
      host.attach(other, makeDebuggee().tab);

      expect(yield* takeEvents(host, 3)).toEqual([
        { type: "attached", ...key },
        { type: "shown", ...key, shown: false },
        { type: "attached", ...other },
      ]);
    }),
  );

  it.effect("drops replies from a relay the server released", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const reader = yield* takeEvents(host, 2).pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      const command = (id: number, method: string) =>
        host.handleCommandLine(
          encodeJson({
            type: "cdp",
            ...key,
            message: encodeJson({ id, method, sessionId: "goat-preview-page" }),
          }),
        );
      yield* command(1, "Page.captureScreenshot");
      yield* host.handleCommandLine(encodeJson({ type: "release", ...key }));
      yield* command(2, "DOM.enable");
      yield* settle;
      debuggee.release();
      const [, reply] = yield* Fiber.join(reader);

      expect(reply).toMatchObject({ type: "cdp" });
      expect(decodeCdpReply((reply as { message: string }).message).id).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("tells the tab's browser session after the agent clears its cookies", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      const cookiesCleared = vi.fn(async () => {});
      host.attach(key, { ...debuggee.tab, cookiesCleared });
      const replies = yield* watchReplies(host);

      const answer = (id: number, method: string) =>
        Effect.gen(function* () {
          const sent = debuggee.nextSend();
          yield* command(host, id, method);
          yield* Effect.promise(() => sent);
          debuggee.release();
          return yield* Queue.take(replies);
        });

      expect(yield* answer(1, "Network.getCookies")).toBe(1);
      expect(cookiesCleared).not.toHaveBeenCalled();
      expect(yield* answer(2, "Network.clearBrowserCookies")).toBe(2);
      expect(cookiesCleared).toHaveBeenCalledOnce();
    }).pipe(Effect.scoped),
  );

  it.effect("sends a page one screenshot at a time", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const replies = yield* watchReplies(host);

      yield* command(host, 1, "Page.captureScreenshot");
      yield* command(host, 2, "Page.captureScreenshot");
      yield* command(host, 3, "DOM.enable");
      yield* settle;
      expect(debuggee.sent).toEqual([1, 3]);

      debuggee.releaseFirst();
      expect(yield* Queue.take(replies)).toBe(1);
      expect(debuggee.sent).toEqual([1, 3, 2]);
    }).pipe(Effect.scoped),
  );

  it.effect("stops waiting on a screenshot the page navigated away from", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const replies = yield* watchReplies(host);

      yield* command(host, 1, "Page.captureScreenshot");
      yield* command(host, 2, "Page.captureScreenshot");
      yield* command(host, 3, "Page.captureScreenshot");
      yield* settle;
      debuggee.navigate();
      expect(debuggee.sent).toEqual([1, 2]);

      // The superseded screenshot answering late must not start a third beside the second.
      debuggee.releaseFirst();
      expect(yield* Queue.take(replies)).toBe(1);
      expect(debuggee.sent).toEqual([1, 2]);

      debuggee.releaseFirst();
      expect(yield* Queue.take(replies)).toBe(2);
      expect(debuggee.sent).toEqual([1, 2, 3]);
    }).pipe(Effect.scoped),
  );

  it.effect("ends an input hold the released relay can no longer end", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      yield* host.handleCommandLine(encodeJson({ type: "release", ...key }));
      expect(debuggee.own.map(({ method, params }) => [method, params])).toEqual([
        ["Input.setIgnoreInputEvents", { ignore: false }],
        ["Runtime.evaluate", { expression: "globalThis.__goatAgentInputHeld = 0" }],
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("stops the screencast a released relay left running", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);

      const started = debuggee.nextSend();
      yield* command(host, 1, "Page.startScreencast");
      yield* Effect.promise(() => started);
      debuggee.release();
      const stopped = debuggee.sentOwn("Page.stopScreencast");
      yield* host.handleCommandLine(encodeJson({ type: "release", ...key }));
      yield* Effect.promise(() => stopped);
      expect(debuggee.own.map(({ method }) => method)).toContain("Page.stopScreencast");
    }),
  );

  it.effect("drops screenshots a released relay left waiting", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);

      yield* command(host, 1, "Page.captureScreenshot");
      yield* command(host, 2, "Page.captureScreenshot");
      yield* settle;
      yield* host.handleCommandLine(encodeJson({ type: "release", ...key }));
      yield* command(host, 3, "Page.captureScreenshot");
      expect(debuggee.sent).toEqual([1]);

      const sent = debuggee.nextSend();
      debuggee.release();
      yield* Effect.promise(() => sent);
      expect(debuggee.sent).toEqual([1, 3]);
    }),
  );
});
