// The approved provider wire (docs/part2/provider-wire.md), as lane C generates it on goat2_contracts_step2 1a1b123
// (crates/goat2-contracts/src/provider.rs -> packages/contracts-rs/src/generated/*). A field-for-field mirror until
// that step reaches goat2; then these types are imported from @goat2/contracts-rs and this file shrinks to re-exports.
// Shapes are v1's (packages/contracts/src/{server,providerSetup,acpRegistry}.ts at goat 916b5ccc1b2).

export type ProviderInstanceId = string;

export interface ServerProviderAuth {
  status: "authenticated" | "unauthenticated" | "unknown";
  type?: string;
  label?: string;
  email?: string;
  action?: { elicitationId: string; url: string; message: string; createdAt?: string; expiresAt?: string };
  canLogout?: boolean;
  subscriptionSharing?: boolean;
  profileId?: string;
  workspaceId?: string;
  endpoint?: string;
}

export interface ServerProviderModel {
  slug: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  aliases?: string[];
  badge?: "new";
  isCustom: boolean;
  isDefault?: boolean;
  isLegacy?: boolean;
  supportsTextGeneration?: boolean;
  capabilities: { optionDescriptors?: unknown[] } | null;
}

export interface ProviderProbeResult {
  installed: boolean;
  version: string | null;
  installedVersion?: string | null;
  cli?: "present" | "missing" | "none";
  binaryPath?: string;
  status: "ready" | "warning" | "error" | "disabled";
  auth: ServerProviderAuth;
  models: ServerProviderModel[];
  checkedAt: string;
  message?: string;
}

export interface ProviderAuthState {
  instanceId: ProviderInstanceId;
  phase: "idle" | "starting" | "waiting" | "verifying" | "succeeded" | "failed" | "cancelled";
  flowId: string | null;
  /** Carries an engine AuthRequired URL (http/https only). */
  authorizationUrl: string | null;
  expiresAt: string | null;
  message: string | null;
  methods?: Array<{ id: string; accountEmail?: string; canRemove?: boolean; name: string; description: string | null; type: string }>;
  interaction?:
    | { type: "browser"; id: string; url: string; requiresConsent: boolean; acceptsCallback?: boolean }
    | { type: "deviceCode"; id: string; url: string; userCode: string }
    | { type: "terminal"; id: string; output: string; outputOffset?: number }
    | { type: "credentials"; id: string; fields: unknown[] }
    | null;
}

export interface ProviderInstallState {
  driver: string;
  operationId: string | null;
  phase: "idle" | "downloading" | "extracting" | "verifying" | "succeeded" | "failed" | "cancelled";
  downloadedBytes: number;
  totalBytes: number | null;
  version: string | null;
  installedVersion: string | null;
  executablePath?: string | null;
  source?: unknown;
  canRemove: boolean;
  message: string | null;
}

export interface ServerProviderEntry {
  instanceId: ProviderInstanceId;
  driver: string;
  displayName?: string;
  enabled: boolean;
  acpAgentId?: string;
  setup?: { canAuthenticate: boolean; canInstall: boolean; documentationUrl?: string };
  capabilities: Record<string, unknown>;
  probe: ProviderProbeResult;
  authFlow?: ProviderAuthState;
  install?: ProviderInstallState;
}

export interface AcpRegistrySearchAgent {
  id: string;
  name: string;
  version: string;
  description: string;
  authors: string[];
  license: string | null;
  website: string | null;
  repository: string | null;
  icon: string | null;
  distribution: unknown;
  integrity: unknown;
}
export interface AcpRegistrySearchResult { agents: AcpRegistrySearchAgent[] }
export interface AcpRegistryPrepareResult { agentId: string; version: string; distribution: unknown; prepared: true }

/** The provider commands (ClientFrame variants) without reqId / clientRequestId. */
export type ProviderCommandBody =
  | { type: "refresh_providers"; instanceId?: ProviderInstanceId; refreshModels?: boolean }
  | { type: "provider_install_start"; instanceId: ProviderInstanceId }
  | { type: "provider_install_cancel"; instanceId: ProviderInstanceId; operationId: string }
  | { type: "provider_auth_start"; instanceId: ProviderInstanceId; methodId?: string }
  | { type: "provider_auth_cancel"; instanceId: ProviderInstanceId; flowId: string }
  | { type: "provider_auth_logout"; instanceId: ProviderInstanceId }
  | { type: "accept_acp_registry_url_auth"; instanceId: ProviderInstanceId; elicitationId: string }
  | { type: "search_acp_registry"; query: string; limit?: number }
  | { type: "prepare_acp_registry_agent"; agentId: string }
  | { type: "set_provider_instance"; instanceId: ProviderInstanceId; driver: string; acpAgentId?: string; enabled: boolean; displayName?: string };

/** command_result.value fields the provider commands fill (CommandValue). */
export interface ProviderCommandValue {
  installState?: ProviderInstallState;
  authState?: ProviderAuthState;
  accepted?: boolean;
  registrySearch?: AcpRegistrySearchResult;
  registryPrepare?: AcpRegistryPrepareResult;
}

export interface ProvidersFrame { type: "providers"; subId: string; providers: ServerProviderEntry[] }
