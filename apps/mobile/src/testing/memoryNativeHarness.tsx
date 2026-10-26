import React, { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { vi } from "vite-plus/test";
import {
  EnvironmentId,
  MemoryId,
  MemorySpaceId,
  MemoryItem,
  MemorySyncStatus,
  MemoryImportProviderInput,
  MemoryImportProviderResult,
  MemoryOwnerSourceReadPolicyView,
  WS_METHODS,
  sessionGrantsScope,
  type AuthSessionState,
  type AuthEnvironmentScope,
  type ServerConfig,
  type MemoryChangeSignal,
} from "@goat/contracts";
import { createEnvironmentRpcCommand } from "@goat/client-runtime/state/runtime";
import { createMemoryEnvironmentAtoms } from "@goat/client-runtime/state/memory";
import {
  EnvironmentRegistry,
  EnvironmentSupervisor,
  type ConnectionCatalogEntry,
  type PreparedConnection,
} from "@goat/client-runtime/connection";
import type { MenuProps } from "../components/ui/Menu.types";
import type { RpcSession } from "@goat/client-runtime/rpc";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Schema from "effect/Schema";

// Synthetic native adapter only. Commands, permission checks, body queries and drafts are real.
const bridge = vi.hoisted(() => ({
  current: null as unknown,
  platform: "ios",
  projectRevision: 0,
  projectListeners: new Set<() => void>(),
  navigations: [] as unknown[],
  focus: new Map<() => void | (() => void), void | (() => void)>(),
  active: new Set<(state: string) => void>(),
  confirmations: [] as Array<() => void>,
  secure: new Map<string, string>(),
  beforeSecureWrite: null as (() => Promise<void>) | null,
  projects: [] as Array<{
    id: string;
    title: string;
    environmentId: EnvironmentId;
    repositoryIdentity?: null;
  }>,
}));
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  const View = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  const Text = ({ children }: { children?: ReactNode }) => createElement("span", null, children);
  const Pressable = (props: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
  }) =>
    createElement(
      "button",
      { disabled: props.disabled, onClick: props.onPress, "aria-label": props.accessibilityLabel },
      props.children,
    );
  const TextInput = (props: {
    value: string;
    onChangeText?: (value: string) => void;
    editable?: boolean;
    accessibilityLabel?: string;
  }) =>
    createElement("input", {
      value: props.value,
      disabled: props.editable === false,
      "aria-label": props.accessibilityLabel,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
        props.onChangeText?.(event.target.value),
    });
  const FlatList = (props: {
    data: unknown[];
    renderItem: (input: { item: unknown; index: number }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
    ListEmptyComponent?: ReactNode;
  }) =>
    createElement(
      "div",
      null,
      props.ListHeaderComponent,
      props.data.length
        ? props.data.map((item, index) =>
            createElement("div", { key: index }, props.renderItem({ item, index })),
          )
        : props.ListEmptyComponent,
      props.ListFooterComponent,
    );
  return {
    View,
    AppState: {
      addEventListener: (_: string, listener: (state: string) => void) => {
        bridge.active.add(listener);
        return { remove: () => bridge.active.delete(listener) };
      },
    },
    Modal: (props: { visible: boolean; children?: ReactNode }) =>
      props.visible ? createElement("div", { role: "dialog" }, props.children) : null,
    Text,
    Pressable,
    TextInput,
    FlatList,
    ScrollView: View,
    KeyboardAvoidingView: View,
    Platform: {
      get OS() {
        return bridge.platform;
      },
      Version: 26,
      isPad: false,
      select: (values: Record<string, unknown>) => values[bridge.platform] ?? values.default,
    },
    Alert: {
      alert: (_title: string, _message: string, buttons: Array<{ onPress?: () => void }>) => {
        const confirm = buttons.at(-1)?.onPress;
        if (confirm) bridge.confirmations.push(confirm);
      },
    },
    StyleSheet: { create: (value: unknown) => value },
  };
});
vi.mock("../persistence/namespaced-secure-store", () => ({
  secureStore: {
    getItem: (key: string) => Promise.resolve(bridge.secure.get(key) ?? null),
    setItem: async (key: string, value: string) => {
      await bridge.beforeSecureWrite?.();
      bridge.secure.set(key, value);
    },
    removeItem: (key: string) => {
      bridge.secure.delete(key);
      return Promise.resolve();
    },
  },
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => globalThis.crypto.randomUUID() }));
vi.mock("@react-navigation/native", async () => ({
  useFocusEffect: (callback: () => void | (() => void)) => {
    const { useEffect } = React;
    useEffect(() => {
      bridge.focus.set(callback, callback());
      return () => {
        bridge.focus.get(callback)?.();
        bridge.focus.delete(callback);
      };
    }, [callback]);
  },
  useNavigation: () => ({
    navigate: (...args: unknown[]) => bridge.navigations.push(args),
    goBack: () => {},
    canGoBack: () => true,
    dispatch: () => {},
  }),
  StackActions: { replace: () => ({}) },
}));
vi.mock("../state/memory", () => ({
  memoryEnvironment: new Proxy(
    {},
    {
      get: (_object, key) =>
        (bridge.current as NativeMemoryHarness).memory[key as keyof NativeMemoryHarness["memory"]],
    },
  ),
}));
vi.mock("../state/server", () => ({
  serverEnvironment: {
    configValueAtom: (id: EnvironmentId) => (bridge.current as NativeMemoryHarness).configs(id),
    get updateSettings() {
      return (bridge.current as NativeMemoryHarness).updateSettings;
    },
  },
}));
vi.mock("../state/session", () => ({
  useEnvironmentScope: (id: EnvironmentId, scope: AuthEnvironmentScope) => {
    const result = useAtomValue((bridge.current as NativeMemoryHarness).grants(id));
    return AsyncResult.isSuccess(result) && sessionGrantsScope(result.value, scope);
  },
  readEnvironmentScope: (id: EnvironmentId, scope: AuthEnvironmentScope) => {
    const h = bridge.current as NativeMemoryHarness;
    const result = h.registry.get(h.grants(id));
    return AsyncResult.isSuccess(result) && sessionGrantsScope(result.value, scope);
  },
  environmentSession: {
    sessionStateAtom: (id: EnvironmentId) => (bridge.current as NativeMemoryHarness).grants(id),
    preparedConnectionValueAtom: (id: EnvironmentId) =>
      (bridge.current as NativeMemoryHarness).prepared(id),
  },
}));
vi.mock("@goat/client-runtime/state/session", () => ({
  createEnvironmentSessionAtoms: () => ({
    sessionStateAtom: (id: EnvironmentId) => (bridge.current as NativeMemoryHarness).grants(id),
    initialConfigValueAtom: (id: EnvironmentId) =>
      (bridge.current as NativeMemoryHarness).configs(id),
    preparedConnectionValueAtom: (id: EnvironmentId) =>
      (bridge.current as NativeMemoryHarness).prepared(id),
  }),
}));
vi.mock("../state/entities", () => ({
  useThreadShell: () => null,
  useProject: () => null,
  useProjects: () => {
    React.useSyncExternalStore(
      (listener) => {
        bridge.projectListeners.add(listener);
        return () => bridge.projectListeners.delete(listener);
      },
      () => bridge.projectRevision,
    );
    return [...bridge.projects];
  },
  useEnvironmentServerConfig: () => null,
}));
vi.mock("../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => ({
    savedConnectionsById: {
      [nativeEnv]: { environmentId: nativeEnv, environmentLabel: "Test hub" },
      [nativeDevice]: { environmentId: nativeDevice, environmentLabel: "Test device" },
    },
  }),
  useRemoteConnectionStatus: () => ({
    connectedEnvironments: [
      { environmentId: nativeDevice, isEnabled: true, connectionState: "connected" },
    ],
  }),
}));
vi.mock("../features/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => (detail: { name: string; params: unknown }) =>
    bridge.navigations.push([detail.name, detail.params]),
}));
vi.mock("../features/home/home-thread-navigation", () => ({
  useHomeThreadSelection: () => (thread: unknown) => bridge.navigations.push(thread),
}));
vi.mock("../components/ui/AppText", async () => ({ AppText: (await import("react-native")).Text }));
vi.mock("../components/ui/ScreenScrollView", async () => ({
  ScreenScrollView: (await import("react-native")).View,
}));
vi.mock("../features/settings/components/SettingsScreen", () => ({
  SettingsScreen: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../features/settings/components/SettingsSection", () => ({
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) => (
    <section aria-label={title}>{children}</section>
  ),
}));
vi.mock("../features/settings/components/SettingsActionRow", () => ({
  SettingsActionRow: (props: { label: string; disabled?: boolean; onPress: () => void }) => {
    if (["Confirm forget"].includes(props.label)) bridge.confirmations.push(props.onPress);
    return (
      <button disabled={props.disabled} onClick={props.onPress}>
        {props.label}
      </button>
    );
  },
}));
vi.mock("../features/settings/components/SettingsSwitchRow", () => ({
  SettingsSwitchRow: (props: {
    label: string;
    value: boolean;
    onValueChange: (value: boolean) => void;
    disabled?: boolean;
  }) => (
    <button
      disabled={props.disabled}
      role="switch"
      aria-checked={props.value}
      onClick={() => props.onValueChange(!props.value)}
    >
      {props.label}
    </button>
  ),
}));
vi.mock("../components/ui/Menu", () => ({
  Menu: function Menu(props: Pick<MenuProps, "actions" | "onPressAction" | "children">) {
    const [open, setOpen] = React.useState(false);
    const trigger = React.isValidElement<{ onPress?: () => void }>(props.children)
      ? React.cloneElement(props.children, { onPress: () => setOpen(true) })
      : props.children;
    return (
      <div>
        {trigger}
        {open
          ? props.actions.map((action) => (
              <button
                key={action.id}
                disabled={action.attributes?.disabled}
                onClick={() => {
                  setOpen(false);
                  if (action.id) props.onPressAction?.({ nativeEvent: { event: action.id } });
                }}
              >
                {action.title}
              </button>
            ))
          : null}
      </div>
    );
  },
}));
vi.mock("../features/settings/components/SettingsRow", () => ({
  SettingsRow: (props: {
    label: string;
    value?: string;
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button aria-label={props.label} disabled={props.disabled} onClick={props.onPress}>
      {props.label}
      {props.value ? `: ${props.value}` : null}
    </button>
  ),
}));

const decodeImportInput = Schema.decodeUnknownSync(MemoryImportProviderInput);
const decodeImportResult = Schema.decodeUnknownSync(MemoryImportProviderResult);

export const nativeDevice = EnvironmentId.make("synthetic-device");
export const nativeEnv = EnvironmentId.make("synthetic-selected-tunnel");
export const nativeSpace = MemorySpaceId.make("00000000-0000-4000-8000-000000000001");
export const nativeId = MemoryId.make("00000000-0000-4000-8000-000000000002");
export const nativeItem = Schema.decodeUnknownSync(MemoryItem)({
  memorySpaceId: nativeSpace,
  memoryId: nativeId,
  status: "active",
  pendingSync: false,
  localAvailability: { exposure: "visible", reasons: [], deferred: [], cleanupPending: false },
  scope: { kind: "user" },
  revision: {
    memorySpaceId: nativeSpace,
    memoryId: nativeId,
    revisionId: "00000000-0000-4000-8000-000000000004",
    operationId: "00000000-0000-4000-8000-000000000005",
    parents: [],
    scope: { kind: "user" },
    payloadRef: "00000000-0000-4000-8000-000000000004",
    assertionKind: "fact",
    provenance: { environmentId: nativeEnv },
    createdAtUtc: "2026-10-15T00:00:00.000Z",
  },
  payload: {
    text: "Synthetic memory body",
    evidence: [{ origin: "user", messageIds: [] }],
    derivedFromMemoryRevisions: [],
  },
});
export const nativeOwnerPolicy = Schema.decodeUnknownSync(MemoryOwnerSourceReadPolicyView)({
  version: 3,
  revocationPropagation: "pending",
  policy: {
    ownerPolicyEpoch: 3,
    allowedRequesterEnvironmentIds: ["active-requester"],
    removals: [
      {
        memorySpaceId: nativeSpace,
        ownerEnvironmentId: nativeEnv,
        requesterEnvironmentId: "pending-requester",
        removalEpoch: 2,
        state: "pending",
      },
    ],
    enrollments: [
      {
        memorySpaceId: nativeSpace,
        ownerEnvironmentId: nativeEnv,
        requesterEnvironmentId: "active-requester",
        ownerPolicyEpoch: 1,
        state: "active",
      },
      {
        memorySpaceId: nativeSpace,
        ownerEnvironmentId: nativeEnv,
        requesterEnvironmentId: "pending-requester",
        ownerPolicyEpoch: 3,
        removalEpoch: 2,
        state: "pending",
      },
    ],
  },
});
export const nativeSyncStatus = Schema.decodeUnknownSync(MemorySyncStatus)({
  memorySpaceId: nativeSpace,
  state: "online",
  pendingSync: 0,
  quarantined: 0,
  parked: 0,
  lastSuccessfulSyncAtUtc: null,
  lastHubSequence: 0,
  processing: {
    lastReceivedHubSequence: 0,
    receiveLag: null,
    deferred: 0,
    oldestDeferredAtUtc: null,
    unindexedItems: 0,
    scannerHeldItems: 0,
    scannerPendingItems: 0,
    missingParentItems: 0,
    pendingCleanupItems: 0,
    reportBacklog: 0,
    reportFailed: 0,
    hubAdmissionFailures: 0,
    indexCoverage: {
      status: "available",
      eligibleItems: 0,
      indexedItems: 0,
      unindexedItems: 0,
      projectionWatermark: 0,
    },
  },
  storage: {
    quotas: [],
    tables: [],
    measuredAtUtc: null,
    dbFileBytes: null,
    walBytes: null,
    freelistBytes: null,
    freelistRatio: null,
    retentionFloor: 0,
    checkpointSequence: 0,
    compaction: {
      lastRunAtUtc: null,
      removedRows: 0,
      reclaimedLogicalBytes: 0,
      reclaimableLogicalBytes: 0,
      blockedReasons: [],
    },
    ftsAdmission: {
      state: "open",
      changedAtUtc: null,
      lastMeasuredAtUtc: null,
      allocatedBytes: null,
      measurementStatus: "unavailable",
    },
    growth: {
      current: null,
      deltas: [1, 7, 30].flatMap((days) =>
        [
          "memoryLogicalBytes",
          "memoryAllocatedBytes",
          "ftsAllocatedBytes",
          "dbFileBytes",
          "walBytes",
          "freelistBytes",
        ].map((metric) => ({
          days,
          metric,
          status: "unavailable",
          baselineAtUtc: null,
          currentAtUtc: null,
          elapsedMs: null,
          deltaBytes: null,
          reason: "missing_baseline",
        })),
      ),
    },
    warnings: [],
  },
});
const scopes = (values: readonly AuthEnvironmentScope[]): AuthSessionState => ({
  authenticated: true,
  scopes: values,
  permissions: values,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "synthetic",
  },
});

export type NativeMemoryHarness = ReturnType<typeof createNativeMemoryHarness>;
export function createNativeMemoryHarness() {
  bridge.projects = [];
  const registry = AtomRegistry.make();
  const configs = Atom.family((_id: EnvironmentId | null) => Atom.make<ServerConfig | null>(null));
  const grants = Atom.family((_id: EnvironmentId | null) =>
    Atom.make<AsyncResult.AsyncResult<AuthSessionState, never>>(AsyncResult.success(scopes([]))),
  );
  const prepared = Atom.family((_id: EnvironmentId | null) =>
    Atom.make(Option.some({} as PreparedConnection)),
  );
  const calls: Array<{ method: string; input: unknown; environmentId: EnvironmentId }> = [];
  const waiters: Array<{ method: string; count: number; resolve: () => void }> = [];
  const queue = Effect.runSync(Queue.unbounded<MemoryChangeSignal>());
  const config = {
    environment: {
      capabilities: {
        memory: {
          protocolVersion: 1,
          importProvider: true,
          resolutionInputs: true,
          retainedLocalSpace: true,
        },
      },
    },
    settings: { enableAgentMemoryAccess: true },
  } as ServerConfig;
  const responses = new Map<string, (input: unknown) => unknown>([
    [
      WS_METHODS.memoryHubSettingsGet,
      () => ({
        settings: { mode: "hub", memorySpaceId: nativeSpace },
        members: [],
        version: 1,
      }),
    ],
    [WS_METHODS.memoryOwnerSourceReadPolicyGet, () => nativeOwnerPolicy],
    [WS_METHODS.memorySyncStatus, () => nativeSyncStatus],
    [
      WS_METHODS.memoryList,
      () => ({ items: [nativeItem], nextCursor: null, projectionWatermark: 1 }),
    ],
    [
      WS_METHODS.memorySearch,
      () => ({ items: [], nextCursor: "synthetic-next", projectionWatermark: 1 }),
    ],
    [WS_METHODS.memoryRead, () => nativeItem],
    [
      WS_METHODS.memoryHistory,
      () => ({
        memoryId: nativeId,
        revisions: [],
        resolutions: [],
        tombstone: null,
        reports: [],
        revertResults: [],
        localAvailability: nativeItem.localAvailability,
        nextCursor: null,
      }),
    ],
  ]);
  const rpcFor = (environmentId: EnvironmentId) =>
    new Proxy(
      {},
      {
        get: (_object, method) => (input: unknown) => {
          if (method === WS_METHODS.memoryChanges)
            return Stream.concat(
              Stream.succeed({
                kind: "reset",
                memorySpaceId: nativeSpace,
                projectionWatermark: 1,
              } as MemoryChangeSignal),
              Stream.fromQueue(queue),
            );
          return Effect.suspend(() => {
            if (method === WS_METHODS.memoryImportProvider) decodeImportInput(input);
            calls.push({ method: String(method), input, environmentId });
            waiters
              .filter(
                (waiter) =>
                  waiter.method === method &&
                  calls.filter((call) => call.method === method).length >= waiter.count,
              )
              .forEach((waiter) => waiter.resolve());
            const response = responses.get(String(method))?.(input);
            const effect = Effect.isEffect(response) ? response : Effect.succeed(response);
            return method === WS_METHODS.memoryImportProvider
              ? Effect.map(effect, decodeImportResult)
              : effect;
          });
        },
      },
    );
  const active = Effect.runSync(
    SubscriptionRef.make(
      Option.some({
        client: rpcFor(nativeEnv),
        initialConfig: Effect.succeed(config),
      } as unknown as RpcSession),
    ),
  );
  const supervisor = {
    target: { environmentId: nativeEnv, label: "Synthetic tunnel" },
    session: active,
  } as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
  const deviceSession = Effect.runSync(
    SubscriptionRef.make(
      Option.some({
        client: rpcFor(nativeDevice),
        initialConfig: Effect.succeed(config),
      } as unknown as RpcSession),
    ),
  );
  const deviceSupervisor = {
    ...supervisor,
    target: { ...supervisor.target, environmentId: nativeDevice, label: "Test device" },
    session: deviceSession,
  };
  const entries = Effect.runSync(
    SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map([
        [nativeEnv, { enabled: true } as ConnectionCatalogEntry],
        [nativeDevice, { enabled: true } as ConnectionCatalogEntry],
      ]),
    ),
  );
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
      entries,
      run: (id, effect) =>
        id === nativeEnv || id === nativeDevice
          ? Effect.provideService(
              effect,
              EnvironmentSupervisor.EnvironmentSupervisor,
              id === nativeEnv ? supervisor : deviceSupervisor,
            )
          : Effect.die("Unexpected destination"),
      followStream: (id, stream) =>
        id === nativeEnv || id === nativeDevice
          ? Stream.provideService(
              stream,
              EnvironmentSupervisor.EnvironmentSupervisor,
              id === nativeEnv ? supervisor : deviceSupervisor,
            )
          : Stream.empty,
    } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
  );
  const memory = createMemoryEnvironmentAtoms(runtime);
  const updateSettings = createEnvironmentRpcCommand(runtime, {
    label: "synthetic:update-settings",
    tag: WS_METHODS.serverUpdateSettings,
  });
  const harness = {
    registry,
    secureValues: bridge.secure,
    setSecureWrite: (before: (() => Promise<void>) | null) => {
      bridge.beforeSecureWrite = before;
    },
    projects: bridge.projects,
    configs,
    grants,
    prepared,
    calls,
    responses,
    deferred: <A,>() => {
      const value = Effect.runSync(Deferred.make<A, Error>());
      return {
        response: Deferred.await(value),
        succeed: (result: A) => Effect.runPromise(Deferred.succeed(value, result)),
        fail: (error: Error) => Effect.runPromise(Deferred.fail(value, error)),
      };
    },
    memory,
    updateSettings,
    navigations: bridge.navigations,
    focus: () => {
      for (const [callback, cleanup] of bridge.focus) {
        cleanup?.();
        bridge.focus.set(callback, callback());
      }
    },
    active: () => {
      for (const listener of bridge.active) listener("active");
    },
    setPlatform: (platform: string) => {
      bridge.platform = platform;
    },
    confirm: () => bridge.confirmations.pop()?.(),
    takeConfirmation: () => bridge.confirmations.pop(),
    waitForCall: (method: string, count = 1) =>
      calls.filter((call) => call.method === method).length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.push({ method, count, resolve })),
    waitForAtom: <A,>(atom: Atom.Atom<A>, predicate: (value: A) => boolean): Promise<void> =>
      new Promise((resolve) => {
        let dispose = () => {};
        dispose = registry.subscribe(
          atom,
          (value) => {
            if (predicate(value)) {
              dispose();
              resolve();
            }
          },
          { immediate: true },
        );
      }),
    signal: (signal: MemoryChangeSignal) => Effect.runPromise(Queue.offer(queue, signal)),
    grant: (values: readonly AuthEnvironmentScope[]) =>
      registry.set(grants(nativeEnv), AsyncResult.success(scopes(values))),
    revoke: () => registry.set(grants(nativeEnv), AsyncResult.success(scopes([]))),
    dispose: () => {
      memory.dispose(registry);
      registry.dispose();
    },
  };
  bridge.current = harness;
  bridge.secure.clear();
  bridge.beforeSecureWrite = null;
  bridge.projects.length = 0;
  bridge.navigations.length = 0;
  bridge.confirmations.length = 0;
  registry.mount(configs(nativeEnv));
  registry.mount(grants(nativeEnv));
  registry.mount(prepared(nativeEnv));
  registry.set(configs(nativeEnv), config);
  registry.set(
    grants(nativeEnv),
    AsyncResult.success(scopes(["memory:read", "memory:write", "orchestration:read"])),
  );
  registry.mount(configs(nativeDevice));
  registry.mount(grants(nativeDevice));
  registry.mount(prepared(nativeDevice));
  registry.set(configs(nativeDevice), config);
  registry.set(
    grants(nativeDevice),
    AsyncResult.success(scopes(["memory:read", "memory:write", "settings:write"])),
  );
  return harness;
}

export function renderNative(harness: NativeMemoryHarness, element: ReactNode) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (element: ReactNode) => {
    await act(async () => {
      bridge.projectRevision++;
      for (const listener of bridge.projectListeners) listener();
      root.render(
        <RegistryContext.Provider value={harness.registry}>{element}</RegistryContext.Provider>,
      );
    });
  };
  return {
    container,
    render: () => render(element),
    rerender: render,
    click: async (label: string) => {
      const button = [...container.querySelectorAll("button")].find(
        (node) => node.textContent === label || node.getAttribute("aria-label") === label,
      );
      if (!button) throw new Error(`Missing button: ${label}`);
      await act(async () => button.click());
    },
    type: async (label: string, value: string) => {
      const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
      if (!input) throw new Error(`Missing input: ${label}`);
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}
