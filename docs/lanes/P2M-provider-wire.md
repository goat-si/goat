<!-- Copied from /tmp/p2m/wire-proposal.md on 2026-11-28 (approved by the owner for lane E; lane C adds the types). -->

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


## Lane E plan (goat2-host)



- providers module next to the engine factory registry/probe: subscribe_providers -> providers frame pushed on change.

- refresh_providers, provider_install_start/cancel, provider_auth_start/cancel/logout (authorizationUrl from EngineEvent::AuthRequired / probe), accept_acp_registry_url_auth, search_acp_registry, prepare_acp_registry_agent (delegate to P2-B registry module), set_provider_instance (persist provider instances in host settings).

- Port flows from v1 server code: rpc.ts server.refreshProviders, providerInstall.*, providerAuth.*, server.*AcpRegistry*.

- Starts after lane C merges the types.

## Host behaviours the lifted v1 screens need (P2-M, 2026-11-29; within the approved wire)

1. ACP registry entries: once the agent's auth methods are known (v1 discovers them through ACP initialize), send the
   entry with authFlow = {phase: 'idle', flowId: null, authorizationUrl: null, expiresAt: null, message: null,
   methods: [ProviderAuthMethod...]}. Without methods, v1's wizard and provider card stay on "Discovering sign-in
   methods..." forever (v1 ProviderAuthenticationSection.tsx:68-73, AddProviderInstanceDialog.logic.ts:63).
2. refresh_providers: always send a providers frame after a refresh, even if nothing changed (checkedAt moves); the UI
   resolves the refresh on the next providers frame.
- The UI shows v1's cloud defaults (Claude/Cursor/Devin Cloud) as switched off locally; the host never reports them.
- Fake-host reference: apps/web/src/host/fakeProviders.ts on origin/goat2_providers_ui.

3. refresh_providers ordering (P2-M review, origin/goat2_providers_ui a38f1d6): send the refresh's providers frame
   BEFORE its command_result, on the same socket. The UI resolves the refresh with the latest list when the
   command_result arrives if a providers frame came after the request; otherwise it waits up to 15 s and then reports
   "The host did not send its provider list after the refresh." Host plan: refresh completes the probe, pushes the
   providers frame to every subscription on the requesting socket, then answers command_result (WS module sends both
   through the same per-socket queue, so the order holds).
