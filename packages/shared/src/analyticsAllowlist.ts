/**
 * The product analytics events and properties GOAT's ingest stores. The ingest Worker
 * (infra/ingest) drops every other event and property, so a new event or property is
 * stored only after it is added here and the Worker is redeployed. This list is the
 * reviewed privacy boundary: check an addition against "Collection boundary" in
 * docs/internals/product-analytics.md before adding it.
 */

/** Properties AnalyticsService adds to every event it sends. */
export const ANALYTICS_COMMON_PROPERTIES: ReadonlyArray<string> = [
  "installId",
  "platform",
  "wsl",
  "arch",
  "t3CodeVersion",
  "telemetryChannel",
  "clientType",
  "serverOs",
  "serverArch",
  "serverWslDistro",
  "serverAppVersion",
  "serverMode",
];

/** What a connecting client reported about itself (readClientAnalyticsProps in ws.ts). */
const CLIENT_PROPERTIES = [
  "surface",
  "appVersion",
  "clientAppVersion",
  "clientOs",
  "os",
  "clientDeviceType",
  "webDeployment",
  "clientBrowser",
  "osMajorVersion",
  "clientOsMajorVersion",
  "deviceModel",
  "clientDeviceModel",
  "connectionMethod",
];

/** ChatGPT sign-in and profile transfer (CodexChatGptAuth.ts track). */
const CHATGPT_STARTED_PROPERTIES = ["flow", "intent", "callbackMode"];
const CHATGPT_COMPLETED_PROPERTIES = [
  ...CHATGPT_STARTED_PROPERTIES,
  "outcome",
  "durationMs",
  "failureStage",
  "accountCountScope",
  "connectedAccountCount",
  "connectedConnectionCount",
  "savedConnectionCount",
  "unidentifiedConnectedConnectionCount",
];

/** Each event the server records, and the properties it may carry besides the common ones. */
export const ANALYTICS_EVENT_PROPERTIES: Readonly<Record<string, ReadonlyArray<string>>> = {
  "server.boot.heartbeat": ["threadCount", "projectCount"],
  "install.owner_observed": ["ownerSource", "ownerId", "observedBy"],
  "client.connected": CLIENT_PROPERTIES,
  "client.thread.started": CLIENT_PROPERTIES,
  "client.turn.requested": CLIENT_PROPERTIES,
  "feature.used": ["feature", "variant", "surface"],
  "chatgpt.auth.started": CHATGPT_STARTED_PROPERTIES,
  "chatgpt.auth.completed": CHATGPT_COMPLETED_PROPERTIES,
  "chatgpt.transfer.started": CHATGPT_STARTED_PROPERTIES,
  "chatgpt.transfer.completed": CHATGPT_COMPLETED_PROPERTIES,
  "provider.turn.completed": [
    "provider",
    "terminalStatus",
    "usageStatus",
    "usageScope",
    "hasSubagents",
    "inputTokens",
    "cachedInputTokens",
    "cacheCreationTokens",
    "outputTokens",
    "reasoningTokens",
    "model",
    "mixedModels",
    "effort",
    "runtimeMode",
    "interactionMode",
    "durationMs",
  ],
  "mcp.tool.invoked": [
    "tool",
    "callerProvider",
    "callerModel",
    "callerOrigin",
    "callerDepth",
    "durationMs",
    "outcome",
    "errorCode",
    "targetChosen",
    "mode",
    "waitTimedOut",
    "batchSize",
    "workspace",
    "delivery",
    "bindToCurrentThread",
    "targetProvider",
    "targetModel",
    "targetRuntimeMode",
    "targetInteractionMode",
    "crossProvider",
  ],
  "mcp.delegated_task.finished": [
    "status",
    "callerProvider",
    "callerModel",
    "targetProvider",
    "targetModel",
    "crossProvider",
    "completionWake",
    "durationSeconds",
  ],
};
