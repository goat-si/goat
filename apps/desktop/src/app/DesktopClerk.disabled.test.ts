import * as NodePath from "@effect/platform-node/NodePath";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { afterAll, vi } from "vite-plus/test";

const { bridge, storage } = vi.hoisted(() => {
  vi.stubGlobal("__GOAT_BUILD_CLERK_PUBLISHABLE_KEY__", "pk_test_Y2xlcmsud3AxLmludmFsaWQk");
  return {
    bridge: vi.fn(() => {
      throw new Error("Unexpected Clerk bridge");
    }),
    storage: vi.fn(() => {
      throw new Error("Unexpected Clerk storage");
    }),
  };
});
afterAll(() => vi.unstubAllGlobals());
vi.mock("@clerk/electron", () => ({ createClerkBridge: bridge }));
vi.mock("@clerk/electron/storage", () => ({ storage }));

import * as DesktopClerk from "./DesktopClerk.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopWebLinks from "./DesktopWebLinks.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";

it.effect(
  "keeps desktop locking, schemes, second-instance and deep links without Clerk initialization or OAuth",
  () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const listeners = new Map<string, (...args: unknown[]) => void>();
      const revealed = yield* Queue.unbounded<void>();
      const promptReceived = yield* Deferred.make<string>();
      const received = yield* Deferred.make<string>();
      const shell = vi.fn(() => Effect.die("Unexpected external URL"));
      const loadURL = vi.fn(async (_value: string) => undefined);
      const window = { loadURL } as unknown as Electron.BrowserWindow;
      const configured = Effect.gen(function* () {
        const clerk = yield* DesktopClerk.DesktopClerk;
        yield* clerk.configure;
        const preventDefault = vi.fn();
        listeners.get("open-url")?.(
          { preventDefault },
          "goat-dev://clerk/oauth/callback?code=synthetic",
        );
        expect(preventDefault).not.toHaveBeenCalled();
        listeners.get("second-instance")?.({}, ["goat"]);
        yield* Queue.take(revealed);
        listeners.get("open-url")?.({ preventDefault }, "https://example.invalid/page");
        expect(yield* Deferred.await(received)).toBe("https://example.invalid/page");
        listeners.get("open-url")?.({ preventDefault }, "t3code://new?prompt=hello");
        expect(yield* Deferred.await(promptReceived)).toBe("t3code://new?prompt=hello");
        listeners.get("second-instance")?.({}, [
          "goat",
          "t3code-dev://app/settings/providers?instanceId=work&code=never-forward",
        ]);
        yield* Queue.take(revealed);
        expect(loadURL.mock.calls).toEqual([["goat-dev://app/settings/providers?instanceId=work"]]);
      });
      yield* configured.pipe(
        Effect.provide(
          Layer.mergeAll(
            DesktopClerk.layer.pipe(
              Layer.provideMerge(
                Layer.mergeAll(
                  NodePath.layerPosix,
                  Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
                    stateDir: "/tmp/wp1-s-desktop",
                    appDataDirectory: "/tmp/wp1-s-app-data",
                    isDevelopment: true,
                    appVersion: "1.2.3",
                    platform: "win32",
                  } as DesktopEnvironment.DesktopEnvironment["Service"]),
                  Layer.mock(ElectronApp.ElectronApp, {
                    setPath: (key, value) =>
                      Effect.sync(() => {
                        events.push(`${key}:${value}`);
                      }),
                    requestSingleInstanceLock: Effect.sync(() => {
                      events.push("lock");
                      return true;
                    }),
                    setAsDefaultProtocolClient: (scheme) =>
                      Effect.sync(() => {
                        events.push(scheme);
                        return true;
                      }),
                    on: (name, listener) =>
                      Effect.sync(() => {
                        listeners.set(name, listener as unknown as (...args: unknown[]) => void);
                      }),
                  }),
                  Layer.mock(ElectronShell.ElectronShell, { openExternal: shell }),
                ),
              ),
            ),
            Layer.mock(ElectronWindow.ElectronWindow, {
              currentMainOrFirst: Effect.succeedSome(window),
              reveal: () => Queue.offer(revealed, undefined).pipe(Effect.asVoid),
            }),
            Layer.mock(DesktopWebLinks.DesktopWebLinks, {
              receive: (value) =>
                Deferred.succeed(
                  value.startsWith("t3code:") ? promptReceived : received,
                  value,
                ).pipe(Effect.asVoid),
            }),
          ),
        ),
        Effect.provideService(HostProcess.Arguments, []),
        Effect.scoped,
      );
      expect(events).toEqual([
        "userData:/tmp/wp1-s-app-data/goat-desktop-dev",
        "lock",
        "goat-dev",
        "t3code-dev",
      ]);
      expect(bridge).not.toHaveBeenCalled();
      expect(storage).not.toHaveBeenCalled();
      expect(shell).not.toHaveBeenCalled();
      expect(DesktopClerk.desktopClerkFrontendApiHostname).toBeUndefined();
    }),
);
