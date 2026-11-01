/**
 * Adding a provider from a client or an agent: which drivers can be added on an
 * environment, their install and sign-in state, and the redacted view of a
 * sign-in flow that MCP tools may return.
 *
 * Kept apart from providerSetup.ts so host-aware callers (a provider x host
 * matrix) can import these shapes and add an optional host without pulling in
 * the client RPC types. Nothing here may carry API keys, OAuth tokens,
 * authorization codes, callback URLs, terminal output, or credential values.
 */
import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { HandoffSummary } from "./handoff.ts";
import { ProviderDiagnosisFix } from "./providerDiagnosis.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import type { ProviderAuthState } from "./providerSetup.ts";
import { ServerProviderAuthStatus, ServerProviderState } from "./server.ts";

/** The provider's own sign-in command, for drivers whose sign-in may need its terminal. */
export const PROVIDER_SIGN_IN_COMMANDS: Readonly<Record<string, string>> = {
  claudeAgent: "claude auth login",
  claudeCloud: "claude auth login --claudeai",
  opencode: "opencode auth login",
};

/** The handoff target path that asks a person to finish provider setup in the app. */
export const PROVIDER_SETUP_HANDOFF_PATH = "provider.setup";

/**
 * How a person signs in. `inApp` methods finish inside the add-provider popup;
 * `command` means the provider only signs in from its own terminal command,
 * and `environment` means it reads a key from the instance's environment.
 */
export const ProviderSignInKind = Schema.Literals([
  "browser",
  "deviceCode",
  "terminal",
  "credentials",
  "agent",
  "command",
  "environment",
  "linked",
  "none",
]);
export type ProviderSignInKind = typeof ProviderSignInKind.Type;

export const ProviderAddableInstance = Schema.Struct({
  instanceId: ProviderInstanceId,
  displayName: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  status: ServerProviderState,
  auth: ServerProviderAuthStatus,
});
export type ProviderAddableInstance = typeof ProviderAddableInstance.Type;

export const ProviderAddableDriver = Schema.Struct({
  driver: ProviderDriverKind,
  displayName: TrimmedNonEmptyString,
  install: Schema.Struct({
    state: Schema.Literals(["installed", "missing", "unknown"]),
    /** GOAT can download and install this CLI from the add-provider popup. */
    inApp: Schema.Boolean,
    version: Schema.NullOr(TrimmedNonEmptyString),
  }),
  signIn: Schema.Struct({
    kind: ProviderSignInKind,
    inApp: Schema.Boolean,
    /** The provider's own command when sign-in cannot finish in the app. */
    command: Schema.NullOr(TrimmedNonEmptyString),
  }),
  instances: Schema.Array(ProviderAddableInstance),
});
export type ProviderAddableDriver = typeof ProviderAddableDriver.Type;

export const ProviderAddableListResult = Schema.Struct({
  environmentId: EnvironmentId,
  drivers: Schema.Array(ProviderAddableDriver),
});
export type ProviderAddableListResult = typeof ProviderAddableListResult.Type;

/**
 * A sign-in flow as an agent may see it. A device code and its verification
 * URL are meant to be shown to a person; everything else a flow carries
 * (authorization and callback URLs, terminal output, credential fields) stays
 * with the client that owns the flow.
 */
export const ProviderLoginFlow = Schema.Struct({
  instanceId: ProviderInstanceId,
  flowId: Schema.NullOr(TrimmedNonEmptyString),
  phase: Schema.Literals([
    "idle",
    "starting",
    "waiting",
    "verifying",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  /** Where the person continues: a device code page, or the GOAT app (browser, terminal, or form). */
  continueIn: Schema.NullOr(Schema.Literals(["device", "app"])),
  deviceCode: Schema.NullOr(
    Schema.Struct({ url: TrimmedNonEmptyString, userCode: TrimmedNonEmptyString }),
  ),
  expiresAt: Schema.NullOr(IsoDateTime),
  message: Schema.NullOr(Schema.String),
});
export type ProviderLoginFlow = typeof ProviderLoginFlow.Type;

// verification_uri_complete may repeat the user code; nothing else a device page needs is secret-free.
const DEVICE_URL_QUERY_KEYS = new Set(["user_code"]);

/** A plain https device page, keeping only the query keys a person needs. */
const deviceVerificationUrl = (value: string): string | null => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const query = new URLSearchParams();
  for (const [key, entry] of url.searchParams)
    if (DEVICE_URL_QUERY_KEYS.has(key)) query.append(key, entry);
  url.search = query.toString();
  url.hash = "";
  return url.toString();
};

// Drivers write free text into state.message. An agent gets this fixed text
// instead, so no driver can leak a token or URL through it.
const PHASE_MESSAGES: Record<ProviderLoginFlow["phase"], string | null> = {
  idle: null,
  starting: "Sign-in is starting.",
  waiting: "Waiting for the person to finish signing in.",
  verifying: "Checking the new sign-in.",
  succeeded: "Signed in.",
  failed: "Sign-in failed. The person can see why in GOAT.",
  cancelled: "Sign-in was cancelled.",
};

/** Projects a flow state onto the fields an agent may read. */
export const redactProviderAuthState = (state: ProviderAuthState): ProviderLoginFlow => {
  const interaction = state.interaction ?? null;
  const deviceUrl =
    interaction?.type === "deviceCode" ? deviceVerificationUrl(interaction.url) : null;
  const deviceCode =
    interaction?.type === "deviceCode" && deviceUrl !== null
      ? { url: deviceUrl, userCode: interaction.userCode }
      : null;
  const active =
    state.phase === "starting" || state.phase === "waiting" || state.phase === "verifying";
  return {
    instanceId: state.instanceId,
    flowId: state.flowId,
    phase: state.phase,
    continueIn: deviceCode ? "device" : active && interaction !== null ? "app" : null,
    deviceCode,
    expiresAt: state.expiresAt,
    message: PHASE_MESSAGES[state.phase],
  };
};

const ProviderOnboardingError = Schema.Struct({
  kind: Schema.Literal("error"),
  code: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  fix: Schema.optionalKey(ProviderDiagnosisFix),
});

const NeedsHuman = Schema.Struct({
  kind: Schema.Literal("needs_human"),
  handoff: HandoffSummary,
  next: Schema.Struct({
    after: Schema.Literal("approval"),
    call: Schema.Literal("goat_provider_addable_list"),
  }),
});

export const ProviderLoginStartInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  methodId: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
});
export type ProviderLoginStartInput = typeof ProviderLoginStartInput.Type;

export const ProviderLoginFlowInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  flowId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type ProviderLoginFlowInput = typeof ProviderLoginFlowInput.Type;

export const ProviderLoginResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("flow"), flow: ProviderLoginFlow }),
  NeedsHuman,
  ProviderOnboardingError,
]);
export type ProviderLoginResult = typeof ProviderLoginResult.Type;
export const ProviderLoginResultJson = Schema.toCodecJson(ProviderLoginResult);
/** Following or cancelling a flow reports it; only starting one can ask a person. */
export const ProviderLoginFlowResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("flow"), flow: ProviderLoginFlow }),
  ProviderOnboardingError,
]);
export const ProviderLoginFlowResultJson = Schema.toCodecJson(ProviderLoginFlowResult);

/** Asks a person to open the add-provider popup, preselecting a driver or an instance to sign in. */
export const ProviderSetupOpenInput = Schema.Struct({
  driver: Schema.optionalKey(ProviderDriverKind),
  instanceId: Schema.optionalKey(ProviderInstanceId),
});
export type ProviderSetupOpenInput = typeof ProviderSetupOpenInput.Type;

export const ProviderSetupOpenResult = Schema.Union([NeedsHuman, ProviderOnboardingError]);
export type ProviderSetupOpenResult = typeof ProviderSetupOpenResult.Type;
export const ProviderSetupOpenResultJson = Schema.toCodecJson(ProviderSetupOpenResult);

/** What the popup opens to; delivered only through an authenticated handoff open. */
export const ProviderSetupIntent = Schema.Struct({
  driver: Schema.optionalKey(ProviderDriverKind),
  instanceId: Schema.optionalKey(ProviderInstanceId),
});
export type ProviderSetupIntent = typeof ProviderSetupIntent.Type;
