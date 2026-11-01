import type { ServerSettingsPatch } from "../settings.ts";
import type { AgentSurfacePath } from "./registry.ts";

/**
 * Who may change each server setting through the agent surface: agent (environment.settings_update),
 * path (a dedicated path whose write does more than store the value) or person (with the reason).
 * Classifying a new setting makes it reachable without a new tool (agent-surface.md#settings).
 */
export type SettingsAccess =
  | { readonly access: "agent" }
  | { readonly access: "path"; readonly path: AgentSurfacePath }
  | { readonly access: "person"; readonly reason: string };

export type SettingsKey = keyof typeof ServerSettingsPatch.fields | "memoryOwnerSourceReadPolicy";

const agent = { access: "agent" } as const;
const path = (owner: AgentSurfacePath) => ({ access: "path", path: owner }) as const;
const person = (reason: string) => ({ access: "person", reason }) as const;

const GRANTS_AGENTS = "It widens what agents may do; a person grants that.";
const HOLDS_SECRETS = "It holds credentials; a person enters them in Settings.";

export const SETTINGS_ACCESS = {
  setModelFavorites: agent,
  setModelsHidden: agent,
  setProviderModelOrder: agent,
  favorites: agent,
  providerModelPreferences: agent,
  migrateModelPreferences: agent,
  worktreeCleanup: agent,
  storageCleanup: agent,
  worktreesDirectory: agent,
  enableAgentMemoryAccess: person(GRANTS_AGENTS),
  agentWorkspaceAccess: person(GRANTS_AGENTS),
  agentTerminalAccess: person(GRANTS_AGENTS),
  memoryOwnerSourceReadPolicy: person(
    "It widens what memory reaches and grants standing consent; a person decides in Settings.",
  ),
  memoryEnabled: path("memory.settings_update"),
  memoryModelSelection: path("memory.settings_update"),
  goatBotModelSelection: agent,
  channelAutoPlacement: agent,
  responseStreamingMode: agent,
  enableProviderUpdateChecks: agent,
  continueThreadsAfterServerUpdate: agent,
  automaticServerUpdates: agent,
  enableAgentBrowserAccess: person(GRANTS_AGENTS),
  blockedBrowserHosts: person("It controls which browser hosts agents may use; a person decides."),
  projectAgentBrowserAccessOverrides: person(GRANTS_AGENTS),
  defaultAutoPull: agent,
  defaultProjectScripts: agent,
  projectScriptOverrides: agent,
  projectAutoPullOverrides: agent,
  defaultModelSelection: path("provider.update"),
  defaultRuntimeMode: person(
    "It sets the runtime mode new threads start in; a person chooses how much agents may do.",
  ),
  projectSettingsOverrides: person(
    "Each entry replaces a project's whole override set, including runtime mode, agent access and provider overrides. Project defaults go through project.update and project standing instructions through environment.preferences_update.",
  ),
  enableAgentDeviceAccess: person(GRANTS_AGENTS),
  agentToolListing: agent,
  enableDeviceSupport: person("It turns on control of phones and simulators on this machine."),
  enableCua: path("computer_use.update"),
  disabledBuiltInSkills: agent,
  cuaFullAccessAutoAdmit: person(GRANTS_AGENTS),
  cuaMovePointer: person(GRANTS_AGENTS),
  cuaAllowedApps: person(GRANTS_AGENTS),
  cuaDeniedApps: person("An organization or person sets the computer use safety boundary."),
  deviceOnboardingCompleted: agent,
  deviceHosts: person("It adds machines this server connects to over SSH."),
  easDeviceHosts: person(HOLDS_SECRETS),
  sidebarAutoSettleAfterDays: agent,
  compactIdleThreads: agent,
  idleCompaction: agent,
  sidebarAutoSettleKeepPullRequests: agent,
  sidebarAutoSettleOnMerge: agent,
  autoResumeLimitedThreads: agent,
  snoozeLimitedThreads: agent,
  snoozePresets: agent,
  fleet: path("fallback_chain.set"),
  goatclaw: person("It is the permission policy that bounds agents."),
  hub: person("It links this machine with other machines."),
  guestSharingEnabled: person("It lets guests reach this environment."),
  backgroundActivity: agent,
  automaticGitFetchInterval: agent,
  providerHealthRefreshInterval: agent,
  backgroundActivityProfile: agent,
  environmentIcon: agent,
  defaultThreadEnvMode: agent,
  newWorktreesStartFromOrigin: agent,
  worktreeSubmodules: agent,
  addProjectBaseDirectory: agent,
  textGenerationModelSelection: agent,
  threadTitleInstructions: agent,
  branchNamingMode: agent,
  branchNamePrefix: agent,
  branchNameInstructions: agent,
  standingInstructions: agent,
  removeAgentCreditsOnMerge: agent,
  sourceControlWritingStyle: agent,
  pullRequestWatchPolicy: agent,
  sourceControlWriterModelSelection: agent,
  reviewGuidesEnabled: agent,
  reviewGuideModelSelection: agent,
  reviewGuideInstructions: agent,
  pullRequestMergeMethod: agent,
  observability: person("It sends telemetry from this machine to an outside address."),
  sourceControlHosts: person(HOLDS_SECRETS),
  completionWebhook: person("It sends reports to an outside address and holds a signing secret."),
  providerInstances: path("provider.update"),
  usageLimitSources: person(HOLDS_SECRETS),
  cursorKeychainUsageEnabled: person("It reads the system keychain."),
  usagePriceOverrides: agent,
  usageModelAliases: agent,
  goatBotHome: path("channel.bot_home_claim"),
} as const satisfies { readonly [K in SettingsKey]-?: SettingsAccess };

/**
 * Paths besides environment.settings_update that declare the settings.write capability, and the
 * transition each performs beyond persisting a value. A new one belongs here only with a reason a
 * reviewer accepts; a setting that only needs a value stored is classified agent instead.
 */
export const SETTINGS_WRITE_EXCEPTIONS = {
  "environment.preferences_update":
    "The first settings tool, kept for callers that use it; it also edits project standing instructions inside project overrides.",
  "thread.replication_set": "Changes checkpoint capture policy for a host alias.",
  "fallback_chain.set": "Validates chain steps against provider instances and selects the default.",
  "memory.settings_update": "Versioned compare-and-swap on the memory service's settings.",
  "memory.hub_disable": "Disables the memory hub through its versioned transition.",
  "memory.hub_reconcile": "Rearms recoverable hub holds after verifying the published hub version.",
  "memory.report_attempts_reset": "Rearms eligible failed reports for delivery.",
  "provider.update": "Installs agents, routes approvals and audits provider changes.",
  "provider.add": "Creates a provider instance and starts its setup.",
  "provider.link": "Links a provider instance to credentials.",
  "provider.remove": "Removes a provider instance and its credentials.",
  "project.update": "Updates a project record through the project service.",
  "project.delete": "Deletes a project and its threads.",
} as const satisfies Partial<Record<AgentSurfacePath, string>>;
