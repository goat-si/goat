# P2-M proposal: provider commands on the host wire (additive, v1 names and shapes)

From goat2_providers_ui thread mcp:28f74b44-8da9-4850-904d-47f6dd9311e0. v1 ref goat 916b5ccc1b2. Every shape below is a v1
contract (packages/contracts/src/{rpc.ts,server.ts,providerSetup.ts,acpRegistry.ts}); the UI side lifts v1 components
byte-identical, so the closer the wire stays to v1 the smaller the UI seam.

## Subscription
- ClientFrame subscribe_providers {subId}
- HostFrame providers {subId, providers: ServerProviderEntry[]}  (full list on subscribe and on every change; 11 local
  driver kinds + installed ACP registry agents; small enough to resend whole)
- ServerProviderEntry = v1 ServerProvider subset: {instanceId, driver (ProviderDriverKind string), displayName?, enabled,
  acpAgentId?, setup?: {canAuthenticate, canInstall, documentationUrl?}, capabilities: ProviderCapabilities,
  probe: ProviderProbeResult (lane C, probe.rs), authFlow?: ProviderAuthState, install?: ProviderInstallState}

## Commands (ClientFrame, answered by command_result)
| GOAT 2 frame | v1 method | payload | result value |
|---|---|---|---|
| refresh_providers | server.refreshProviders | {instanceId?, refreshModels?} | none (subscription carries the list) |
| provider_install_start | providerInstall.start | {instanceId} | ProviderInstallState |
| provider_install_cancel | providerInstall.cancel | {instanceId, operationId} | ProviderInstallState |
| provider_auth_start | providerAuth.start | {instanceId, methodId?} | ProviderAuthState (authorizationUrl = the AuthRequired url) |
| provider_auth_cancel | providerAuth.cancel | {instanceId, flowId} | ProviderAuthState |
| provider_auth_logout | providerAuth.logout | {instanceId} | ProviderAuthState |
| accept_acp_registry_url_auth | server.acceptAcpRegistryUrlAuth | {instanceId, elicitationId} | {accepted} |
| search_acp_registry | server.searchAcpRegistry | {query, limit?} | AcpRegistrySearchResult {agents[]} |
| prepare_acp_registry_agent | server.prepareAcpRegistryAgent | {agentId} | AcpRegistryPrepareResult |
| set_provider_instance | settings providerInstances upsert (v1 updateSettings) | {instanceId, driver, acpAgentId?, enabled, displayName?} | none |

EngineEvent::AuthRequired{url} during a run maps to probe.auth.action (AcpRegistryUrlAuthAction) on the entry, so the
settings card and the inbox show the same URL. Model change stays change_thread (already on the wire); bot model =
change_thread on the bot's thread.

## Types to add in goat2-contracts (lane C)
ProviderAuthState, ProviderAuthMethod (subset), ProviderInstallState, AcpRegistrySearchAgent, AcpRegistrySearchResult,
AcpRegistryPrepareResult, ServerProviderEntry; frames above. All additive.

