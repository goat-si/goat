import { buildMobilePairingLink } from "@goat/shared/mobilePairingLink";
import { readHostedPairingRequest } from "@goat/shared/remote";
import { isLoopbackHostname } from "../../environments/primary/target";
import { resolveDesktopPairingUrl, resolveHostedPairingUrl } from "./pairingUrls";
import {
  connectionProgressLabel,
  connectionRouteId,
  connectionRoutes,
  connectionStatusText,
  reconcileSshConnectionPresentation,
  sshPreparationFailure,
  type EnvironmentPresentation,
} from "@goat/client-runtime/connection";
import { sshRuntimeStatusText } from "@goat/client-runtime/state/sshRuntime";
import { GOAT_CONNECT_COMING_SOON } from "@goat/shared/goatConnect";
import * as Option from "effect/Option";
import { isGoatConnectUnavailable } from "./EnvironmentRow.logic";
import * as DateTime from "effect/DateTime";

import { getPairingTokenFromUrl, setPairingTokenOnUrl } from "../../pairingUrl";
import {
  type ServerClientSessionRecord,
  type ServerPairingLinkRecord,
} from "~/environments/primary";
import {
  type AdvertisedEndpoint,
  type AuthClientSession,
  type AuthGrantScope,
  type AuthPairingLink,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  type DesktopBridge,
  type DesktopServerExposureState,
  type DesktopUpdateState,
  type DesktopWslState,
  type DesktopSshPreparationProgress,
  type SshHostStatus,
} from "@goat/contracts";
import {
  getDesktopUpdateDownloadedVersion,
  resolveDesktopUpdateButtonAction,
} from "../desktopUpdate.logic";

export function isSshConnectionSuperseded(error: unknown): boolean {
  return sshPreparationFailure(error)._tag === "ConnectionAttemptSuperseded";
}

/** Runtime status and presentation must use the route that supplied the evidence. */
export function savedConnectionSshRoute(environment: EnvironmentPresentation) {
  const routeId =
    environment.connection.sshPreparation?.routeId ??
    environment.connection.sshRuntimeReady?.routeId ??
    environment.connection.failureOrigin?.routeId;
  for (const route of connectionRoutes(environment.entry)) {
    if (
      route.target._tag === "SshConnectionTarget" &&
      Option.isSome(route.profile) &&
      route.profile.value._tag === "SshConnectionProfile" &&
      (routeId === undefined || connectionRouteId(route.target) === routeId)
    ) {
      return { routeId: connectionRouteId(route.target), target: route.profile.value.target };
    }
  }
  return undefined;
}

/** Both the subtitle and an already-open tooltip must describe the same observation. */
export function savedConnectionPresentation({
  environment,
  runtimeStatus,
}: {
  readonly environment: EnvironmentPresentation;
  readonly runtimeStatus?: SshHostStatus | undefined;
}) {
  const original = environment.connection;
  const routeId = savedConnectionSshRoute(environment)?.routeId;
  const ownerStatus = routeId === undefined ? undefined : runtimeStatus;
  const { sshPreparation, sshRuntimeReady, ...withoutSshEvidence } = original;
  const connection = reconcileSshConnectionPresentation(
    {
      ...withoutSshEvidence,
      ...(sshPreparation?.routeId === routeId && sshPreparation !== undefined
        ? { sshPreparation }
        : {}),
      ...(sshRuntimeReady?.routeId === routeId && sshRuntimeReady !== undefined
        ? { sshRuntimeReady }
        : {}),
    },
    ownerStatus,
  );
  const result = (
    text: string,
    tone: "muted" | "error",
    runtimeText: string | null,
    tooltipText = text,
    preparationPhase?: DesktopSshPreparationProgress["phase"],
  ) => ({ text, tone, runtimeText, tooltipText, preparationPhase });
  if (isGoatConnectUnavailable(environment.entry))
    return result(
      "Unavailable",
      "muted",
      null,
      `${GOAT_CONNECT_COMING_SOON.status}. ${GOAT_CONNECT_COMING_SOON.description}`,
    );
  if (!environment.entry.enabled && connection.phase !== "unsupported")
    return result("Off", "muted", null, "Switched off");
  if (connection.phase === "unsupported")
    return result(
      "Client not supported",
      "muted",
      null,
      connection.error ?? connectionStatusText(connection),
    );
  if (connection.phase === "offline") return result("Offline", "muted", null);
  if (connection.phase === "available") return result("Not connected", "muted", null);

  const preparing =
    connection.sshPreparation?.routeId === routeId && connection.sshPreparation !== undefined;
  if (preparing && (connection.phase === "connecting" || connection.phase === "reconnecting")) {
    return result(
      connectionProgressLabel(connection, 0),
      "muted",
      null,
      connectionStatusText(connection),
      connection.sshPreparation?.phase,
    );
  }
  const ready =
    connection.sshRuntimeReady?.routeId === routeId ? connection.sshRuntimeReady : undefined;
  const runtime =
    ownerStatus?.state === "preparing" && ready?.runtimeStatus.state === "ready"
      ? ready.runtimeStatus
      : (ownerStatus ?? ready?.runtimeStatus);
  const runtimeText = runtime ? sshRuntimeStatusText(runtime) : null;
  const runtimeTooltip =
    runtimeText && runtime?.runtimeVersion && runtime.requestedVersion
      ? `${runtimeText} · This app ${runtime.requestedVersion}`
      : runtimeText;
  const tooltip = [connectionStatusText(connection), runtimeTooltip].filter(Boolean).join("\n");
  if (connection.phase === "connected")
    return result("Connected", "muted", runtimeText, tooltip, null);
  if (
    connection.failureSuppressed &&
    connection.error === null &&
    ready?.runtimeStatus.state === "ready"
  ) {
    return result(
      `Runtime ready · ${connectionProgressLabel(connection, 0)}`,
      "muted",
      null,
      tooltip,
      null,
    );
  }
  if (connection.phase === "connecting") return result("Connecting", "muted", runtimeText, tooltip);
  if (connection.phase === "reconnecting") {
    return result(
      connection.unreachable
        ? "Unreachable"
        : connection.error
          ? `Reconnecting: ${connection.error}`
          : "Reconnecting",
      connection.unreachable || connection.error === null ? "muted" : "error",
      runtimeText,
      tooltip,
    );
  }
  return result(
    connection.error ? `Connection failed: ${connection.error}` : "Connection failed",
    "error",
    runtimeText,
    tooltip,
  );
}

/**
 * Operating terminals without being able to list them leaves a client
 * allocating a fresh shell for every script run it cannot see, so the pairing
 * form keeps `terminal:read` alongside `terminal:operate`.
 */
export function togglePairingScopeSelection(
  current: ReadonlyArray<AuthGrantScope>,
  scope: AuthGrantScope,
  checked: boolean,
): ReadonlyArray<AuthGrantScope> {
  const without = (scopes: ReadonlyArray<AuthGrantScope>) =>
    scopes.filter((currentScope) => currentScope !== scope);
  if (!checked) {
    return scope === AuthTerminalReadScope
      ? without(current).filter((currentScope) => currentScope !== AuthTerminalOperateScope)
      : without(current);
  }
  const next = [...without(current), scope];
  return scope === AuthTerminalOperateScope && !next.includes(AuthTerminalReadScope)
    ? [...next, AuthTerminalReadScope]
    : next;
}

export function canRevokeOtherClients(
  clientSessions: ReadonlyArray<{ readonly current: boolean }> | null,
): boolean {
  return clientSessions === null || clientSessions.some((session) => !session.current);
}

type WslEnableBridge = Pick<DesktopBridge, "setWslBackendEnabled" | "setWslDistro" | "setWslOnly">;

/**
 * A QR code encoding a loopback URL makes the scanning device dial itself, so
 * loopback endpoints stay copyable from the endpoint menu but are never
 * offered as QR targets.
 */
export function isQrShareableEndpoint(endpoint: AdvertisedEndpoint): boolean {
  return endpoint.status !== "unavailable" && endpoint.reachability !== "loopback";
}

/**
 * Copy for the Tailscale HTTPS row when no Tailscale endpoint is advertised.
 * The desktop skips the Tailscale probe until Network access or Tailscale
 * Serve is on (it can trigger a macOS privacy prompt), so a missing endpoint
 * then means "not checked", not "not running".
 */
export function missingTailscaleEndpointDescription(
  state: Pick<DesktopServerExposureState, "mode" | "tailscaleServeEnabled"> | null,
): string {
  return state && state.mode !== "network-accessible" && !state.tailscaleServeEnabled
    ? "Turn on Network access to detect Tailscale."
    : "Start Tailscale to set up HTTPS access through MagicDNS.";
}

export function isWslSettingsRowVisible(input: {
  readonly state: DesktopWslState | null;
  readonly error: string | null;
}): boolean {
  const { state, error } = input;
  return state ? state.available || state.enabled || state.wslOnly : error !== null;
}

/**
 * Passive label for this machine's Version row once client and server versions
 * match. The desktop bundles its server, so a pending app update is the only
 * way it falls behind. Pending states follow the sidebar update control's
 * action, including retryable failures, so the two never disagree; the sidebar
 * is where to act. A recheck keeps a downloaded update while `checking`, so it
 * keeps its label too. `state` is null outside the desktop app.
 */
export function resolveLocalVersionStatusLabel(state: DesktopUpdateState | null): string {
  if (!state) return "Up to date";
  if (state.status === "downloading") {
    return state.availableVersion
      ? `Downloading update ${state.availableVersion}`
      : "Downloading update";
  }
  const action = resolveDesktopUpdateButtonAction(state);
  if (
    action === "install" ||
    state.status === "downloaded" ||
    (state.status === "checking" && state.downloadedVersion !== null)
  ) {
    const version = getDesktopUpdateDownloadedVersion(state);
    return version ? `Update ${version} downloaded` : "Update downloaded";
  }
  if (action === "download") {
    return state.availableVersion
      ? `Update ${state.availableVersion} available`
      : "Update available";
  }
  return "Up to date";
}

export type QrEndpointOption = {
  readonly id: string;
  /**
   * Stable per endpoint *type* (endpointDefaultPreferenceKey). Multiple
   * endpoints can share one, so it is only used to match the saved default.
   */
  readonly preferenceKey: string;
  readonly qrShareable: boolean;
};

export function selectQrEndpointOption<T extends QrEndpointOption>(
  options: ReadonlyArray<T>,
  selectedId: string | null,
  defaultPreferenceKey: string | null,
): T | null {
  return (
    (selectedId !== null ? options.find((option) => option.id === selectedId) : undefined) ??
    (defaultPreferenceKey !== null
      ? options.find((option) => option.preferenceKey === defaultPreferenceKey)
      : undefined) ??
    options.find((option) => option.qrShareable) ??
    options[0] ??
    null
  );
}

export async function applyWslEnableSelection(input: {
  readonly bridge: WslEnableBridge;
  readonly mode: "both" | "wsl-only";
  readonly nextDistro: string | null;
  readonly persistedDistro: string | null;
}): Promise<DesktopWslState> {
  const { bridge, mode, nextDistro, persistedDistro } = input;

  // Stage every preference before enabling. The desktop only relaunches for
  // mode/distro changes while WSL is active, so the final enable observes the
  // complete selection and is the only call that may relaunch.
  await bridge.setWslOnly(mode === "wsl-only");
  if (persistedDistro !== nextDistro) {
    await bridge.setWslDistro(nextDistro);
  }
  return await bridge.setWslBackendEnabled(true);
}

export type HubPhoneQrTarget = {
  readonly endpoint: AdvertisedEndpoint;
  readonly endpointOrigin: string;
  readonly kind: "tailscale-https" | "tailnet" | "lan";
};

export function selectHubPhoneQrTarget(
  endpoints: ReadonlyArray<AdvertisedEndpoint>,
): HubPhoneQrTarget | null {
  const candidates = endpoints.flatMap((endpoint): HubPhoneQrTarget[] => {
    if (endpoint.status !== "available" || endpoint.reachability === "loopback") return [];
    let url: URL;
    try {
      url = new URL(endpoint.httpBaseUrl);
    } catch {
      return [];
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      isLoopbackHostname(url.hostname) ||
      url.username !== "" ||
      url.password !== ""
    )
      return [];
    const base = { endpoint, endpointOrigin: url.origin };
    if (
      endpoint.provider.id === "tailscale" &&
      endpoint.reachability === "private-network" &&
      endpoint.id.startsWith("tailscale-magicdns:") &&
      url.protocol === "https:"
    )
      return [{ ...base, kind: "tailscale-https" }];
    if (endpoint.provider.id === "tailscale" && endpoint.reachability === "private-network")
      return [{ ...base, kind: "tailnet" }];
    return endpoint.reachability === "lan" ? [{ ...base, kind: "lan" }] : [];
  });
  return (
    candidates.find((candidate) => candidate.kind === "tailscale-https") ??
    candidates.find((candidate) => candidate.kind === "tailnet") ??
    candidates.find((candidate) => candidate.kind === "lan") ??
    null
  );
}

export function buildHubPhoneQrPayload(target: HubPhoneQrTarget, credential: string): string {
  return buildMobilePairingLink(resolveDesktopPairingUrl(target.endpointOrigin, credential));
}

export function buildClientPairingQrPayload(pairingUrl: string): string {
  const hosted = readHostedPairingRequest(new URL(pairingUrl));
  const directUrl = hosted
    ? resolveDesktopPairingUrl(new URL(hosted.host).origin, hosted.token)
    : pairingUrl;
  return buildMobilePairingLink(directUrl);
}

const accessTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatAccessTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return accessTimestampFormatter.format(parsed);
}

export function parsePairingUrlFields(
  input: string,
): { readonly host: string; readonly pairingCode: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    const urlLikeInput =
      /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//u.test(trimmed) || trimmed.startsWith("//")
        ? trimmed
        : `https://${trimmed}`;
    const url = new URL(urlLikeInput, window.location.origin);
    const hostedPairingRequest = readHostedPairingRequest(url);
    if (hostedPairingRequest) {
      return {
        host: hostedPairingRequest.host,
        pairingCode: hostedPairingRequest.token,
      };
    }

    const pairingCode = getPairingTokenFromUrl(url);
    if (!pairingCode) return null;
    return {
      host: url.origin,
      pairingCode,
    };
  } catch {
    return null;
  }
}

export function parseRemotePairingFields(input: {
  readonly host: string;
  readonly pairingCode: string;
}): {
  readonly host: string;
  readonly pairingCode: string;
} {
  const parsedPairingUrl = parsePairingUrlFields(input.host);
  if (parsedPairingUrl) return parsedPairingUrl;

  const host = input.host.trim();
  const pairingCode = input.pairingCode.trim();
  if (!host) {
    throw new Error("Enter a backend host.");
  }
  if (!pairingCode) {
    throw new Error("Enter a pairing code.");
  }
  return { host, pairingCode };
}

export function formatDesktopSshConnectionError(error: unknown): string {
  const fallback = "Failed to connect SSH host.";
  const rawMessage = error instanceof Error ? error.message : fallback;
  const withoutIpcPrefix = rawMessage.replace(
    /^Error invoking remote method 'desktop:ensure-ssh-environment':\s*/u,
    "",
  );
  const withoutTaggedErrorPrefix = withoutIpcPrefix.replace(/^Ssh[A-Za-z]+Error:\s*/u, "");
  return withoutTaggedErrorPrefix.trim() || fallback;
}

export function sortDesktopPairingLinks(links: ReadonlyArray<ServerPairingLinkRecord>) {
  return [...links].toSorted(
    (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
}

export function summarizeAuthorizedClients(
  sessions: ReadonlyArray<ServerClientSessionRecord>,
  links: ReadonlyArray<ServerPairingLinkRecord>,
): string {
  const parts = [
    `${sessions.length} ${sessions.length === 1 ? "client" : "clients"}`,
    links.length > 0
      ? `${links.length} ${links.length === 1 ? "pairing link" : "pairing links"}`
      : null,
  ];
  return parts.filter((part): part is string => part !== null).join(" · ");
}

export function sortDesktopClientSessions(sessions: ReadonlyArray<ServerClientSessionRecord>) {
  return [...sessions].toSorted((left, right) => {
    if (left.current !== right.current) {
      return left.current ? -1 : 1;
    }
    if (left.connected !== right.connected) {
      return left.connected ? -1 : 1;
    }
    return new Date(right.issuedAt).getTime() - new Date(left.issuedAt).getTime();
  });
}

export function toDesktopPairingLinkRecord(pairingLink: AuthPairingLink): ServerPairingLinkRecord {
  return {
    ...pairingLink,
    scopes: pairingLink.permissions ?? pairingLink.scopes,
    createdAt: DateTime.formatIso(pairingLink.createdAt),
    expiresAt: DateTime.formatIso(pairingLink.expiresAt),
  };
}

export function toDesktopClientSessionRecord(
  clientSession: AuthClientSession,
): ServerClientSessionRecord {
  return {
    ...clientSession,
    scopes: clientSession.permissions ?? clientSession.scopes,
    issuedAt: DateTime.formatIso(clientSession.issuedAt),
    expiresAt: DateTime.formatIso(clientSession.expiresAt),
    lastConnectedAt:
      clientSession.lastConnectedAt === null
        ? null
        : DateTime.formatIso(clientSession.lastConnectedAt),
  };
}

export function selectPairingEndpoint(
  endpoints: ReadonlyArray<AdvertisedEndpoint>,
  defaultEndpointKey?: string | null,
): AdvertisedEndpoint | null {
  const availableEndpoints = endpoints.filter((endpoint) => endpoint.status !== "unavailable");
  if (defaultEndpointKey) {
    const selectedEndpoint = availableEndpoints.find(
      (endpoint) => endpointDefaultPreferenceKey(endpoint) === defaultEndpointKey,
    );
    if (selectedEndpoint) {
      return selectedEndpoint;
    }
  }
  return (
    availableEndpoints.find((endpoint) => endpoint.isDefault) ??
    availableEndpoints.find((endpoint) => endpoint.reachability !== "loopback") ??
    availableEndpoints.find((endpoint) => endpoint.compatibility.hostedHttpsApp === "compatible") ??
    null
  );
}

export function isTailscaleHttpsEndpoint(endpoint: AdvertisedEndpoint): boolean {
  return endpoint.id.startsWith("tailscale-magicdns:");
}

export function endpointDefaultPreferenceKey(endpoint: AdvertisedEndpoint): string {
  if (endpoint.id.startsWith("desktop-loopback:")) {
    return "desktop-core:loopback:http";
  }
  if (endpoint.id.startsWith("desktop-lan:")) {
    return "desktop-core:lan:http";
  }
  if (endpoint.id.startsWith("tailscale-ip:")) {
    return "tailscale:ip:http";
  }
  if (isTailscaleHttpsEndpoint(endpoint)) {
    return "tailscale:magicdns:https";
  }

  let scheme = "unknown";
  try {
    scheme = new URL(endpoint.httpBaseUrl).protocol.replace(/:$/u, "");
  } catch {}

  return `${endpoint.provider.id}:${endpoint.reachability}:${scheme}:${endpoint.label}`;
}

export function resolveAdvertisedEndpointPairingUrl(
  endpoint: AdvertisedEndpoint,
  credential: string,
): string {
  if (endpoint.compatibility.hostedHttpsApp === "compatible") {
    return (
      resolveHostedPairingUrl(endpoint.httpBaseUrl, credential) ??
      resolveDesktopPairingUrl(endpoint.httpBaseUrl, credential)
    );
  }
  return resolveDesktopPairingUrl(endpoint.httpBaseUrl, credential);
}

export function resolveCurrentOriginPairingUrl(credential: string): string {
  const url = new URL("/pair", window.location.href);
  return setPairingTokenOnUrl(url, credential).toString();
}

export function isHostedAppPairingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.pathname === "/pair" && url.searchParams.has("host");
  } catch {
    return false;
  }
}

export function endpointShareHint(endpoint: AdvertisedEndpoint, url: string): string {
  if (isHostedAppPairingUrl(url)) {
    return "Opens the hosted app, no install needed";
  }
  switch (endpoint.reachability) {
    case "lan":
      return "Devices on the same network";
    case "private-network":
      return "Devices on your private network";
    case "public":
      return "Reachable from anywhere";
    case "loopback":
      return "Clients on this machine";
  }
}
