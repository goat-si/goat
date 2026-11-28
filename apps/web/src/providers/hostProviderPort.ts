// The GOAT 2 side of the provider seam: answers the v1 methods the lifted provider screens call (seam/state/server.ts)
// with the approved provider frames (docs/part2/provider-wire.md) on a HostClient, real host or fake host alike.
// v1 methods GOAT 2 does not serve in Part 2 are refused with a plain sentence instead of pretending to work.
import type { HostClient } from "../host/client.ts";
import type { ProviderPortMethod, ProviderPortShape, ProviderPortStream } from "@v1/surfaces";
import type { ProviderAuthState, ProviderCommandBody, ProviderCommandValue, ProviderInstallState, ServerProviderEntry } from "./wire.ts";

/** Methods without a GOAT 2 command, and why (shown to the person if a screen ever calls one). */
export const UNSERVED: Partial<Record<ProviderPortMethod, string>> = {
  "server.updateProvider": "Updating a provider's CLI from GOAT is not available yet.",
  "server.uninstallAcpRegistryManagedBinary": "Removing an installed registry agent from GOAT is not available yet.",
  "providerInstall.remove": "Removing an installed provider from GOAT is not available yet.",
  "providerAuth.respond": "This sign-in step is not available in GOAT yet; sign in from the provider's own CLI.",
  "providerAuth.complete": "This sign-in step is not available in GOAT yet; sign in from the provider's own CLI.",
};

type Obj = Record<string, unknown>;
const str = (o: Obj, k: string): string | undefined => (typeof o[k] === "string" ? (o[k] as string) : undefined);

/** v1 payload -> provider command, or null for an unserved method. */
export function toCommand(method: ProviderPortMethod, payload: unknown): ProviderCommandBody | null {
  const p = (payload ?? {}) as Obj;
  const instanceId = str(p, "instanceId") ?? "";
  switch (method) {
    case "server.refreshProviders":
      return { type: "refresh_providers", ...(str(p, "instanceId") ? { instanceId } : {}), ...(p.refreshModels === true || p.modelCatalogOnly === true ? { refreshModels: true } : {}) };
    case "server.searchAcpRegistry":
      return { type: "search_acp_registry", query: str(p, "query") ?? "", ...(typeof p.limit === "number" ? { limit: p.limit } : {}) };
    case "server.prepareAcpRegistryAgent":
      return { type: "prepare_acp_registry_agent", agentId: str(p, "agentId") ?? "" };
    case "server.acceptAcpRegistryUrlAuth":
      return { type: "accept_acp_registry_url_auth", instanceId, elicitationId: str(p, "elicitationId") ?? "" };
    case "goat2.setProviderInstance":
      return {
        type: "set_provider_instance", instanceId, driver: str(p, "driver") ?? "", enabled: p.enabled !== false,
        ...(str(p, "acpAgentId") ? { acpAgentId: str(p, "acpAgentId")! } : {}), ...(str(p, "displayName") ? { displayName: str(p, "displayName")! } : {}),
      };
    case "providerInstall.start": return { type: "provider_install_start", instanceId };
    case "providerInstall.cancel": return { type: "provider_install_cancel", instanceId, operationId: str(p, "operationId") ?? "" };
    case "providerAuth.start": return { type: "provider_auth_start", instanceId, ...(str(p, "methodId") ? { methodId: str(p, "methodId")! } : {}) };
    case "providerAuth.cancel": return { type: "provider_auth_cancel", instanceId, flowId: str(p, "flowId") ?? "" };
    case "providerAuth.logout": return { type: "provider_auth_logout", instanceId };
    default: return null;
  }
}

/** The v1 result a method resolves with, from the command_result value and the latest provider list. */
function toResult(method: ProviderPortMethod, value: ProviderCommandValue, providers: ServerProviderEntry[]): unknown {
  switch (method) {
    case "server.refreshProviders": return { providers };
    case "server.searchAcpRegistry": return value.registrySearch;
    case "server.prepareAcpRegistryAgent": return value.registryPrepare;
    case "server.acceptAcpRegistryUrlAuth": return { accepted: value.accepted === true };
    case "providerInstall.start": case "providerInstall.cancel": return value.installState;
    case "providerAuth.start": case "providerAuth.cancel": case "providerAuth.logout": return value.authState;
    default: return undefined;
  }
}

/** v1's idle states for an instance with no flow running (v1 providerSetup.ts ProviderAuthState / ProviderInstallState). */
export const idleAuth = (instanceId: string): ProviderAuthState =>
  ({ instanceId, phase: "idle", flowId: null, authorizationUrl: null, expiresAt: null, message: null });
export const idleInstall = (driver: string): ProviderInstallState =>
  ({ driver, operationId: null, phase: "idle", downloadedBytes: 0, totalBytes: null, version: null, installedVersion: null, canRemove: false, message: null });

export function hostProviderPort(client: HostClient): ProviderPortShape {
  let latest: ServerProviderEntry[] = [];
  let firstList: Promise<void> | null = null;
  const listUntil = (pred: (p: ServerProviderEntry[]) => boolean) => new Promise<void>((resolve) => {
    const stop = client.watchProviders((p) => { latest = p; if (pred(p)) { queueMicrotask(() => stop()); resolve(); } });
  });
  return {
    subscribe: (listener) => client.watchProviders((p) => { latest = p; listener(p); }),
    call: async (method, payload) => {
      const unserved = UNSERVED[method];
      if (unserved) throw new Error(unserved);
      const body = toCommand(method, payload);
      if (!body) throw new Error(`GOAT does not serve ${method}.`);
      // A refresh resolves with the list the host sends after it (the subscription carries it, not the result).
      const before = latest;
      const next = method === "server.refreshProviders" ? listUntil((p) => p !== before) : null;
      firstList ??= listUntil(() => true);
      const r = await client.providerCommand(body);
      if (!r.ok) throw new Error(r.error?.message ?? "The host refused this request.");
      if (next) await Promise.race([next, new Promise((res) => setTimeout(res, 3000))]);
      await firstList;
      return toResult(method, r.value ?? {}, latest);
    },
    watch: (method: ProviderPortStream, payload, listener) => {
      const instanceId = str((payload ?? {}) as Obj, "instanceId") ?? "";
      return client.watchProviders((providers) => {
        const entry = providers.find((e) => e.instanceId === instanceId);
        if (!entry) return;
        listener(method === "providerAuth.subscribe" ? entry.authFlow ?? idleAuth(instanceId) : entry.install ?? idleInstall(entry.driver));
      });
    },
  };
}
