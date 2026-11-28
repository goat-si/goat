/**
 * Changing an environment's provider instances over MCP: the same writes
 * Settings → Providers makes, for callers allowed to manage providers.
 *
 * Results describe an instance by names only (environment variable names and
 * config keys), never values, so a secret set through these tools is never
 * echoed back.
 */
import * as Schema from "effect/Schema";

import { SshHostAlias, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { HandoffSummary } from "./handoff.ts";
import { ProviderOptionSelection } from "./model.ts";
import {
  ProviderDriverKind,
  ProviderInstanceEnvironmentVariableName,
  ProviderInstanceId,
} from "./providerInstance.ts";

/** The approval handoff path whose approval applies a provider settings change. */
export const PROVIDER_SETTINGS_HANDOFF_PATH = "provider.settings";

const host = Schema.optional(SshHostAlias).annotate({
  description:
    "SSH host alias whose own GOAT environment should change. Omit for this environment.",
});

const ConfigPatch = Schema.Record(Schema.String, Schema.Unknown).annotate({
  description:
    "Driver-specific settings, merged key by key into the instance's current config; null removes a key. Examples: binaryPath, homePath, customModels, sourceInstanceId (Cursor and Claude Cloud), siblingInstanceId (Devin Cloud), agentId and commandPath (ACP Registry).",
});

const EnvironmentPatch = Schema.Array(
  Schema.Struct({
    name: ProviderInstanceEnvironmentVariableName,
    value: Schema.NullOr(Schema.String).annotate({ description: "null removes the variable." }),
    sensitive: Schema.optionalKey(Schema.Boolean),
  }),
).annotate({
  description:
    "Environment variables for the provider process, merged by name. Values are stored and never returned.",
});

export const ProviderUpdateInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  enabled: Schema.optionalKey(Schema.Boolean),
  displayName: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)).annotate({
    description: "New name; null restores the driver's name.",
  }),
  accentColor: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  config: Schema.optionalKey(ConfigPatch),
  environment: Schema.optionalKey(EnvironmentPatch),
  defaultModel: Schema.optionalKey(
    Schema.Struct({
      model: TrimmedNonEmptyString,
      options: Schema.optionalKey(Schema.Array(ProviderOptionSelection)),
    }),
  ).annotate({ description: "Make this instance and model the default for new threads." }),
  install: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "ACP Registry instances only: download the registry agent now with GOAT's in-app installer.",
  }),
  host,
});
export type ProviderUpdateInput = typeof ProviderUpdateInput.Type;

export const ProviderAddInput = Schema.Struct({
  driver: Schema.optionalKey(ProviderDriverKind).annotate({
    description:
      "Driver to add, as goat_provider_addable_list names it. Defaults to acpRegistry when acpAgentId is set.",
  }),
  instanceId: Schema.optionalKey(ProviderInstanceId).annotate({
    description: "Defaults to the driver name, or the agent id for ACP Registry, made unique.",
  }),
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
  enabled: Schema.optionalKey(Schema.Boolean).annotate({ description: "Defaults to true." }),
  acpAgentId: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(128))).annotate({
    description: "ACP Registry agent to run, such as devin.",
  }),
  config: Schema.optionalKey(ConfigPatch),
  environment: Schema.optionalKey(EnvironmentPatch),
  install: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "ACP Registry agents only: download the agent now with GOAT's in-app installer. Defaults to true for registry agents.",
  }),
  linkTo: Schema.optionalKey(ProviderInstanceId).annotate({
    description:
      "A Cursor Cloud, Claude Cloud, or Devin Cloud instance that should use the new instance as its login source.",
  }),
  host,
});
export type ProviderAddInput = typeof ProviderAddInput.Type;

export const ProviderLinkInput = Schema.Struct({
  instanceId: ProviderInstanceId.annotate({
    description: "The cloud instance: cursorCloud, claudeCloud, devinCloud, or a custom one.",
  }),
  siblingInstanceId: ProviderInstanceId.annotate({
    description:
      "The local instance whose executable and sign-in it uses: a Cursor instance for Cursor Cloud, a Claude instance for Claude Cloud, an ACP Registry Devin instance for Devin Cloud.",
  }),
  host,
});
export type ProviderLinkInput = typeof ProviderLinkInput.Type;

export const ProviderRemoveInput = Schema.Struct({ instanceId: ProviderInstanceId, host });
export type ProviderRemoveInput = typeof ProviderRemoveInput.Type;

export const ProviderManageAction = Schema.Literals(["update", "add", "link", "remove"]);
export type ProviderManageAction = typeof ProviderManageAction.Type;

export const ProviderInstanceSummary = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
  /** Names only. */
  environment: Schema.Array(TrimmedNonEmptyString),
  configKeys: Schema.Array(Schema.String),
});
export type ProviderInstanceSummary = typeof ProviderInstanceSummary.Type;

export const ProviderManageResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("applied"),
    action: ProviderManageAction,
    /** The instance after the change; null after remove. */
    instance: Schema.NullOr(ProviderInstanceSummary),
    /** The cloud instance a link or linkTo changed. */
    linked: Schema.optionalKey(ProviderInstanceSummary),
    installed: Schema.optionalKey(
      Schema.Struct({ agentId: TrimmedNonEmptyString, version: TrimmedNonEmptyString }),
    ),
    next: Schema.Struct({ call: Schema.Literal("goat_provider_diagnose") }),
    host: Schema.optionalKey(SshHostAlias),
  }),
  Schema.Struct({
    kind: Schema.Literal("needs_human"),
    handoff: HandoffSummary,
    next: Schema.Struct({
      after: Schema.Literal("approval"),
      call: Schema.Literal("goat_provider_diagnose"),
    }),
    host: Schema.optionalKey(SshHostAlias),
  }),
]);
export type ProviderManageResult = typeof ProviderManageResult.Type;
export const ProviderManageResultJson = Schema.toCodecJson(ProviderManageResult);
