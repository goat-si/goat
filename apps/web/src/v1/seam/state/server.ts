// Seam for v1 apps/web/src/state/server.ts + packages/client-runtime/src/state/server.ts (goat 916b5ccc1b2): the
// serverEnvironment members the lifted provider screens use, answered by the GOAT 2 provider port. Each command keeps
// v1's label, input shape ({environmentId, input}) and result schema; results are decoded with the lifted v1 schemas.
import {
  AcpRegistryAcceptUrlAuthResult,
  AcpRegistryManagedBinaryUninstallResult,
  AcpRegistryPrepareResult,
  AcpRegistrySearchResult,
  type AcpRegistryAcceptUrlAuthInput,
  type AcpRegistryManagedBinaryUninstallInput,
  type AcpRegistryPrepareInput,
  type AcpRegistrySearchInput,
  type EnvironmentId,
  type ExecutionEnvironmentPlatform,
  type ProviderAuthCancelInput,
  type ProviderAuthCompleteInput,
  type ProviderAuthRespondInput,
  type ProviderAuthStartInput,
  ProviderAuthState,
  type ProviderInstallCancelInput,
  ProviderInstallState,
  type ProviderInstanceId,
  type ProviderSetupInput,
  type ResolvedKeybindingsConfig,
  type ServerProvider,
  ServerProviderUpdatedPayload,
  type ServerProviderUpdateInput,
  ServerSettings,
  ServerSettingsUpdateInput,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { applyServerSettingsPatch } from "@goat/shared/serverSettings";

import type { AtomCommandResult, EnvironmentAtomCommand } from "@goat/client-runtime/state/runtime";
import { GOAT2_ENVIRONMENT_ID, GOAT2_ENVIRONMENT_LABEL } from "../goat2/environment";
import {
  currentProviderPort,
  goat2ProvidersAtom,
  goat2SettingsAtom,
  onProviderPortChange,
  toServerProvider,
  type Goat2ProviderEntry,
  type Goat2ProviderMethod,
  type Goat2ProviderStream,
} from "../goat2/providerPort";

export const EMPTY_SERVER_PROVIDERS: ReadonlyArray<ServerProvider> = [];

/** GOAT 2 (Dev) runs the host on this machine, so the browser's platform is the host's. */
function goat2Platform(): Goat2ServerConfig["environment"]["platform"] {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const os = /Mac OS X|Macintosh/.test(ua) ? "darwin" : /Windows/.test(ua) ? "windows" : "linux";
  return { os, arch: /arm|aarch64/i.test(ua) ? "arm64" : "x64", machine: os === "darwin" ? "laptop" : "desktop" };
}

interface Target<I> {
  readonly environmentId: EnvironmentId;
  readonly input: I;
}

/** v1 refreshProviders payload (rpc.ts:833-860); GOAT 2 reads instanceId and refreshModels/modelCatalogOnly. */
export interface RefreshProvidersInput {
  readonly instanceId?: ProviderInstanceId;
  readonly cwd?: string;
  readonly fresh?: boolean;
  readonly refreshModels?: boolean;
  readonly modelCatalogOnly?: boolean;
  readonly reloadSecrets?: boolean;
}

const allowed = Atom.family((environmentId: string | null) =>
  Atom.make(environmentId === GOAT2_ENVIRONMENT_ID),
);

function command<I, A>(
  label: string,
  method: Goat2ProviderMethod,
  decode: (value: unknown) => A,
): EnvironmentAtomCommand<Target<I>, A, Error> {
  return {
    label,
    permissionAtom: (environmentId) => allowed(environmentId),
    run: async (_registry, { environmentId, input }): Promise<AtomCommandResult<A, Error>> => {
      if (environmentId !== GOAT2_ENVIRONMENT_ID) {
        return AsyncResult.failure(Cause.fail(new Error("Unknown environment " + environmentId)));
      }
      try {
        return AsyncResult.success(decode(await currentProviderPort().call(method, input)));
      } catch (error) {
        return AsyncResult.failure(Cause.fail(error instanceof Error ? error : new Error(String(error))));
      }
    },
  };
}

const decoder = <S extends Schema.Top>(schema: S) => Schema.decodeUnknownSync(schema as never) as (u: unknown) => S["Type"];

/** The port answers a refresh with the host's entries ({providers: ServerProviderEntry[]}); v1 wants ServerProviders. */
const decodeProvidersPayload = (value: unknown): ServerProviderUpdatedPayload =>
  decoder(ServerProviderUpdatedPayload)({
    providers: ((value as { providers?: ReadonlyArray<Goat2ProviderEntry> }).providers ?? []).map(toServerProvider),
  });

type SettingsUpdateInput = typeof ServerSettingsUpdateInput.Type;

/**
 * v1 server.updateSettings, applied here the way v1's server does (apps/server/src/serverSettings.ts:902,218-231): the
 * patch through the lifted applyServerSettingsPatch, then the provider-instance mutation. GOAT 2 keeps server settings
 * in this window (goat2SettingsAtom); a provider instance whose driver, enablement, name or ACP agent changed is sent
 * to the host with set_provider_instance (a removed one as disabled: the wire has no delete).
 */
const updateSettingsCommand: EnvironmentAtomCommand<Target<SettingsUpdateInput>, ServerSettings, Error> = {
  label: "environment-data:server:update-settings",
  permissionAtom: (environmentId) => allowed(environmentId),
  run: async (registry, { environmentId, input }): Promise<AtomCommandResult<ServerSettings, Error>> => {
    if (environmentId !== GOAT2_ENVIRONMENT_ID) {
      return AsyncResult.failure(Cause.fail(new Error("Unknown environment " + environmentId)));
    }
    try {
      const current = registry.get(goat2SettingsAtom);
      let next = applyServerSettingsPatch(current, input.patch);
      const mutation = input.providerInstanceMutation;
      if (mutation) {
        const providerInstances = { ...next.providerInstances };
        if (mutation.operation === "remove") delete providerInstances[mutation.instanceId];
        else providerInstances[mutation.instanceId] = mutation.instance;
        next = { ...next, providerInstances };
      }
      const ids = new Set([...Object.keys(current.providerInstances), ...Object.keys(next.providerInstances)]);
      for (const instanceId of ids) {
        const before = current.providerInstances[instanceId as ProviderInstanceId];
        const after = next.providerInstances[instanceId as ProviderInstanceId];
        const wire = (inst: typeof after, enabled: boolean) => inst && {
          instanceId, driver: inst.driver, enabled,
          ...(inst.displayName ? { displayName: inst.displayName } : {}),
          ...(inst.driver === "acpRegistry" && typeof (inst.config as { agentId?: unknown } | undefined)?.agentId === "string"
            ? { acpAgentId: (inst.config as { agentId: string }).agentId } : {}),
        };
        const was = wire(before, before?.enabled !== false);
        const now = after ? wire(after, after.enabled !== false) : wire(before, false);
        if (now && JSON.stringify(now) !== JSON.stringify(was)) await currentProviderPort().call("goat2.setProviderInstance", now);
      }
      registry.set(goat2SettingsAtom, next);
      return AsyncResult.success(next);
    } catch (error) {
      return AsyncResult.failure(Cause.fail(error instanceof Error ? error : new Error(String(error))));
    }
  },
};

/** v1 createEnvironmentRpcSubscriptionAtomFamily: follows a port stream, keyed by the JSON of its target. */
function subscription<I, A>(label: string, method: Goat2ProviderStream, decode: (value: unknown) => A) {
  const family = Atom.family((key: string) =>
    Atom.make((get): AsyncResult.AsyncResult<A, Error> => {
      const target = JSON.parse(key) as Target<I>;
      let stop = () => {};
      const attach = () => {
        stop();
        try {
          stop = currentProviderPort().watch(method, target.input, (value) => {
            try {
              get.setSelf(AsyncResult.success(decode(value)));
            } catch (error) {
              get.setSelf(AsyncResult.failure(Cause.fail(error instanceof Error ? error : new Error(String(error)))));
            }
          });
        } catch {
          stop = () => {};
        }
      };
      const off = onProviderPortChange(attach);
      attach();
      get.addFinalizer(() => {
        off();
        stop();
      });
      return AsyncResult.initial(true);
    }).pipe(Atom.withLabel(label)),
  );
  return (target: Target<I>) => family(JSON.stringify(target));
}

/** v1 createEnvironmentRpcQueryAtomFamily: one port call per target, refreshable. */
function query<I, A>(label: string, method: Goat2ProviderMethod, decode: (value: unknown) => A) {
  const family = Atom.family((key: string) =>
    Atom.make((get): AsyncResult.AsyncResult<A, Error> => {
      const target = JSON.parse(key) as Target<I>;
      let live = true;
      get.addFinalizer(() => {
        live = false;
      });
      void (async () => {
        try {
          const value = decode(await currentProviderPort().call(method, target.input));
          if (live) get.setSelf(AsyncResult.success(value));
        } catch (error) {
          if (live) get.setSelf(AsyncResult.failure(Cause.fail(error instanceof Error ? error : new Error(String(error)))));
        }
      })();
      return AsyncResult.initial(true);
    }).pipe(Atom.withLabel(label)),
  );
  return (target: Target<I>) => family(JSON.stringify(target));
}

const providersValueAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => (environmentId === GOAT2_ENVIRONMENT_ID ? get(goat2ProvidersAtom) : null)),
);

const settingsValueAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => (environmentId === GOAT2_ENVIRONMENT_ID ? get(goat2SettingsAtom) : null)),
);

/** v1 ServerConfig fields the lifted provider screens read; the rest of v1's config has no GOAT 2 source. */
export interface Goat2ServerConfig {
  readonly environment: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly platform: ExecutionEnvironmentPlatform;
    /** v1 ServerCapabilities the provider screens read; GOAT 2 has no project overrides or write preconditions. */
    readonly capabilities: {
      readonly modelCatalogRefresh: boolean;
      readonly projectProviderInstanceOverrides: boolean;
      readonly providerInstancePreconditions: boolean;
    };
  };
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: ServerSettings;
}

const configValueAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make((get): Goat2ServerConfig | null => {
    if (environmentId !== GOAT2_ENVIRONMENT_ID) return null;
    const providers = get(goat2ProvidersAtom);
    if (providers === null) return null;
    return {
      environment: {
        environmentId,
        label: GOAT2_ENVIRONMENT_LABEL,
        platform: goat2Platform(),
        capabilities: {
          modelCatalogRefresh: true,
          projectProviderInstanceOverrides: false,
          providerInstancePreconditions: false,
        },
      },
      providers,
      settings: get(goat2SettingsAtom),
    };
  }),
);

export const serverEnvironment = {
  configValueAtom,
  providersValueAtom,
  settingsValueAtom,
  refreshProviders: command<RefreshProvidersInput, ServerProviderUpdatedPayload>(
    "environment-data:server:refresh-providers",
    "server.refreshProviders",
    decodeProvidersPayload,
  ),
  updateProvider: command<ServerProviderUpdateInput, ServerProviderUpdatedPayload>(
    "environment-data:server:update-provider",
    "server.updateProvider",
    decodeProvidersPayload,
  ),
  updateSettings: updateSettingsCommand,
  providerAuthState: subscription<ProviderSetupInput, ProviderAuthState>(
    "environment-data:provider:auth-state",
    "providerAuth.subscribe",
    decoder(ProviderAuthState),
  ),
  startProviderAuth: command<ProviderAuthStartInput, ProviderAuthState>(
    "environment-data:provider:auth-start",
    "providerAuth.start",
    decoder(ProviderAuthState),
  ),
  respondProviderAuth: command<ProviderAuthRespondInput, ProviderAuthState>(
    "environment-data:provider:auth-respond",
    "providerAuth.respond",
    decoder(ProviderAuthState),
  ),
  completeProviderAuth: command<ProviderAuthCompleteInput, ProviderAuthState>(
    "environment-data:provider:auth-complete",
    "providerAuth.complete",
    decoder(ProviderAuthState),
  ),
  cancelProviderAuth: command<ProviderAuthCancelInput, ProviderAuthState>(
    "environment-data:provider:auth-cancel",
    "providerAuth.cancel",
    decoder(ProviderAuthState),
  ),
  logoutProviderAuth: command<ProviderSetupInput, ProviderAuthState>(
    "environment-data:provider:auth-logout",
    "providerAuth.logout",
    decoder(ProviderAuthState),
  ),
  providerInstallState: subscription<ProviderSetupInput, ProviderInstallState>(
    "environment-data:provider:install-state",
    "providerInstall.subscribe",
    decoder(ProviderInstallState),
  ),
  startProviderInstall: command<ProviderSetupInput, ProviderInstallState>(
    "environment-data:provider:install-start",
    "providerInstall.start",
    decoder(ProviderInstallState),
  ),
  cancelProviderInstall: command<ProviderInstallCancelInput, ProviderInstallState>(
    "environment-data:provider:install-cancel",
    "providerInstall.cancel",
    decoder(ProviderInstallState),
  ),
  removeProviderInstallation: command<ProviderSetupInput, ProviderInstallState>(
    "environment-data:provider:install-remove",
    "providerInstall.remove",
    decoder(ProviderInstallState),
  ),
  searchAcpRegistry: query<AcpRegistrySearchInput, AcpRegistrySearchResult>(
    "environment-data:server:acp-registry:search",
    "server.searchAcpRegistry",
    decoder(AcpRegistrySearchResult),
  ),
  prepareAcpRegistryAgent: command<AcpRegistryPrepareInput, AcpRegistryPrepareResult>(
    "environment-data:server:acp-registry:prepare",
    "server.prepareAcpRegistryAgent",
    decoder(AcpRegistryPrepareResult),
  ),
  uninstallAcpRegistryManagedBinary: command<
    AcpRegistryManagedBinaryUninstallInput,
    AcpRegistryManagedBinaryUninstallResult
  >(
    "environment-data:server:acp-registry:uninstall-managed-binary",
    "server.uninstallAcpRegistryManagedBinary",
    decoder(AcpRegistryManagedBinaryUninstallResult),
  ),
  acceptAcpRegistryUrlAuth: command<AcpRegistryAcceptUrlAuthInput, AcpRegistryAcceptUrlAuthResult>(
    "environment-data:server:acp-registry:accept-url-auth",
    "server.acceptAcpRegistryUrlAuth",
    decoder(AcpRegistryAcceptUrlAuthResult),
  ),
};

/** GOAT 2 has no keybindings file yet; v1 defaults resolve inside the lifted keybindings module. */
export const primaryServerKeybindingsAtom: Atom.Atom<ResolvedKeybindingsConfig> = Atom.make<ResolvedKeybindingsConfig>([]);

/** v1 state/server.ts:220-227 also reuses a list whose only change is checkedAt; GOAT 2 passes the list through. */
export const providersIgnoringCheckedAtAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => get(providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS),
);
