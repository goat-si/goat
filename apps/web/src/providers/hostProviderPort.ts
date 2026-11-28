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
function toResult(method: ProviderPortMethod, value: ProviderCommandValue): unknown {
  switch (method) {
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

export interface HostProviderPort extends ProviderPortShape {
  /** Ends the port's providers subscription and any pending waits (the app uninstalls the port). */
  dispose(): void;
}

export interface HostProviderPortOptions {
  /** How long a refresh waits for the host's providers frame after its command_result, ms. */
  refreshListTimeoutMs?: number;
}

/**
 * One providers subscription for the port's life; subscribe and watch streams fan out from it, so no call leaves a
 * subscription behind. A refresh resolves with the list the host sent for it: the host sends that providers frame
 * before the refresh's command_result (docs/part2/provider-wire.md, refresh_providers), so the latest list when the
 * result arrives is the refreshed one if any frame arrived after the request; otherwise the next frame is awaited,
 * bounded, and a missing list is an error. Other commands resolve from their command_result alone.
 */
export function hostProviderPort(client: HostClient, opts: HostProviderPortOptions = {}): HostProviderPort {
  const timeoutMs = opts.refreshListTimeoutMs ?? 15_000;
  let latest: ServerProviderEntry[] | null = null;
  let frames = 0;
  const listeners = new Set<(list: ServerProviderEntry[]) => void>();
  const waiters = new Set<() => void>();
  const stop = client.watchProviders((list) => {
    latest = list;
    frames += 1;
    for (const wake of [...waiters]) wake();
    for (const listener of [...listeners]) listener(list);
  });
  const listen = (listener: (list: ServerProviderEntry[]) => void) => {
    listeners.add(listener);
    if (latest) listener(latest);
    return () => { listeners.delete(listener); };
  };
  /** Resolves once a providers frame numbered above `after` has arrived; rejects after the bound; always cleans up. */
  const frameAfter = (after: number) => new Promise<void>((resolve, reject) => {
    if (frames > after) { resolve(); return; }
    const wake = () => { if (frames > after) { cleanup(); resolve(); } };
    const timer = setTimeout(() => { cleanup(); reject(new Error("The host did not send its provider list after the refresh.")); }, timeoutMs);
    const cleanup = () => { waiters.delete(wake); clearTimeout(timer); };
    waiters.add(wake);
  });
  return {
    subscribe: (listener) => listen(listener),
    call: async (method, payload) => {
      const unserved = UNSERVED[method];
      if (unserved) throw new Error(unserved);
      const body = toCommand(method, payload);
      if (!body) throw new Error(`GOAT does not serve ${method}.`);
      const before = frames;
      const r = await client.providerCommand(body);
      if (!r.ok) throw new Error(r.error?.message ?? "The host refused this request.");
      if (method === "server.refreshProviders") {
        await frameAfter(before);
        return { providers: latest ?? [] };
      }
      return toResult(method, r.value ?? {});
    },
    watch: (method: ProviderPortStream, payload, listener) => {
      const instanceId = str((payload ?? {}) as Obj, "instanceId") ?? "";
      return listen((providers) => {
        const entry = providers.find((e) => e.instanceId === instanceId);
        if (!entry) return;
        listener(method === "providerAuth.subscribe" ? entry.authFlow ?? idleAuth(instanceId) : entry.install ?? idleInstall(entry.driver));
      });
    },
    dispose: () => {
      stop();
      listeners.clear();
      for (const wake of [...waiters]) waiters.delete(wake);
    },
  };
}
