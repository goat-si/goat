import { RegistryContext } from "@effect/atom-react";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionTarget,
  type ConnectionCredential,
} from "@goat/client-runtime/connection";
import { managedRelaySessionAtom } from "@goat/client-runtime/relay";
import { BotProfile, ChannelListOpenAsksResult, EnvironmentId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AtomRegistry } from "effect/reactivity";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { act, createContext, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  credentials: new Map<string, ConnectionCredential>(),
  secureItems: new Map<string, string>(),
  runDatabase: vi.fn(),
  open: vi.fn(),
  registry: undefined as unknown as AtomRegistry.AtomRegistry,
  width: 400,
  appState: {
    currentState: "active",
    listeners: new Set<(state: string) => void>(),
    addEventListener: (_event: string, listener: (state: string) => void) => {
      fixture.appState.listeners.add(listener);
      return { remove: () => fixture.appState.listeners.delete(listener) };
    },
  },
}));
vi.mock("../../persistence/mobile-database-migration", () => ({
  openMigratedMobileDatabase: fixture.open,
}));
vi.mock("../../lib/runtime", () => ({
  runtime: { runPromise: fixture.runDatabase, runPromiseExit: async () => ({ _tag: "Success" }) },
}));
vi.mock("../../connection/runtime", async () => {
  const { CredentialStore } = await import("@goat/client-runtime/connection");
  const { Atom } = await import("effect/reactivity");
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  const Option = await import("effect/Option");
  return {
    connectionAtomRuntime: Atom.runtime(
      Layer.succeed(CredentialStore.ConnectionCredentialStore, {
        get: (id) => Effect.sync(() => Option.fromNullishOr(fixture.credentials.get(id))),
        put: () => Effect.void,
        remove: () => Effect.void,
      }),
    ),
  };
});
vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "sha256" },
  digestStringAsync: async (algorithm: string, value: string) =>
    NodeCrypto.createHash(algorithm).update(value).digest("hex"),
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => fixture.secureItems.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void fixture.secureItems.set(key, value),
  deleteItemAsync: async (key: string) => void fixture.secureItems.delete(key),
}));
vi.mock("expo-haptics", () => ({ impactAsync: async () => {} }));
vi.mock("react-native", () => ({
  AppState: fixture.appState,
  Platform: { OS: "android" },
  useWindowDimensions: () => ({ width: fixture.width, height: 800 }),
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Pressable: ({ children }: { children?: ReactNode }) => <button>{children}</button>,
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaInsetsContext: createContext(null),
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));
vi.mock("react-native-keyboard-controller", () => ({
  useKeyboardState: () => false,
}));
vi.mock("react-native-reanimated", async () => {
  const { useRef } = await import("react");
  return {
    default: { View: ({ children }: { children?: ReactNode }) => <div>{children}</div> },
    Easing: { inOut: () => undefined, cubic: () => undefined },
    ReduceMotion: { System: "system" },
    runOnJS: () => () => {},
    useSharedValue: (value: unknown) =>
      useRef({
        value,
        set(next: unknown) {
          this.value = next;
        },
      }).current,
    useAnimatedStyle: () => ({}),
    useDerivedValue: () => ({ value: 0 }),
    withTiming: (value: number) => value,
  };
});
vi.mock("@react-navigation/native", () => ({
  useFocusEffect: () => {},
  useNavigation: () => ({}),
  useNavigationState: (select: (state: unknown) => unknown) =>
    select({ index: 0, routes: [{ name: "Home" }] }),
}));
vi.mock("../../state/atom-registry", () => ({
  get appAtomRegistry() {
    return fixture.registry;
  },
}));
vi.mock("../../connection/catalog", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentCatalog: {
      catalogValueAtom: Atom.make({ entries: new Map(), isReady: true }).pipe(Atom.keepAlive),
    },
  };
});
vi.mock("../../state/presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentPresentations: { presentationsAtom: Atom.make(new Map()) } };
});
vi.mock("../../state/session", async () => {
  const { Atom } = await import("effect/reactivity");
  const Option = await import("effect/Option");
  const prepared = Atom.make(Option.none()).pipe(Atom.keepAlive);
  return { environmentSession: { preparedConnectionValueAtom: () => prepared } };
});
vi.mock("../../state/preferences", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return {
    mobilePreferencesAtom: Atom.make(AsyncResult.success({ homeMode: "bot" })),
    updateMobilePreferencesAtom: Atom.make(null),
  };
});
vi.mock("../../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../../state/threads", () => ({ steadyNavigationThreadShellsAtom: null }));
vi.mock("../../state/channels", () => ({ channelEnvironment: {} }));
vi.mock("./openAsksRead", () => ({ openAsks: () => null }));
vi.mock("../../state/workspace", () => ({
  useWorkspaceState: () => ({ environments: [], state: { hasConnections: true } }),
}));
vi.mock("../../state/use-pending-new-tasks", () => ({
  useLaunchingThreads: () => [],
  usePendingNewTasks: () => [],
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => ({ savedConnectionsById: new Map() }),
}));
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerCloudAccountId: async () => null,
  restoreCloudComposerDrafts: async () => {},
}));
vi.mock("../agent-awareness/remoteRegistration", () => ({
  releaseAgentAwarenessRelayTokenProvider: () => {},
  setAgentAwarenessRelayTokenProvider: () => {},
  unregisterAgentAwarenessDeviceForCurrentUser: () => Effect.void,
}));
vi.mock("../cloud/cloud-drafts", async () => {
  const { AsyncResult } = await import("effect/reactivity");
  return { removeCloudEnvironments: { run: async () => AsyncResult.success(undefined) } };
});
vi.mock("../cloud/publicConfig", () => ({ resolveRelayClerkTokenOptions: () => undefined }));
vi.mock("../cloud/connectOnboarding", () => ({
  clearConnectOnboardingRequest: () => {},
  requestConnectOnboarding: () => {},
}));
vi.mock("./GoatBotFace", () => ({ GoatBotFaceAvatar: () => null }));
vi.mock("./MobileBotList", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./MobileBotList")>();
  const { default: OfflineBotRoster } = await import("./OfflineBotRoster");
  return {
    MobileBotList: ({ visible }: { visible: boolean }) =>
      fixture.width > 400 ? (
        <actual.MobileBotList visible={visible} />
      ) : (
        <OfflineBotRoster
          environmentId={null}
          visible={visible}
          computer={null}
          openBot={() => undefined}
        />
      ),
  };
});
vi.mock("./MobileBotRosterView", () => ({ MobileHomeSegments: () => null }));
vi.mock("./MobileBotEditSheet", () => ({ MobileBotEditSheet: () => null }));
vi.mock("./useMobileBotPreview", () => ({ useMobileBotPreview: () => null }));
vi.mock("./useMobileBotManage", () => ({ useMobileBotManage: () => ({}) }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, error: null, refresh: () => {} }),
}));
vi.mock("../../components/ui/AndroidAnchoredMenu", () => ({ AndroidAnchoredMenu: () => null }));
vi.mock("./useMobileGoatBotModel", () => ({ useMobileGoatBotModelMenu: () => null }));
vi.mock("./GoatBotModelAndroidMenu", () => ({ GoatBotModelAndroidMenu: () => null }));
vi.mock("../home/ThreadUndoNotice", () => ({ ThreadUndoNotice: () => null }));
vi.mock("../home/HomeScreen", () => ({ HomeScreen: () => <div>Threads view</div> }));
vi.mock("../home/HomeHeader", () => ({ HomeHeader: () => null }));
vi.mock("../home/AndroidHomeFab", () => ({
  AndroidHomeFabLayout: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../home/WorkspaceConnectionTitle", () => ({
  getConnectionAwareBrandHeaderOptions: () => ({}),
}));
vi.mock("../home/home-list-options", () => ({
  HomeListOptionsProvider: ({ children }: { children: ReactNode }) => children,
  useHomeListOptions: () => ({
    options: { selectedEnvironmentId: null, selectedProjectKey: null },
    setSelectedProjectKey: () => {},
  }),
}));
vi.mock("../home/home-route-visibility", () => ({
  useAtomValueWhileVisible: () => [],
  useHomeRouteVisibility: () => ({ visible: true }),
}));
vi.mock("../home/useThreadListActions", () => ({ useThreadListActions: () => ({}) }));
vi.mock("../home/usePendingTaskListActions", () => ({ usePendingTaskListActions: () => ({}) }));
vi.mock("../workspace/AndroidWorkspaceNavigation", () => ({
  AndroidWorkspaceNavigation: () => null,
  ANDROID_WORKSPACE_RAIL_WIDTH: 72,
}));
vi.mock("../workspace/AndroidWorkspaceSidebar", () => ({
  AndroidWorkspaceSidebar: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../workspace/AndroidWorkspaceTabsProvider", () => ({
  useAndroidWorkspaceRoot: () => null,
}));
vi.mock("../../native/AndroidHingeObserver", () => ({ AndroidHingeObserver: () => null }));
vi.mock("../threads/ThreadNavigationSidebar", () => ({
  ThreadNavigationSidebar: () => <div>Threads sidebar</div>,
}));
vi.mock("../threads/use-open-thread-pull-requests", () => ({
  useOpenThreadPullRequests: () => () => {},
}));
vi.mock("../../state/use-thread-pr", () => ({ withKnownPullRequestSummary: () => null }));
vi.mock("../keyboard/hardwareKeyboardCommands", () => ({
  useHardwareKeyboardCommand: () => {},
  parseActiveThreadPath: () => null,
}));
vi.mock("../layout/workspace-inspector-pane", () => ({ WorkspaceInspectorPane: () => null }));
vi.mock("../layout/WorkspaceEmptyDetail", () => ({ WorkspaceEmptyDetail: () => null }));
vi.mock("../updates/app-updates", () => ({
  checkForAppUpdateOnLaunch: async () => {},
  startAppUpdateForegroundRecheck: () => {},
}));
vi.mock("../workspace/WorkspaceTabsContext", () => ({ useWorkspaceTabs: () => null }));
vi.mock("../workspace/workspace-selection-store", () => ({
  currentWorkspaceSelections: () => ({}),
  workspaceSelectionCheck: {},
}));
vi.mock("../workspace/useSelectWorkspaceTab", () => ({ useSelectWorkspaceTab: () => () => {} }));
vi.mock("../workspace/useSelectWorkspaceDetail", () => ({
  startOpeningDetail: () => {},
  useSelectWorkspaceDetail: () => () => {},
}));
vi.mock("../settings/settings-navigation", () => ({ openSettings: () => {} }));
vi.mock("../../components/ui/Toolbar", () => ({ Toolbar: () => null }));
vi.mock("../../lib/copyTextWithHaptic", () => ({ copyTextWithHaptic: async () => {} }));
vi.mock("../../components/ui/AppText", () => ({ AppText: () => null }));
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("../../components/ui/AndroidScreenHeader", () => ({ AndroidScreenHeader: () => null }));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../native/native-layout-metrics", () => ({
  useDeviceType: () => "phone",
  useNativeLayoutMetrics: () => null,
  useNativeColumnLayoutMetrics: () => null,
}));

import { environmentCatalog } from "../../connection/catalog";
import { environmentSession } from "../../state/session";
import {
  botSummaryCloudAccountKey,
  botSummaryGlobalPurgeKey,
  layer,
  MobileDatabase,
} from "../../persistence/mobile-database";
import { cloudAccountService } from "../cloud/cloudAccountService";
import { HomeRouteScreen } from "../home/HomeRouteScreen";
import { AdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { installKeptSummaryPersistence, refuseConnection } from "./keptPerComputerStore";
import { createMobileKeptSummaryPersistence } from "./keptSummaryPersistence";

const env = EnvironmentId.make("studio");
const now = Date.parse("2026-11-22T10:42:00.000Z");
const day = 24 * 60 * 60 * 1000;
const bot = Schema.decodeUnknownSync(BotProfile)({
  botId: "scout",
  role: "member",
  name: "Scout",
  avatar: "🦉",
  purpose: "Private instructions",
  defaultProjectId: null,
  defaultModelSelection: null,
  environmentId: env,
  sessionThreadId: "private-thread",
  createdAt: new Date(now).toISOString(),
  updatedAt: new Date(now).toISOString(),
});

const asks = Schema.decodeUnknownSync(ChannelListOpenAsksResult)({
  asks: [
    {
      botId: "scout",
      kind: "approval",
      taskId: "task",
      text: "Private question",
      requestId: "private-request",
      askedAt: new Date(now).toISOString(),
    },
  ],
  total: 1,
  truncated: false,
});

function phone() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-bot-cache-"));
  const filename = NodePath.join(directory, "client.sqlite");
  fixture.credentials.clear();
  fixture.secureItems.clear();
  fixture.appState.currentState = "active";
  fixture.width = 400;
  let failDeletes = false;
  let failMarkers = false;
  let failAccountRead = false;
  let didFailDelete = Promise.withResolvers<void>();
  let nextSweep: PromiseWithResolvers<void> | undefined;
  let readTime = now;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => readTime);
  const run = <A, E>(effect: Effect.Effect<A, E, MobileDatabase>) =>
    fixture.runDatabase(effect) as Promise<A>;

  function inspect() {
    using sqlite = new NodeSqlite.DatabaseSync(filename);
    return sqlite.prepare("SELECT cache_key, payload FROM client_cache ORDER BY cache_key").all();
  }

  function open() {
    fixture.open.mockImplementation(async () => {
      const sqlite = new NodeSqlite.DatabaseSync(filename);
      if (!sqlite.prepare("PRAGMA user_version").get()?.user_version)
        sqlite.exec("PRAGMA user_version = 1");
      const native = {
        execAsync: async (sql: string) => sqlite.exec(sql),
        runAsync: async (sql: string, ...args: (string | number)[]) => {
          if (
            failMarkers &&
            (args[2] === "goat-bot-summary-purge" || args[2] === botSummaryGlobalPurgeKey) &&
            /INSERT INTO client_cache/.test(sql)
          )
            throw new Error("SQLite purge marker write failed");
          if (failDeletes && /DELETE FROM client_cache/.test(sql)) {
            didFailDelete.resolve();
            throw new Error("SQLite delete failed");
          }
          const result = sqlite.prepare(sql).run(...args);
          if (sql.includes("WITH pending_purges")) {
            nextSweep?.resolve();
            nextSweep = undefined;
          }
          return result;
        },
        getFirstAsync: async (sql: string, ...args: (string | number)[]) => {
          if (failAccountRead && args.includes(botSummaryCloudAccountKey))
            throw new Error("SQLite account read failed");
          return sqlite.prepare(sql).get(...args) ?? null;
        },
        getAllAsync: async (sql: string, ...args: (string | number)[]) =>
          sqlite.prepare(sql).all(...args),
        withExclusiveTransactionAsync: async (op: (db: unknown) => Promise<void>) => {
          await op(native);
        },
        closeAsync: async () => sqlite.close(),
      };
      return native;
    });
    // oxlint-disable-next-line goat/no-manual-effect-runtime-in-tests -- React calls the Promise bridge and each simulated launch owns its SQLite scope.
    const database = ManagedRuntime.make(layer);
    fixture.runDatabase.mockImplementation(database.runPromise);
    const registry = AtomRegistry.make();
    fixture.registry = registry;
    const persistence = createMobileKeptSummaryPersistence();
    const uninstall = installKeptSummaryPersistence(registry, persistence);
    const profile = new BearerConnectionProfile({
      environmentId: env,
      connectionId: "lan",
      label: "Studio",
      httpBaseUrl: "http://studio.test:3773/",
      wsBaseUrl: "ws://studio.test:3773/",
    });
    registry.set(
      environmentCatalog.catalogValueAtom as never,
      {
        isReady: true,
        entries: new Map([
          [
            env,
            {
              enabled: true,
              target: new BearerConnectionTarget({
                environmentId: env,
                connectionId: "lan",
                label: "Studio",
              }),
              profile: Option.some(profile),
            },
          ],
        ]),
      } as never,
    );
    function pair(token: string) {
      fixture.credentials.set("lan", new BearerConnectionCredential({ token }));
      registry.set(
        environmentSession.preparedConnectionValueAtom(env) as never,
        Option.some({ httpAuthorization: { _tag: "Bearer", token } }) as never,
      );
    }
    async function save(name: string, readAt = now) {
      const [scope] = await persistence.scopes(registry, env, true);
      if (scope === undefined) throw new Error("Expected an authorized pairing.");
      await persistence.store.keep(persistence.store.lease(env), "bots", scope, readAt, {
        bots: [{ ...bot, name }],
      });
    }
    async function saveAsk() {
      const [scope] = await persistence.scopes(registry, env, true);
      if (scope === undefined) throw new Error("Expected an authorized pairing.");
      await persistence.store.keep(persistence.store.lease(env), "asks", scope, now, asks);
    }
    async function restore() {
      const lease = persistence.store.lease(env);
      const scopes = await persistence.scopes(registry, env, false);
      return persistence.store.restore(lease, "bots", scopes, readTime);
    }
    return {
      registry,
      pair,
      save,
      saveAsk,
      restore,
      purge: persistence.store.purge,
      async [Symbol.asyncDispose]() {
        uninstall();
        registry.dispose();
        await database.dispose();
      },
    };
  }
  return {
    open,
    inspect,
    run,
    advance: (time: number) => {
      readTime = time;
    },
    failDelete() {
      failDeletes = true;
      didFailDelete = Promise.withResolvers<void>();
      return didFailDelete.promise;
    },
    allowDelete: () => {
      failDeletes = false;
    },
    failMarkers: () => {
      failMarkers = true;
    },
    failAccountRead: (fail: boolean) => {
      failAccountRead = fail;
    },
    onNextSweep: () => {
      nextSweep = Promise.withResolvers<void>();
      return nextSweep.promise;
    },
    [Symbol.dispose]() {
      clock.mockRestore();
      NodeFS.rmSync(directory, { recursive: true, force: true });
    },
  };
}

type ClerkListener = Parameters<Parameters<typeof cloudAccountService.attach>[0]["addListener"]>[0];
function observeClerk(accountId: string | null) {
  const attach = cloudAccountService.attach({
    addListener: (listener: ClerkListener) => {
      listener(
        (accountId === null
          ? { user: null, session: null }
          : {
              user: { id: accountId },
              session: { status: "active" },
            }) as Parameters<ClerkListener>[0],
      );
      return () => {};
    },
    session: null,
  } as Parameters<typeof cloudAccountService.attach>[0]);
  return { [Symbol.dispose]: attach };
}

function waitForOfflineRoster(container: HTMLElement) {
  const rendered = Promise.withResolvers<void>();
  const check = () => {
    if (container.textContent?.includes("Scout") && container.textContent.includes("Needs you · 1"))
      rendered.resolve();
  };
  const observer = new MutationObserver(check);
  observer.observe(container, { childList: true, subtree: true, characterData: true });
  check();
  return { rendered: rendered.promise, [Symbol.dispose]: () => observer.disconnect() };
}

it.each([
  ["compact Home", 400],
  ["the split sidebar", 1200],
] as const)(
  "opens the offline roster in %s with Bots saved and no saved bot ref or server config",
  async (_surface, width) => {
    using device = phone();
    {
      await using app = device.open();
      app.pair("token-a");
      await app.save("Scout");
      await app.saveAsk();
      expect(JSON.stringify(device.inspect())).not.toMatch(/Private question|private-request/);
    }
    await using app = device.open();
    fixture.width = width;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    using roster = waitForOfflineRoster(container);
    try {
      await act(async () =>
        root.render(
          <RegistryContext value={app.registry}>
            <AdaptiveWorkspaceLayout pathname="/" workspaceRouteKey={undefined}>
              <HomeRouteScreen />
            </AdaptiveWorkspaceLayout>
          </RegistryContext>,
        ),
      );
      await roster.rendered;
      expect(container.textContent).toContain("As of");
      expect(container.textContent).not.toContain("Threads view");
      expect(container.textContent).not.toContain("Threads sidebar");
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  },
);

it("keeps independently authorized pairings and refuses a different or missing credential", async () => {
  using device = phone();
  {
    await using app = device.open();
    app.pair("token-a");
    await app.save("Scout A");
    app.pair("token-b");
    await app.save("Scout B", now + 1);
  }
  await using app = device.open();
  app.pair("token-c");
  expect(await app.restore()).toBeNull();
  fixture.credentials.clear();
  expect(await app.restore()).toBeNull();
  app.pair("token-a");
  expect((await app.restore())?.data[0]?.name).toBe("Scout A");
  app.pair("token-b");
  expect((await app.restore())?.data[0]?.name).toBe("Scout B");
  expect(JSON.stringify(device.inspect())).not.toMatch(
    /token-[abc]|Private instructions|private-thread/,
  );
});

it("does not restore the refused pairing on relaunch after SQLite failed to delete its summary", async () => {
  using device = phone();
  using _warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  {
    await using app = device.open();
    app.pair("token-a");
    await app.save("Scout");
    const failed = device.failDelete();
    refuseConnection(app.registry, env);
    await failed;
  }
  await using app = device.open();
  await expect(app.restore()).rejects.toThrow("sweep-bot-summary-cache");
  device.allowDelete();
  expect(await app.restore()).toBeNull();
  expect(
    device.inspect().some((row) => String(row.cache_key).startsWith("goat-bot-summary:")),
  ).toBe(false);
});

it("deletes the refused environment's summaries when SQLite cannot write a purge marker", async () => {
  using device = phone();
  const other = EnvironmentId.make("other");
  let invalidated: boolean;
  {
    await using app = device.open();
    app.pair("token-a");
    await app.save("Scout");
    await app.saveAsk();
    const unrelated = device.inspect()[0];
    if (unrelated === undefined) throw new Error("Expected a saved summary.");
    await device.run(
      Effect.flatMap(MobileDatabase, (db) =>
        Effect.all([
          db.saveCache(other, "shell", String(unrelated.cache_key), 2, String(unrelated.payload)),
          db.saveCache(env, "shell", "meta", 1, "shell"),
        ]),
      ),
    );
    device.failMarkers();
    invalidated = await app.purge(env).then(
      () => true,
      () => false,
    );
  }
  await using app = device.open();
  expect(await app.restore()).toBeNull();
  expect(invalidated).toBe(true);
  expect(device.inspect()).toEqual([
    expect.objectContaining({ cache_key: expect.stringMatching(/^goat-bot-summary:/) }),
    { cache_key: "meta", payload: "shell" },
  ]);
});

it("fences restores across relaunch while both SQLite invalidation writes fail", async () => {
  using device = phone();
  using _warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  {
    await using app = device.open();
    app.pair("token-a");
    await app.save("Scout");
    device.failMarkers();
    void device.failDelete();
    await expect(app.purge(env)).rejects.toThrow("delete-bot-summary-cache");
    await expect(app.restore()).rejects.toThrow("delete-bot-summary-cache");
  }
  {
    await using app = device.open();
    await expect(app.restore()).rejects.toThrow("sweep-bot-summary-cache");
    device.allowDelete();
    expect(await app.restore()).toBeNull();
    app.pair("token-a");
    await app.save("Scout after a fresh read");
  }
  await using app = device.open();
  expect((await app.restore())?.data[0]?.name).toBe("Scout after a fresh read");
});

it("purges kept summaries on the first signed-out Clerk observation after relaunch", async () => {
  using device = phone();
  {
    await using app = device.open();
    const active = Promise.withResolvers<void>();
    using _subscription = {
      [Symbol.dispose]: app.registry.subscribe(managedRelaySessionAtom, (session) => {
        if (session?.accountId === "account-a") active.resolve();
      }),
    };
    using _clerk = observeClerk("account-a");
    await active.promise;
    await device.run(Effect.flatMap(MobileDatabase, (db) => db.clearAllCaches));
    app.pair("token-a");
    await app.save("Scout");
  }
  await using app = device.open();
  expect(await app.restore()).toBeNull();
  using _clerk = observeClerk(null);
  expect(await app.restore()).toBeNull();
  expect(
    device.inspect().some((row) => String(row.cache_key).startsWith("goat-bot-summary:")),
  ).toBe(false);
});

it("discards the previous summary on same-account sign-in after a cold sign-out with failed SQLite reads and writes", async () => {
  using device = phone();
  using _warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  {
    await using app = device.open();
    const active = Promise.withResolvers<void>();
    using _subscription = {
      [Symbol.dispose]: app.registry.subscribe(managedRelaySessionAtom, (session) => {
        if (session?.accountId === "account-a") active.resolve();
      }),
    };
    using _clerk = observeClerk("account-a");
    await active.promise;
    app.pair("token-a");
    await app.save("Scout");
  }
  {
    const swept = device.onNextSweep();
    await using app = device.open();
    await swept;
    device.failAccountRead(true);
    device.failMarkers();
    void device.failDelete();
    using _clerk = observeClerk(null);
    await expect(app.restore()).rejects.toThrow();
    expect(device.inspect().some((row) => String(row.payload).includes("Scout"))).toBe(true);
  }
  device.failAccountRead(false);
  device.allowDelete();
  await using app = device.open();
  const active = Promise.withResolvers<void>();
  using _subscription = {
    [Symbol.dispose]: app.registry.subscribe(managedRelaySessionAtom, (session) => {
      if (session?.accountId === "account-a") active.resolve();
    }),
  };
  using _clerk = observeClerk("account-a");
  await active.promise;
  expect(await app.restore()).toBeNull();
  app.pair("token-a");
  await app.save("Fresh Scout");
  expect((await app.restore())?.data[0]?.name).toBe("Fresh Scout");
});

it("sweeps expired rows at startup and foreground without an eligible pairing or roster, preserving older shell caches", async () => {
  using device = phone();
  const shell = JSON.stringify({ snapshotSequence: 3, capturedAt: new Date(now).toISOString() });
  {
    await using app = device.open();
    app.pair("token-a");
    await app.save("Fresh Scout");
    await device.run(
      Effect.flatMap(MobileDatabase, (db) =>
        Effect.all([
          db.saveCache(env, "shell", "meta", 1, shell),
          db.saveCache(
            env,
            "shell",
            "goat-bot-summary:asks",
            1,
            JSON.stringify({
              kind: "asks",
              scope: "unscoped-draft",
              readAt: now,
              data: { asks: [], total: 0, truncated: false },
            }),
          ),
          db.saveCache(
            env,
            "shell",
            "goat-bot-summary:bots:legacy-scope",
            1,
            JSON.stringify({
              kind: "bots",
              scope: "legacy-scope",
              readAt: now - 7 * day,
              data: [],
            }),
          ),
        ]),
      ),
    );
  }
  fixture.credentials.clear();
  const startupSweep = device.onNextSweep();
  await using _app = device.open();
  await startupSweep;
  expect(device.inspect().map((row) => row.cache_key)).not.toContain(
    "goat-bot-summary:bots:legacy-scope",
  );
  expect(device.inspect()).toHaveLength(2);
  device.advance(now + 7 * day);
  const foregroundSweep = device.onNextSweep();
  for (const state of ["background", "active"]) {
    fixture.appState.currentState = state;
    for (const listener of fixture.appState.listeners) listener(state);
  }
  await foregroundSweep;
  expect(device.inspect()).toEqual([{ cache_key: "meta", payload: shell }]);
  expect(
    await device.run(Effect.flatMap(MobileDatabase, (db) => db.loadCache(env, "shell", "meta"))),
  ).toEqual(Option.some(shell));
});
