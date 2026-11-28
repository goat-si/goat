// Seam for v1 apps/web/src/hooks/useSettings.ts (goat 916b5ccc1b2): the settings hooks the lifted provider screens use.
// Server settings live behind the GOAT 2 provider port (server.updateSettings); client settings stay in this browser
// (localStorage), as v1's browser client does. v1's multi-environment shared-settings sync, project overrides and
// legacy migrations are not carried: GOAT 2 has one environment.
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  type ClientSettings,
  type ClientSettingsPatch,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ProviderInstanceId,
  type ProviderInstanceMutation,
  ServerSettings,
  type ServerSettingsPatch,
  type UnifiedSettings,
} from "@goat/contracts";
import { resolveModelPreferences } from "@goat/shared/serverSettings";
import * as Equal from "effect/Equal";
import * as Struct from "effect/Struct";
import { AsyncResult, Atom } from "effect/reactivity";
import { use, useRef, useSyncExternalStore } from "react";

import { isAtomCommandInterrupted, squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import { toastManager } from "../../components/ui/toast";
import { GOAT2_ENVIRONMENT_ID } from "../goat2/environment";
import { goat2SettingsAtom } from "../goat2/providerPort";
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment } from "../state/server";

export const PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE =
  "This setting is saved on a server, and the hosted app is not anchored to one. Change it from the desktop app or from the server's own address.";

const CLIENT_SETTINGS_KEY = "goat2:v1-client-settings";
const SERVER_SETTINGS_KEYS = new Set<string>(Struct.keys(ServerSettings.fields));

function readStoredClientSettings(): ClientSettings {
  try {
    const raw = window.localStorage.getItem(CLIENT_SETTINGS_KEY);
    return raw ? { ...DEFAULT_CLIENT_SETTINGS, ...(JSON.parse(raw) as Partial<ClientSettings>) } : DEFAULT_CLIENT_SETTINGS;
  } catch {
    return DEFAULT_CLIENT_SETTINGS;
  }
}

let clientSettings: ClientSettings | null = null;
const clientListeners = new Set<() => void>();
function getClientSettingsSnapshot(): ClientSettings {
  clientSettings ??= readStoredClientSettings();
  return clientSettings;
}
function subscribeClientSettings(listener: () => void): () => void {
  clientListeners.add(listener);
  return () => clientListeners.delete(listener);
}

export function getClientSettings(): ClientSettings {
  return getClientSettingsSnapshot();
}

export function updateClientSettings(patch: ClientSettingsPatch): Promise<boolean> {
  clientSettings = { ...getClientSettingsSnapshot(), ...patch } as ClientSettings;
  try {
    window.localStorage.setItem(CLIENT_SETTINGS_KEY, JSON.stringify(clientSettings));
  } catch {
    toastManager.add({ type: "error", title: "Setting not saved", description: "Could not save settings on this device. Try again." });
    return Promise.resolve(false);
  }
  for (const listener of clientListeners) listener();
  return Promise.resolve(true);
}

/** v1 useClientSettings (useSettings.ts:460-470): structurally equal selections keep their reference. */
export function useClientSettings<T = ClientSettings>(selector?: (settings: ClientSettings) => T): T {
  const select = selector ?? ((settings: ClientSettings) => settings as T);
  const snapshot = useSyncExternalStore(subscribeClientSettings, getClientSettingsSnapshot, getClientSettingsSnapshot);
  const next = select(snapshot);
  const previous = useRef<{ readonly value: T } | null>(null);
  if (previous.current === null || !Equal.equals(previous.current.value, next)) previous.current = { value: next };
  return previous.current.value;
}

export function mergeEnvironmentSettings(serverSettings: ServerSettings, client: ClientSettings): UnifiedSettings {
  // v1 useSettings.ts:472-482: server values win over retired client keys.
  return { ...client, ...serverSettings, ...resolveModelPreferences(serverSettings, client) } as UnifiedSettings;
}

export function useMergedSettings<T = UnifiedSettings>(
  serverSettings: ServerSettings,
  selector?: (settings: UnifiedSettings) => T,
): T {
  return useClientSettings((client) => {
    const merged = mergeEnvironmentSettings(serverSettings, client);
    return selector ? selector(merged) : (merged as T);
  });
}

const noEnvironmentSettingsAtom = Atom.make<ServerSettings | null>(null);

export function useEnvironmentSettings<T = UnifiedSettings>(
  environmentId: EnvironmentId,
  selector?: (settings: UnifiedSettings) => T,
): T {
  const serverSettings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  return useMergedSettings(serverSettings ?? DEFAULT_SERVER_SETTINGS, selector);
}

export function useEnvironmentModelPreferences(environmentId: EnvironmentId | null) {
  const settings = useAtomValue(
    environmentId ? serverEnvironment.settingsValueAtom(environmentId) : noEnvironmentSettingsAtom,
  );
  const legacy = useClientSettings((s) => ({ favorites: s.favorites, providerModelPreferences: s.providerModelPreferences }));
  return resolveModelPreferences(settings ?? DEFAULT_SERVER_SETTINGS, legacy);
}

function useSaveServerSettings() {
  const persist = useAtomCommand(serverEnvironment.updateSettings, {
    label: "server settings update",
    reportFailure: false,
  });
  const registry = use(RegistryContext);
  return async (environmentId: EnvironmentId, input: { readonly patch: ServerSettingsPatch; readonly providerInstanceMutation?: ProviderInstanceMutation }) => {
    const result = await persist({ environmentId, input });
    if (result._tag === "Success") {
      registry.set(goat2SettingsAtom, result.value);
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Setting not saved",
        description: "Could not save on this Mac: " + (error instanceof Error ? error.message : "The save failed."),
      });
    }
    return result;
  };
}

export function useUpdateEnvironmentModelPreferences(environmentId: EnvironmentId | null) {
  const save = useSaveServerSettings();
  return async (patch: ServerSettingsPatch) => {
    if (!environmentId) return;
    return save(environmentId, { patch });
  };
}

/** v1 useToggleEnvironmentModelFavorite (useSettings.ts:620-682) without the pending-reply bookkeeping. */
export function useToggleEnvironmentModelFavorite(environmentId: EnvironmentId | null) {
  const registry = use(RegistryContext);
  const save = useUpdateEnvironmentModelPreferences(environmentId);
  return async (provider: ProviderInstanceId, model: string) => {
    if (!environmentId) return;
    const settings = registry.get(serverEnvironment.settingsValueAtom(environmentId));
    if (!settings) return;
    const favorites = resolveModelPreferences(settings, getClientSettings()).favorites;
    const favorite = !favorites.some((entry) => entry.provider === provider && entry.model === model);
    await save({ setModelFavorites: [{ provider, model, favorite }] } as ServerSettingsPatch);
  };
}

export function usePersistEnvironmentProviderInstanceMutation(environmentId: EnvironmentId) {
  const save = useSaveServerSettings();
  return (providerInstanceMutation: ProviderInstanceMutation, patch: ServerSettingsPatch = {}) =>
    save(environmentId, { patch, providerInstanceMutation });
}

export function usePrimarySettingsAvailable(): boolean {
  return true;
}

type UnifiedSettingsPatch = ServerSettingsPatch & ClientSettingsPatch;

export function useUpdateEnvironmentSettings(environmentId: EnvironmentId | null) {
  const save = useSaveServerSettings();
  return (patch: UnifiedSettingsPatch, options?: { readonly onFailed?: () => void }) => {
    const serverPatch: Record<string, unknown> = {};
    const clientPatch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      (SERVER_SETTINGS_KEYS.has(key) ? serverPatch : clientPatch)[key] = value;
    }
    if (Object.keys(clientPatch).length > 0) {
      void updateClientSettings(clientPatch as ClientSettingsPatch).then((ok) => {
        if (!ok) options?.onFailed?.();
      });
    }
    if (Object.keys(serverPatch).length > 0) {
      const target = environmentId ?? GOAT2_ENVIRONMENT_ID;
      void save(target, { patch: serverPatch as ServerSettingsPatch }).then((result) => {
        if (!AsyncResult.isSuccess(result)) options?.onFailed?.();
      });
    }
  };
}
