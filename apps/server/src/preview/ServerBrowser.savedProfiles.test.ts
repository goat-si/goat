import * as NodeEvents from "node:events";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { EnvironmentId, type BrowserProfile, type PreviewAutomationStatus } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { BrowserContext, Page } from "playwright-core";
import { expect, vi } from "vite-plus/test";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as DesktopChannel from "./DesktopBrowserChannel.ts";
import * as Manager from "./Manager.ts";
import * as PreviewAgentActivity from "./PreviewAgentActivity.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";
import { unusedPreviewBrowser } from "./PreviewBrowser.testkit.ts";
import { historyMemoryLayer } from "./BrowserHistoryAssertions.testkit.ts";
import * as ServerBrowser from "./ServerBrowser.ts";
import { makeSession, scope } from "./ServerBrowserTestFixtures.ts";

// The stated cap: two full client reports (BROWSER_PROFILE_MAX_COUNT is 24 each).
const SAVED_BROWSER_PROFILES_MAX = 48;
const contextRequests: Array<{ profileId: string; isolated: boolean }> = [];
vi.mock("./ServerBrowserContexts.ts", () => ({
  presentAsChrome: async () => {},
  ServerBrowserContexts: class {
    async contextFor(profileId: string, isolationKey?: string) {
      contextRequests.push({ profileId, isolated: isolationKey !== undefined });
      return makeContext() as unknown as BrowserContext;
    }
    storePin = async () => undefined;
    pinStore = async (_profileId: string, store: string) => store;
    withProfile = <A>(_profileId: string, run: () => Promise<A>) => run();
    async close() {}
  },
}));

function makeContext() {
  const events = new NodeEvents.EventEmitter();
  let url = "about:blank";
  let closed = false;
  const page = {
    on: (name: string, callback: (...args: unknown[]) => void) => events.on(name, callback),
    once: (name: string, callback: (...args: unknown[]) => void) => events.once(name, callback),
    off: (name: string, callback: (...args: unknown[]) => void) => events.off(name, callback),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    context: () => context,
    mainFrame: () => page,
    frames: () => [page],
    url: () => url,
    title: async () => "test page",
    viewportSize: () => ({ width: 1280, height: 800 }),
    setViewportSize: async () => {},
    goto: async (next: string) => {
      url = next;
      events.emit("load");
    },
    emulateMedia: async () => {},
    isClosed: () => closed,
    close: async () => {
      if (closed) return;
      closed = true;
      events.emit("close");
    },
  };
  const context = {
    on: () => context,
    newPage: async () => page as unknown as Page,
    grantPermissions: async () => {},
    cookies: async () => [],
    newCDPSession: async () => makeSession(),
    close: async () => page.close(),
  };
  return context;
}

const dependencies = Layer.mergeAll(
  ServerSettings.layerTest(),
  historyMemoryLayer,
  Broker.layer,
  Manager.layer,
  Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(EnvironmentId.make("browser-test-environment")),
    getDescriptor: Effect.die("unused descriptor"),
  }),
  Layer.succeed(PreviewBrowser.PreviewBrowser, unusedPreviewBrowser),
  Layer.succeed(DesktopChannel.DesktopBrowserChannel, {
    available: false,
    awaitAttached: () => Effect.succeed(false),
    detached: Stream.never,
    attached: Stream.never,
    isAttached: () => Effect.succeed(false),
    endpoint: () => Effect.die("desktop is not used"),
    pointer: () => Effect.void,
    turn: () => Effect.void,
  }),
  PreviewAgentActivity.layer,
  Layer.mock(SecretRequests.SecretRequests)({}),
).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "goat-saved-profiles-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const persistent = (name: string): BrowserProfile => ({
  id: `profile-${name.toLowerCase()}`,
  name,
  kind: "persistent",
});

// Holds the next profile save at its temp-file cleanup, after the rename, until released.
const gateSaveCleanup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const cleanupStarted = yield* Deferred.make<void>();
  const releaseCleanup = yield* Deferred.make<void>();
  let paused = false;
  return {
    cleanupStarted,
    releaseCleanup,
    pauseNext: () => {
      paused = true;
    },
    fs: FileSystem.FileSystem.of({
      ...fs,
      remove: (target, options) =>
        fs.remove(target, options).pipe(
          Effect.tap(() => {
            if (!paused) return Effect.void;
            paused = false;
            return Deferred.succeed(cleanupStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseCleanup)),
            );
          }),
        ),
    }),
  };
});

const savedPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  return path.join(stateDir, "server-browser", "reported-profiles.json");
});

/** A fresh server browser on the same state directory, as after a restart. */
const afterRestart = <A, E>(
  run: Effect.Effect<A, E, Broker.PreviewAutomationBroker | ServerBrowser.ServerBrowser>,
) =>
  Effect.gen(function* () {
    yield* ServerBrowser.ServerBrowser;
    yield* Effect.yieldNow;
    return yield* run;
  }).pipe(Effect.provide(Layer.fresh(ServerBrowser.layer)));

const statusNow = Effect.gen(function* () {
  const broker = yield* Broker.PreviewAutomationBroker;
  return yield* broker.invoke<PreviewAutomationStatus>({ scope, operation: "status", input: {} });
});

const openProfile = (profileId: string) =>
  Effect.gen(function* () {
    const broker = yield* Broker.PreviewAutomationBroker;
    return yield* broker.invoke<PreviewAutomationStatus>({
      scope,
      operation: "open",
      input: { reuseExistingTab: false, show: false, profileId },
    });
  });

it.effect(
  "an agent opens a reported profile after a restart, before any client reports again",
  () =>
    Effect.gen(function* () {
      contextRequests.length = 0;
      const gate = yield* gateSaveCleanup;
      // Together the two clients report more profiles than one report may hold.
      const fromA = [
        persistent("Work"),
        ...Array.from({ length: 12 }, (_, n) => persistent(`A${n}`)),
      ];
      const fromB = [
        persistent("Shared"),
        ...Array.from({ length: 12 }, (_, n) => persistent(`B${n}`)),
      ];
      yield* Effect.gen(function* () {
        const browser = yield* ServerBrowser.ServerBrowser;
        const clientA = yield* Scope.make();
        const reportFromA = yield* browser.profileReporter.pipe(
          Effect.provideService(Scope.Scope, clientA),
        );
        const reportFromB = yield* browser.profileReporter;
        const reportFromC = yield* browser.profileReporter;
        yield* reportFromA({ profiles: fromA, defaultProfileId: "profile-work" });
        gate.pauseNext();
        const savingB = yield* reportFromB({
          profiles: fromB,
          defaultProfileId: "profile-shared",
        }).pipe(Effect.forkScoped({ startImmediately: true }));
        // A save that ends without reaching the gate fails the test instead of hanging it.
        yield* Effect.raceFirst(
          Deferred.await(gate.cleanupStarted),
          Fiber.join(savingB).pipe(
            Effect.andThen(Effect.die("save finished before the cleanup gate")),
          ),
        );
        // C's save waits behind B's while the client that reported Work disconnects, as at shutdown.
        const savingC = yield* reportFromC({
          profiles: [],
          defaultProfileId: "profile-shared",
        }).pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Scope.close(clientA, Exit.void);
        yield* Deferred.succeed(gate.releaseCleanup, undefined);
        yield* Fiber.join(savingB);
        yield* Fiber.join(savingC);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.fresh(ServerBrowser.layer).pipe(
            Layer.provide(Layer.succeed(FileSystem.FileSystem, gate.fs)),
          ),
        ),
      );

      const restarted = yield* afterRestart(openProfile("Work"));

      expect(contextRequests).toEqual([{ profileId: "profile-work", isolated: false }]);
      expect(restarted.tabs).toMatchObject([{ profileId: "profile-work" }]);
      expect(restarted).toMatchObject({
        defaultProfileId: "profile-shared",
        profiles: [
          { id: "default", name: "Default" },
          { id: "incognito", name: "Incognito", incognito: true },
          ...[...fromA, ...fromB].map(({ id, name }) => ({ id, name })),
        ],
      });
      expect(restarted.savedProfilesUnreadable).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect(
  `keeps the newest ${SAVED_BROWSER_PROFILES_MAX} reported profiles across a restart, oldest out`,
  () =>
    Effect.gen(function* () {
      const reported = Array.from({ length: 3 }, (_, client) =>
        Array.from({ length: 20 }, (_, n) => persistent(`C${client}P${n}`)),
      );
      yield* Effect.gen(function* () {
        const browser = yield* ServerBrowser.ServerBrowser;
        for (const profiles of reported) {
          const report = yield* browser.profileReporter;
          yield* report({ profiles, defaultProfileId: profiles[0]!.id });
        }
      }).pipe(Effect.scoped, Effect.provide(Layer.fresh(ServerBrowser.layer)));

      const restarted = yield* afterRestart(statusNow);

      const all = reported.flat();
      expect(SAVED_BROWSER_PROFILES_MAX).toBeLessThan(all.length);
      expect(restarted.profiles).toEqual([
        { id: "default", name: "Default" },
        { id: "incognito", name: "Incognito", incognito: true },
        ...all.slice(-SAVED_BROWSER_PROFILES_MAX).map(({ id, name }) => ({ id, name })),
      ]);
      expect(restarted.defaultProfileId).toBe("profile-c2p0");
    }).pipe(Effect.provide(dependencies)),
);

it.effect("warns at startup about a saved profile catalog it cannot read or decode", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = yield* savedPath;
    const startup = (saved: "missing" | "empty" | "invalid" | "unreadable") =>
      Effect.gen(function* () {
        const messages: string[] = [];
        yield* fs.remove(file, { recursive: true, force: true });
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        if (saved === "empty") yield* fs.writeFileString(file, "");
        if (saved === "invalid") yield* fs.writeFileString(file, "{");
        if (saved === "unreadable") yield* fs.makeDirectory(file);
        const logger = Logger.make(({ message }) => {
          messages.push(String(message));
        });
        const status = yield* afterRestart(statusNow).pipe(
          Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        );
        return {
          warnings: messages.filter((message) => message.includes("saved browser profiles")),
          profiles: status.profiles?.map((profile) => profile.id),
          savedProfilesUnreadable: status.savedProfilesUnreadable,
        };
      });
    const builtIns = ["default", "incognito"];

    expect(yield* startup("missing")).toEqual({ warnings: [], profiles: builtIns });
    expect(yield* startup("empty")).toEqual({ warnings: [], profiles: builtIns });
    expect(yield* startup("invalid")).toEqual({
      warnings: [expect.stringContaining("ignoring invalid saved browser profiles")],
      profiles: builtIns,
      savedProfilesUnreadable: true,
    });
    expect(yield* startup("unreadable")).toEqual({
      warnings: [expect.stringContaining("failed to read saved browser profiles")],
      profiles: builtIns,
      savedProfilesUnreadable: true,
    });
  }).pipe(Effect.provide(dependencies)),
);

it.effect("a client's report replaces an unreadable saved catalog and the notice clears", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* savedPath;
    yield* fs.makeDirectory((yield* Path.Path).dirname(file), { recursive: true });
    yield* fs.writeFileString(file, "{");
    const afterReport = yield* afterRestart(
      Effect.gen(function* () {
        const report = yield* (yield* ServerBrowser.ServerBrowser).profileReporter;
        yield* report({ profiles: [persistent("Work")], defaultProfileId: "profile-work" });
        return yield* statusNow;
      }).pipe(Effect.scoped),
    );
    expect(afterReport.savedProfilesUnreadable).toBeUndefined();
    expect(afterReport.profiles?.map((profile) => profile.id)).toContain("profile-work");
    const restarted = yield* afterRestart(statusNow);
    expect(restarted.savedProfilesUnreadable).toBeUndefined();
    expect(restarted.defaultProfileId).toBe("profile-work");
  }).pipe(Effect.provide(dependencies)),
);

it.effect("a report interrupted while an earlier save holds the lock is still saved", () =>
  Effect.gen(function* () {
    contextRequests.length = 0;
    const gate = yield* gateSaveCleanup;
    const work = persistent("Work");
    const late = persistent("Late");
    yield* Effect.gen(function* () {
      const report = yield* (yield* ServerBrowser.ServerBrowser).profileReporter;
      gate.pauseNext();
      const saving = yield* report({ profiles: [work], defaultProfileId: "profile-work" }).pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* Effect.raceFirst(
        Deferred.await(gate.cleanupStarted),
        Fiber.join(saving).pipe(
          Effect.andThen(Effect.die("save finished before the cleanup gate")),
        ),
      );
      // The client disconnects while its report waits for the save in progress.
      const waiting = yield* report({
        profiles: [work, late],
        defaultProfileId: "profile-late",
      }).pipe(Effect.forkScoped({ startImmediately: true }));
      waiting.interruptUnsafe();
      yield* Deferred.succeed(gate.releaseCleanup, undefined);
      yield* Fiber.join(saving);
      yield* Fiber.await(waiting);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.fresh(ServerBrowser.layer).pipe(
          Layer.provide(Layer.succeed(FileSystem.FileSystem, gate.fs)),
        ),
      ),
    );

    const restarted = yield* afterRestart(openProfile("Late"));

    expect(restarted).toMatchObject({
      defaultProfileId: "profile-late",
      tabs: [{ profileId: "profile-late" }],
    });
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);
