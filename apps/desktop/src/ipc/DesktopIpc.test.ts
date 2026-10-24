import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

import * as DesktopIpc from "./DesktopIpc.ts";

const makeWindow = (id: number) => {
  let destroyed = false;
  const webContents = { id, mainFrame: { frame: "top", id }, isDestroyed: () => destroyed };
  return {
    webContents,
    destroy: () => {
      destroyed = true;
    },
  };
};
type FakeWindow = ReturnType<typeof makeWindow>;

const topFrameOf = (window: FakeWindow) => ({
  sender: window.webContents,
  senderFrame: window.webContents.mainFrame,
});

const INVOKE_CHANNEL = "test:set-enabled";
const SYNC_CHANNEL = "test:get-secret";

// Builds a DesktopIpc whose trusted window the test can close or replace, with one
// invoke method and one sync method that record whether they ran.
const setup = Effect.fn(function* () {
  const invokeListeners = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
  const syncListeners = new Map<string, DesktopIpc.DesktopIpcSyncListener>();
  const main = makeWindow(1);
  const trusted = { current: Option.some<FakeWindow>(main) };
  const warnings: Array<unknown> = [];
  const ran = { invoke: vi.fn(), sync: vi.fn() };
  const ipc = DesktopIpc.make(
    {
      removeHandler: (channel) => invokeListeners.delete(channel),
      handle: (channel, listener) => invokeListeners.set(channel, listener),
      removeAllListeners: (channel) => syncListeners.delete(channel),
      on: (channel, listener) => syncListeners.set(channel, listener),
    },
    Effect.sync(() => trusted.current),
  );
  yield* Effect.all([
    ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: INVOKE_CHANNEL,
        payload: Schema.Struct({ enabled: Schema.Boolean }),
        result: Schema.Boolean,
        handler: (input) => Effect.sync(() => (ran.invoke(input), input.enabled)),
      }),
    ),
    ipc.handleSync(
      DesktopIpc.makeSyncIpcMethod({
        channel: SYNC_CHANNEL,
        result: Schema.String,
        handler: () => Effect.sync(() => (ran.sync(), "secret")),
      }),
    ),
  ]).pipe(
    Effect.provide(
      Logger.layer(
        [
          Logger.make(({ logLevel, message }) => {
            if (logLevel === "Warn") warnings.push(message);
          }),
        ],
        { mergeWithExisting: false },
      ),
    ),
  );
  return {
    main,
    trusted,
    warnings,
    ran,
    // Settles to the result, or to the rejection message the renderer would see.
    invoke: (event: DesktopIpc.DesktopIpcIncomingEvent, raw: unknown) =>
      Effect.promise(() =>
        Promise.resolve(invokeListeners.get(INVOKE_CHANNEL)!(event, raw)).then(
          (value) => ({ refused: false, value }),
          (error: unknown) => ({ refused: true, value: String(error) }),
        ),
      ),
    sendSync: (event: DesktopIpc.DesktopIpcIncomingEvent) => {
      const syncEvent = Object.assign(Object.create(event) as typeof event, {
        returnValue: undefined as unknown,
      });
      syncListeners.get(SYNC_CHANNEL)!(syncEvent);
      return syncEvent.returnValue;
    },
  };
});

type Harness = Effect.Success<ReturnType<typeof setup>>;

const refusalLog = (channel: string, reason: string) => [
  "desktop IPC refused an untrusted sender",
  expect.objectContaining({ channel, reason }),
];

const untrustedSenders: ReadonlyArray<{
  readonly name: string;
  readonly reason: string;
  readonly event: (harness: Harness) => DesktopIpc.DesktopIpcIncomingEvent;
}> = [
  {
    name: "a subframe of the main window",
    reason: "not-top-frame",
    event: ({ main }) => ({ sender: main.webContents, senderFrame: { frame: "child", id: 1 } }),
  },
  {
    name: "the still-unloading top frame of a document the main window navigated away from",
    reason: "not-top-frame",
    event: ({ main }) => {
      const previousTopFrame = main.webContents.mainFrame;
      main.webContents.mainFrame = { frame: "top", id: 99 };
      return { sender: main.webContents, senderFrame: previousTopFrame };
    },
  },
  {
    name: "a frame Electron reports as gone",
    reason: "frame-detached",
    event: ({ main }) => ({ sender: main.webContents, senderFrame: null }),
  },
  {
    name: "a frame whose inspection throws because it was torn down",
    reason: "sender-destroyed",
    event: ({ main }) => ({
      sender: main.webContents,
      get senderFrame(): unknown {
        throw new Error("Object has been destroyed");
      },
    }),
  },
  {
    name: "an unrelated window",
    reason: "untrusted-window",
    event: () => topFrameOf(makeWindow(2)),
  },
  {
    name: "a destroyed main window",
    reason: "sender-destroyed",
    event: ({ main }) => {
      main.destroy();
      return topFrameOf(main);
    },
  },
  {
    name: "a main window that has closed",
    reason: "no-main-window",
    event: (harness) => {
      harness.trusted.current = Option.none();
      return topFrameOf(harness.main);
    },
  },
  {
    name: "a main window that a new main window replaced",
    reason: "untrusted-window",
    event: (harness) => {
      harness.trusted.current = Option.some(makeWindow(3));
      return topFrameOf(harness.main);
    },
  },
];

describe("DesktopIpc sender boundary", () => {
  it.effect("answers invoke and sync calls from the main window's top frame", () =>
    Effect.gen(function* () {
      const harness = yield* setup();
      expect(yield* harness.invoke(topFrameOf(harness.main), { enabled: true })).toEqual({
        refused: false,
        value: true,
      });
      expect(harness.ran.invoke).toHaveBeenCalledWith({ enabled: true });
      expect(harness.sendSync(topFrameOf(harness.main))).toBe("secret");
      expect(harness.warnings).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect.each(untrustedSenders)(
    "refuses $name before decoding the payload or running the method",
    ({ event, reason }) =>
      Effect.gen(function* () {
        const harness = yield* setup();
        const sender = event(harness);
        // The payload is invalid on purpose: a refusal, never a schema error, proves the
        // sender check runs before decoding.
        const outcome = yield* harness.invoke(sender, { enabled: "yes" });
        expect(outcome.refused).toBe(true);
        expect(outcome.value).toContain(`refused ${INVOKE_CHANNEL} from an untrusted sender`);
        expect(harness.ran.invoke).not.toHaveBeenCalled();

        // sendSync blocks the renderer until it gets a reply, so a refusal still answers.
        expect(harness.sendSync(sender)).toBeNull();
        expect(harness.ran.sync).not.toHaveBeenCalled();

        expect(harness.warnings).toEqual([
          refusalLog(INVOKE_CHANNEL, reason),
          refusalLog(SYNC_CHANNEL, reason),
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect("follows the main window as it closes and a new one opens", () =>
    Effect.gen(function* () {
      const harness = yield* setup();
      const first = harness.main;
      const second = makeWindow(2);

      harness.trusted.current = Option.none();
      expect((yield* harness.invoke(topFrameOf(first), { enabled: true })).refused).toBe(true);

      harness.trusted.current = Option.some(first);
      expect((yield* harness.invoke(topFrameOf(first), { enabled: true })).refused).toBe(false);

      harness.trusted.current = Option.some(second);
      expect((yield* harness.invoke(topFrameOf(first), { enabled: true })).refused).toBe(true);
      expect((yield* harness.invoke(topFrameOf(second), { enabled: false })).refused).toBe(false);
      expect(harness.sendSync(topFrameOf(second))).toBe("secret");
      expect(harness.sendSync(topFrameOf(first))).toBeNull();

      expect(harness.ran.invoke.mock.calls).toEqual([[{ enabled: true }], [{ enabled: false }]]);
    }).pipe(Effect.scoped),
  );
});
