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
  yield* ipc
    .handle(
      DesktopIpc.makeIpcMethod({
        channel: "test:set-enabled",
        payload: Schema.Struct({ enabled: Schema.Boolean }),
        result: Schema.Boolean,
        handler: (input) => Effect.sync(() => (ran.invoke(input), input.enabled)),
      }),
    )
    .pipe(
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
  yield* ipc.handleSync(
    DesktopIpc.makeSyncIpcMethod({
      channel: "test:get-secret",
      result: Schema.String,
      handler: () => Effect.sync(() => (ran.sync(), "secret")),
    }),
  );
  return {
    main,
    trusted,
    warnings,
    ran,
    invoke: (event: DesktopIpc.DesktopIpcIncomingEvent, raw: unknown) =>
      Promise.resolve(invokeListeners.get("test:set-enabled")!(event, raw)),
    sendSync: (event: DesktopIpc.DesktopIpcIncomingEvent) => {
      const syncEvent = { ...event, returnValue: undefined as unknown };
      syncListeners.get("test:get-secret")!(syncEvent);
      return syncEvent.returnValue;
    },
  };
});

type Harness = Effect.Success<ReturnType<typeof setup>>;

const untrustedSenders: ReadonlyArray<{
  readonly name: string;
  readonly event: (harness: Harness) => DesktopIpc.DesktopIpcIncomingEvent;
}> = [
  {
    name: "a subframe of the main window",
    event: ({ main }) => ({ sender: main.webContents, senderFrame: { frame: "child", id: 1 } }),
  },
  { name: "an unrelated window", event: () => topFrameOf(makeWindow(2)) },
  {
    name: "a frame that navigated away or was detached",
    event: ({ main }) => ({ sender: main.webContents, senderFrame: null }),
  },
  {
    name: "a destroyed main window",
    event: ({ main }) => {
      main.destroy();
      return topFrameOf(main);
    },
  },
  {
    name: "a main window that has closed",
    event: (harness) => {
      harness.trusted.current = Option.none();
      return topFrameOf(harness.main);
    },
  },
  {
    name: "a main window that a new main window replaced",
    event: (harness) => {
      harness.trusted.current = Option.some(makeWindow(3));
      return topFrameOf(harness.main);
    },
  },
];

describe("DesktopIpc sender boundary", () => {
  it.effect("answers invoke and sync calls from the main window's top frame", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* setup();
        const result = yield* Effect.promise(() =>
          harness.invoke(topFrameOf(harness.main), { enabled: true }),
        );
        expect(result).toBe(true);
        expect(harness.ran.invoke).toHaveBeenCalledWith({ enabled: true });
        expect(harness.sendSync(topFrameOf(harness.main))).toBe("secret");
        expect(harness.warnings).toEqual([]);
      }),
    ),
  );

  it.effect.each(untrustedSenders)(
    "refuses $name before decoding the payload or running the method",
    ({ event }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* setup();
          const sender = event(harness);
          // The payload is invalid on purpose: a refusal, never a schema error, proves the
          // sender check runs before decoding.
          const outcome = yield* Effect.promise(() =>
            harness.invoke(sender, { enabled: "yes" }).then(
              () => ({ refused: false, message: "" }),
              (error: unknown) => ({ refused: true, message: String(error) }),
            ),
          );
          expect(outcome.refused).toBe(true);
          expect(outcome.message).toMatch(/untrusted sender/);
          expect(harness.ran.invoke).not.toHaveBeenCalled();
          expect(harness.warnings).toHaveLength(1);

          expect(harness.sendSync(sender)).toBeNull();
          expect(harness.ran.sync).not.toHaveBeenCalled();
        }),
      ),
  );
});
