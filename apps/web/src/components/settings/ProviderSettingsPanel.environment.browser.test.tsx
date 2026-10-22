import { RegistryContext } from "@effect/atom-react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UnifiedSettings,
} from "@goat/contracts";
import { AsyncResult, type Atom } from "effect/reactivity";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render, stubGlobal } from "../../../test/render";

const state = vi.hoisted(() => ({
  providers: null as unknown as Atom.Writable<ReadonlyArray<ServerProvider>>,
  settings: null as unknown as UnifiedSettings,
  canManageProviders: true,
  canWriteSettings: true,
  searchTargetId: null as string | null,
  readEnvironmentIds: [] as string[],
  updateEnvironmentIds: [] as string[],
  mutationEnvironmentIds: [] as string[],
  refresh: vi.fn(),
  updateProvider: vi.fn(),
  uninstall: vi.fn(),
  acceptUrlAuth: vi.fn(),
  updateSettings: vi.fn(),
  updateModelPreferences: vi.fn(),
  toggleFavorite: vi.fn(),
  mutateProviderInstance: vi.fn(),
  localDesktop: false,
  openExternal: vi.fn(),
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const providers = Atom.make<ReadonlyArray<ServerProvider>>([]).pipe(Atom.keepAlive);
  state.providers = providers;
  const config = Atom.make(null);
  const commandLabels = {
    refreshProviders: "refresh",
    updateProvider: "update",
    uninstallAcpRegistryManagedBinary: "uninstall",
    acceptAcpRegistryUrlAuth: "accept-url-auth",
  } as const;
  const labelled = Object.fromEntries(
    Object.entries(commandLabels).map(([key, label]) => [
      key,
      { ...actual.serverEnvironment[key as keyof typeof commandLabels], label },
    ]),
  );
  return {
    ...actual,
    providersIgnoringCheckedAtAtom: (() => providers) as never,
    serverEnvironment: {
      ...actual.serverEnvironment,
      ...labelled,
      configValueAtom: (() => config) as never,
      providersValueAtom: (() => providers) as never,
    } as never,
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { label?: string }) =>
    ({
      refresh: state.refresh,
      update: state.updateProvider,
      uninstall: state.uninstall,
      "accept-url-auth": state.acceptUrlAuth,
    })[command.label ?? ""] ?? vi.fn()) as never,
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: null,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  })) as never,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: ((environmentId: string) => {
    state.readEnvironmentIds.push(environmentId);
    return state.settings;
  }) as never,
  useUpdateEnvironmentSettings: ((environmentId: string) => {
    state.updateEnvironmentIds.push(environmentId);
    return state.updateSettings;
  }) as never,
  useUpdateEnvironmentModelPreferences: (() => state.updateModelPreferences) as never,
  useToggleEnvironmentModelFavorite: (() => state.toggleFavorite) as never,
  usePersistEnvironmentProviderInstanceMutation: ((environmentId: string) => {
    state.mutationEnvironmentIds.push(environmentId);
    return state.mutateProviderInstance;
  }) as never,
}));
vi.mock(import("../../state/session"), async (original) => {
  const scope = (environmentId: string, requested: string) =>
    environmentId === "remote-device" &&
    (requested === "providers:manage"
      ? state.canManageProviders
      : requested === "settings:write"
        ? state.canWriteSettings
        : requested === "orchestration:read");
  return {
    ...(await original()),
    useEnvironmentScope: scope as never,
    readEnvironmentScope: scope as never,
  };
});
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => []) as never,
}));
// The OpenCodex dashboard opens only from the desktop app's own environment.
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({
    environments: state.localDesktop
      ? [{ environmentId: "remote-device", entry: { target: { _tag: "PrimaryConnectionTarget" } } }]
      : [],
    isReady: true,
  })) as never,
}));
vi.mock(import("../../environments/primary/target"), async (original) => ({
  ...(await original()),
  readPrimaryEnvironmentTarget: (() => ({ source: "desktop-managed" })) as never,
}));
vi.mock(import("../../localApi"), async (original) => ({
  ...(await original()),
  ensureLocalApi: (() => ({ shell: { openExternal: state.openExternal } })) as never,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  useSettingsSearchTargetId: () => state.searchTargetId,
  // The real row reads write permission and overrides from live environment state.
  SettingsRow: (({
    id,
    title,
    description,
    status,
    control,
    children,
  }: {
    id?: string;
    title: ReactNode;
    description?: ReactNode;
    status?: ReactNode;
    control?: ReactNode;
    children?: ReactNode;
  }) => (
    <div id={id}>
      <h4>{title}</h4>
      {description}
      {status}
      {control}
      {children}
    </div>
  )) as never,
}));
// Its own data flows are covered by its suite; this one is about the panel.
vi.mock(import("./UsageProviderSettings"), async (original) => ({
  ...(await original()),
  UsageProviderSettings: (() => null) as never,
}));
vi.mock(import("../ProviderUpdatesAction"), async (original) => ({
  ...(await original()),
  ProviderUpdatesAction: (() => null) as never,
}));

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { EnvironmentProviderSettings } from "./ProviderSettingsPanel";

const environmentId = EnvironmentId.make("remote-device");
const codexId = ProviderInstanceId.make("codex");
const customId = ProviderInstanceId.make("codex_work");

function provider(): ServerProvider {
  return {
    instanceId: codexId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-24T12:00:00.000Z",
    models: [{ slug: "chosen", name: "Chosen", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      updateCommand: "pnpm add -g @openai/codex@latest",
      canUpdate: true,
      checkedAt: "2026-07-24T12:00:00.000Z",
      message: "Update available.",
    },
  };
}

const setProviders = (providers: ReadonlyArray<ServerProvider>) =>
  act(async () => appAtomRegistry.set(state.providers, providers));

function panel(options?: {
  readonly readOnly?: boolean;
  readonly targetInstanceId?: ProviderInstanceId;
}) {
  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <div className="@container/providers">
        <EnvironmentProviderSettings
          environmentId={environmentId}
          environmentLabel="Remote device"
          {...(options?.readOnly === undefined ? {} : { readOnly: options.readOnly })}
          {...(options?.targetInstanceId === undefined
            ? {}
            : { targetInstanceId: options.targetInstanceId })}
        />
      </div>
    </RegistryContext.Provider>
  );
}

const button = (name: string) => page.getByRole("button", { name, exact: true });
const select = (name: string) => button(`Select ${name}`);

async function setup() {
  await page.viewport(1280, 900);
  state.settings = DEFAULT_UNIFIED_SETTINGS;
  state.canManageProviders = true;
  state.canWriteSettings = true;
  state.searchTargetId = null;
  state.readEnvironmentIds = [];
  state.updateEnvironmentIds = [];
  state.mutationEnvironmentIds = [];
  state.updateSettings.mockReset();
  state.updateModelPreferences.mockReset();
  state.toggleFavorite.mockReset();
  state.mutateProviderInstance.mockReset().mockResolvedValue(AsyncResult.success({}));
  state.refresh.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.updateProvider.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.uninstall.mockReset().mockResolvedValue(AsyncResult.success({}));
  state.acceptUrlAuth.mockReset().mockResolvedValue(AsyncResult.success({ accepted: true }));
  state.localDesktop = false;
  state.openExternal.mockReset().mockResolvedValue(undefined);
  await setProviders([]);
}

describe("EnvironmentProviderSettings routing", () => {
  it("does not substitute another account when the requested instance was removed", async () => {
    await setup();
    await setProviders([provider()]);
    await using _screen = await render(panel({ targetInstanceId: customId }));
    await expect
      .element(page.getByText("This provider instance is no longer available on this device."))
      .toBeVisible();
    expect(state.updateSettings).not.toHaveBeenCalled();
  });

  it("updates one provider instance without sending a stale whole map", async () => {
    await setup();
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          displayName: "Work",
        },
      },
    };
    await using _screen = await render(panel());
    await userEvent.click(page.getByRole("switch", { name: "Enable Work" }).first());

    expect(state.mutateProviderInstance).toHaveBeenCalledWith(
      {
        operation: "upsert",
        instanceId: customId,
        instance: { driver: ProviderDriverKind.make("codex"), enabled: false, displayName: "Work" },
      },
      {},
    );
  });

  it("routes explicit ACP browser authentication consent to the selected environment", async () => {
    await setup();
    const instanceId = ProviderInstanceId.make("acpRegistry_antigravity");
    const action = {
      elicitationId: "google-login-1",
      url: "https://accounts.google.com/login",
      message: "Continue with Google",
    };
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("acpRegistry"),
          enabled: true,
          config: { agentId: "antigravity" },
        },
      },
    };
    await setProviders([
      {
        ...provider(),
        instanceId,
        driver: ProviderDriverKind.make("acpRegistry"),
        auth: { status: "unauthenticated", action },
      },
    ]);
    await using _screen = await render(panel({ targetInstanceId: instanceId }));
    const link = page.getByRole("link", { name: "Continue authentication" });
    link.element().addEventListener("click", (event) => event.preventDefault());
    await userEvent.click(link);

    expect(state.acceptUrlAuth).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, elicitationId: action.elicitationId },
    });
  });
});

describe("EnvironmentProviderSettings cloud siblings", () => {
  const sourceId = ProviderInstanceId.make("cursor");
  const cloudId = ProviderInstanceId.make("cursorCloud");

  it("shows a cloud default while its sibling is off, then removes the ghost default for a custom cloud instance", async () => {
    await setup();
    const customCloudId = ProviderInstanceId.make("cursor_cloud_work");
    await using screen = await render(panel({ targetInstanceId: cloudId }));
    await expect.element(select("Cursor Cloud")).toBeVisible();

    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customCloudId]: {
          driver: ProviderDriverKind.make("cursorCloud"),
          enabled: false,
          displayName: "Work cloud",
        },
      },
    };
    await screen.rerender(panel());
    await expect.element(select("Work cloud")).toBeVisible();
    await expect.element(select("Cursor Cloud")).not.toBeInTheDocument();
  });

  it("opens the sibling account flow from a cloud card until ready, retaining sign-out when available", async () => {
    await setup();
    const source: ServerProvider = {
      ...provider(),
      instanceId: sourceId,
      driver: ProviderDriverKind.make("cursor"),
      displayName: "Cursor",
      setup: { canAuthenticate: true, canInstall: false },
    };
    const cloud: ServerProvider = {
      ...provider(),
      instanceId: cloudId,
      driver: ProviderDriverKind.make("cursorCloud"),
      status: "warning",
      authSourceInstanceId: sourceId,
    };
    const account = () => page.getByRole("heading", { name: "Account", exact: true });

    await setProviders([source, cloud]);
    await using _screen = await render(panel({ targetInstanceId: cloudId }));
    await expect.element(page.getByText("Cloud sign-in")).toBeVisible();
    await expect.element(account()).toBeVisible();

    await setProviders([source, { ...cloud, status: "ready" }]);
    await expect.element(page.getByText("Cloud sign-in")).not.toBeInTheDocument();
    await expect.element(account()).not.toBeInTheDocument();

    await setProviders([
      { ...source, auth: { ...source.auth, canLogout: true } },
      { ...cloud, status: "ready" },
    ]);
    await expect.element(account()).toBeVisible();
  });
});

describe("EnvironmentProviderSettings OpenCodex Home route", () => {
  const openDashboard = () => button("Open OpenCodex");

  it("opens a dashboard only for a local desktop environment", async () => {
    await setup();
    // The desktop bridge is fixed for a page's lifetime, so each case mounts fresh.
    state.localDesktop = true;
    await using first = await render(panel());
    await expect.element(page.getByText("Uses Codex's own settings")).toBeVisible();
    await expect.element(openDashboard()).not.toBeInTheDocument();
    await first.unmount();

    using _bridge = stubGlobal("desktopBridge", {});
    state.localDesktop = false;
    await using second = await render(panel());
    await expect.element(page.getByText("Uses Codex's own settings")).toBeVisible();
    await expect.element(openDashboard()).not.toBeInTheDocument();

    state.localDesktop = true;
    await second.rerender(panel());
    await userEvent.click(openDashboard());
    await vi.waitFor(() =>
      expect(state.openExternal).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:10100"),
    );
  });

  it.each(["not a URL", "https://example.com/v1", "http://user:secret@localhost:10100/v1"])(
    "explains the local address requirement for %s",
    async (opencodexBaseUrl) => {
      await setup();
      state.localDesktop = true;
      using _bridge = stubGlobal("desktopBridge", {});
      state.settings = {
        ...DEFAULT_UNIFIED_SETTINGS,
        providerInstances: {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            config: { modelRoute: "opencodex", opencodexBaseUrl },
          },
        },
      };
      await using _screen = await render(panel());
      await userEvent.click(openDashboard());
      await expect
        .element(
          page.getByText("Enter a local OpenCodex address such as http://127.0.0.1:10100/v1."),
        )
        .toBeVisible();
      expect(state.openExternal).not.toHaveBeenCalled();
    },
  );

  it("writes the Home route to the selected environment with its permission", async () => {
    await setup();
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: {
          driver: ProviderDriverKind.make("codex"),
          displayName: "Work",
          config: { homePath: "/home/person/.codex", customOption: 42 },
        },
      },
    };
    await using _screen = await render(panel({ targetInstanceId: customId }));
    const confirm = () =>
      page.getByRole("alertdialog").getByRole("button", { name: "Use OpenCodex Home" });

    await userEvent.click(button("Use OpenCodex Home"));
    await userEvent.click(confirm());
    await vi.waitFor(() =>
      expect(state.refresh).toHaveBeenCalledWith({
        environmentId,
        input: { instanceId: customId, fresh: true, refreshModels: true },
      }),
    );
    expect(state.mutationEnvironmentIds).toContain(environmentId);
    expect(state.mutateProviderInstance).toHaveBeenCalledExactlyOnceWith(
      {
        operation: "upsert",
        instanceId: customId,
        instance: expect.objectContaining({
          displayName: "Work",
          config: {
            homePath: "/home/person/.codex",
            customOption: 42,
            modelRoute: "opencodex",
            opencodexBaseUrl: "http://127.0.0.1:10100/v1",
          },
        }),
      },
      expect.anything(),
    );

    // The rendered control stays enabled; the write must recheck the live grant.
    state.canManageProviders = false;
    await userEvent.click(button("Use OpenCodex Home"));
    await userEvent.click(confirm());
    await expect
      .element(
        page.getByText(
          "This device can't change providers on this environment. Ask its owner for full access.",
        ),
      )
      .toBeVisible();
    expect(state.mutateProviderInstance).toHaveBeenCalledTimes(1);
  });
});
