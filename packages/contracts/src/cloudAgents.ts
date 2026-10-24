import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  ProjectId,
  SshHostAlias,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { OrchestrationV2CloudTask } from "./orchestrationV2.ts";
import { needsHumanFields } from "./humanStepResult.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * Cloud agents (Claude Cloud, Cursor Cloud, Devin Cloud) run on a vendor's machines under one
 * sign-in. A credential holder is a GOAT environment, this one or a connected SSH host, whose
 * own provider instance holds a usable sign-in. Holders answer only whether they are ready and a
 * non-secret account label; launches run on the holder, so credentials never leave it.
 * See docs/internals/cloud-credential-holders.md.
 */

export const CloudAgentProvider = Schema.Literals(["claudeCloud", "cursorCloud", "devinCloud"]);
export type CloudAgentProvider = typeof CloudAgentProvider.Type;

/**
 * Claude Cloud starts from a project folder, and Claude Code asks once per folder whether to
 * trust it. GOAT answers that prompt itself for its own projects; this is what a person sees.
 *
 * Deprecated since GOAT 0.1.2, which trusts folders on its own and no longer shows them. Kept for
 * Fleet in older clients; remove with the folder trust RPCs in GOAT 0.2.0.
 */
export const CloudFolderTrust = Schema.Struct({
  instanceId: ProviderInstanceId,
  projectId: ProjectId,
  title: Schema.String,
  path: Schema.String,
  /** What Claude Code's own config says; null when it cannot be read. */
  trusted: Schema.NullOr(Schema.Boolean),
  /** The last time GOAT accepted this folder's trust prompt. */
  acceptedByGoatAt: Schema.NullOr(IsoDateTime),
});
export type CloudFolderTrust = typeof CloudFolderTrust.Type;

export const CloudFolderTrustListInput = Schema.Struct({});
export const CloudFolderTrustListResult = Schema.Struct({
  folders: Schema.Array(CloudFolderTrust),
});
export type CloudFolderTrustListResult = typeof CloudFolderTrustListResult.Type;

export const CloudFolderTrustAcceptInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  projectId: ProjectId,
});
export type CloudFolderTrustAcceptInput = typeof CloudFolderTrustAcceptInput.Type;
export const CLOUD_AGENT_PROVIDERS: ReadonlyArray<CloudAgentProvider> = [
  "claudeCloud",
  "cursorCloud",
  "devinCloud",
];
export const isCloudAgentProvider = Schema.is(CloudAgentProvider);

/** "local" names the environment that answers the call; otherwise an SSH host alias. */
export const CloudHolderName = Schema.Union([Schema.Literal("local"), SshHostAlias]);
export type CloudHolderName = typeof CloudHolderName.Type;

/** Who started a run outside GOAT, as a person would name it: "Grok Bot", "GOAT Bot". */
export const CloudRunLauncherName = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[\p{L}\p{N}][\p{L}\p{N} ._@()-]{0,63}$/u),
);
export type CloudRunLauncherName = typeof CloudRunLauncherName.Type;

/** owner/name; GitHub-style, the form every cloud provider here accepts. */
export const CloudRepository = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/u),
);
export type CloudRepository = typeof CloudRepository.Type;

const CloudBranch = TrimmedNonEmptyString.check(
  Schema.isMaxLength(255),
  Schema.isPattern(/^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/u),
);

export const CloudHolderRuntime = Schema.Literals(["current", "update_required", "unreachable"]);
export type CloudHolderRuntime = typeof CloudHolderRuntime.Type;

export const CloudHolder = Schema.Struct({
  provider: CloudAgentProvider,
  /** Null is the environment that answered; otherwise the SSH host alias. */
  host: Schema.NullOr(SshHostAlias),
  /** The provider instance there whose sign-in launches and observes runs. */
  instanceId: Schema.optional(ProviderInstanceId),
  ready: Schema.Boolean,
  /** A non-secret account name, when the provider shows one. */
  accountLabel: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  /** Why it cannot hold runs, in one sentence. */
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(1000))),
  /** What a person runs on that machine to fix it, such as a sign-in command. */
  command: Schema.optional(Schema.String.check(Schema.isMaxLength(300))),
  /** "update_required": the host can be read but its GOAT cannot take routed launches yet. */
  runtime: CloudHolderRuntime,
  /** Cloud runs this holder is following now; launches go to the least loaded holder. */
  activeRuns: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /** The hub, holding cloud launches by default (`hub.cloudHolder`). Older hosts omit it. */
  hub: Schema.optional(Schema.Boolean),
});
export type CloudHolder = typeof CloudHolder.Type;

export const CloudHoldersInput = Schema.Struct({
  provider: Schema.optional(CloudAgentProvider).annotate({
    description: "Only this provider. Omit for Claude Cloud, Cursor Cloud and Devin Cloud.",
  }),
  local: Schema.optional(Schema.Boolean).annotate({
    description:
      "Only check this environment, without reaching connected SSH hosts. Hosts use this when asked by another machine.",
  }),
  refresh: Schema.optional(Schema.Boolean).annotate({
    description: "Check again now instead of using answers from the last minute.",
  }),
});
export type CloudHoldersInput = typeof CloudHoldersInput.Type;

export const CloudHoldersResult = Schema.Struct({ holders: Schema.Array(CloudHolder) });
export type CloudHoldersResult = typeof CloudHoldersResult.Type;

export const CloudLaunchInput = Schema.Struct({
  provider: CloudAgentProvider,
  repo: CloudRepository.annotate({
    description:
      "owner/name. The holder needs a project whose origin is this repository; the cloud agent works from its pushed branch.",
  }),
  branch: Schema.optional(CloudBranch).annotate({
    description: "Pushed branch to start from. Omit for the project's current branch.",
  }),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(100_000)),
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  holder: Schema.optional(CloudHolderName).annotate({
    description:
      'Run on this holder: "local" or an SSH host alias from goat_cloud_agent_holders. Omit to pick a ready holder.',
  }),
  dryRun: Schema.optional(Schema.Boolean).annotate({
    description: "Only say which holder would launch it. Starts nothing.",
  }),
  notifyWebhook: Schema.optional(Schema.Boolean).annotate({
    description: "Also post run.completed to the completion webhook (completionWebhook.url).",
  }),
  decisionId: Schema.optional(TrimmedNonEmptyString).annotate({
    description:
      "Outside a thread only: with goatclaw on, a refused launch names a decision GOAT filed for exactly this launch; pass its id once a person approved it. Each approval starts one launch. From a thread, use handoffId.",
  }),
  handoffId: Schema.optional(TrimmedNonEmptyString).annotate({
    description:
      "From a thread: with goatclaw on, a launch the person did not start in this turn returns needs_human with a handoff. Once a person approves it, call again with the same arguments and this id. A different launch needs a new approval.",
  }),
});
export type CloudLaunchInput = typeof CloudLaunchInput.Type;

export const CloudRunTracking = Schema.Literals(["live", "polled", "link-only", "pending"]);
export type CloudRunTracking = typeof CloudRunTracking.Type;

export const CloudLaunchResult = Schema.Struct({
  holder: CloudHolder,
  dryRun: Schema.Boolean,
  threadId: Schema.optional(ThreadId),
  tracking: Schema.optional(CloudRunTracking),
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(1000))),
});
export type CloudLaunchResult = typeof CloudLaunchResult.Type;
/** What goat_cloud_launch returns: a launch, or a handoff asking a person to allow it. */
export const CloudLaunchMcpResult = Schema.Union([
  Schema.Struct({
    ...needsHumanFields("approval", "goat_cloud_launch"),
    holder: CloudHolder,
    dryRun: Schema.Literal(false),
    note: Schema.String.check(Schema.isMaxLength(1000)),
  }),
  CloudLaunchResult,
]);
export type CloudLaunchMcpResult = typeof CloudLaunchMcpResult.Type;

export const CloudRunRegisterInput = Schema.Struct({
  provider: CloudAgentProvider,
  externalId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(160))).annotate({
    description:
      "The provider's id: a Cursor agent id (bc-…), a Claude session id (session_…), or a Devin session id.",
  }),
  url: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2048))).annotate({
    description:
      "The run's page: https://cursor.com/agents/<id>, https://claude.ai/code/<session_id>, or https://app.devin.ai/sessions/<id>.",
  }),
  repo: CloudRepository,
  branch: Schema.optional(CloudBranch),
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  launchedBy: CloudRunLauncherName.annotate({
    description: 'Who launched it, shown in Fleet and the thread list: "Grok Bot", "GOAT Bot".',
  }),
  holder: Schema.optional(CloudHolderName).annotate({
    description:
      'Track it on this holder: "local" or an SSH host alias. Omit to use a ready holder.',
  }),
  notifyWebhook: Schema.optional(Schema.Boolean).annotate({
    description: "Post run.completed to the completion webhook when a followed run finishes.",
  }),
});
export type CloudRunRegisterInput = typeof CloudRunRegisterInput.Type;

export const CloudRunRegisterResult = Schema.Struct({
  holder: CloudHolder,
  threadId: ThreadId,
  externalId: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  /** False when this run was already registered; the call then changes nothing. */
  created: Schema.Boolean,
  /**
   * polled/live: GOAT follows the run through the holder's sign-in and reports completion.
   * link-only: GOAT keeps the link only and never reports a result. pending: still attaching.
   */
  tracking: CloudRunTracking,
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(1000))),
});
export type CloudRunRegisterResult = typeof CloudRunRegisterResult.Type;

export const CloudRunSummary = Schema.Struct({
  threadId: ThreadId,
  provider: CloudAgentProvider,
  instanceId: ProviderInstanceId,
  title: Schema.String,
  status: OrchestrationV2CloudTask.fields.status,
  tracking: OrchestrationV2CloudTask.fields.tracking,
  url: Schema.optional(Schema.String),
  prUrl: Schema.optional(Schema.String),
  repository: TrimmedNonEmptyString,
  branch: Schema.optional(Schema.String),
  /** Registered runs: who launched them outside GOAT. Absent for runs GOAT launched. */
  launchedBy: Schema.optional(Schema.String),
  registered: Schema.Boolean,
  updatedAt: Schema.String,
});
export type CloudRunSummary = typeof CloudRunSummary.Type;

export const CloudRunListInput = Schema.Struct({
  provider: Schema.optional(CloudAgentProvider),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
  cursor: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(512)).annotate({
      description: "nextCursor from the previous page, with the same provider.",
    }),
  ),
});
export type CloudRunListInput = typeof CloudRunListInput.Type;

export const CloudRunListResult = Schema.Struct({
  runs: Schema.Array(CloudRunSummary),
  /** More runs match than this page holds. Older servers omit it. */
  truncated: Schema.optionalKey(Schema.Boolean),
  nextCursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
});
export type CloudRunListResult = typeof CloudRunListResult.Type;

export const CloudRunForgetInput = Schema.Struct({
  threadId: ThreadId.annotate({ description: "The registered run's threadId." }),
});
export type CloudRunForgetInput = typeof CloudRunForgetInput.Type;

export const CloudRunForgetResult = Schema.Struct({
  threadId: ThreadId,
  forgotten: Schema.Boolean,
});
export type CloudRunForgetResult = typeof CloudRunForgetResult.Type;

const ORIGINS: Record<
  CloudAgentProvider,
  { readonly hosts: ReadonlyArray<string>; readonly path: RegExp; readonly id: RegExp }
> = {
  cursorCloud: {
    hosts: ["cursor.com", "www.cursor.com"],
    path: /^\/agents\/([^/]+)$/u,
    id: /^bc-[A-Za-z0-9][A-Za-z0-9-]{7,127}$/u,
  },
  claudeCloud: {
    hosts: ["claude.ai"],
    path: /^\/code\/([^/]+)$/u,
    id: /^session_[A-Za-z0-9]{8,128}$/u,
  },
  devinCloud: {
    hosts: ["app.devin.ai"],
    path: /^\/sessions\/([^/]+)$/u,
    id: /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u,
  },
};

/** The page GOAT shows for a run; built from the id, never taken from the caller. */
export function cloudRunUrl(provider: CloudAgentProvider, externalId: string): string {
  switch (provider) {
    case "cursorCloud":
      return `https://cursor.com/agents/${externalId}`;
    case "claudeCloud":
      return `https://claude.ai/code/${externalId}`;
    case "devinCloud":
      return `https://app.devin.ai/sessions/${externalId}`;
  }
}

export type CloudRunReference =
  | { readonly ok: true; readonly externalId: string; readonly url: string }
  | { readonly ok: false; readonly message: string };

/**
 * Checks a registration's id and link against the provider's own format and origin. The link
 * GOAT keeps is rebuilt from the id, so nothing the caller sends is ever fetched, and an id
 * that does not match the provider's format is refused before any holder sees it.
 */
export function parseCloudRunReference(
  provider: CloudAgentProvider,
  input: { readonly externalId?: string | undefined; readonly url?: string | undefined },
): CloudRunReference {
  const origin = ORIGINS[provider];
  let fromUrl: string | undefined;
  if (input.url !== undefined) {
    if (input.url.length > 2048)
      return { ok: false, message: "url is longer than 2048 characters." };
    let parsed: URL;
    try {
      parsed = new URL(input.url);
    } catch {
      return { ok: false, message: "url is not a valid URL." };
    }
    if (parsed.protocol !== "https:") return { ok: false, message: "url must use https." };
    if (parsed.username || parsed.password)
      return { ok: false, message: "url must not carry a user name or password." };
    if (parsed.port) return { ok: false, message: "url must not name a port." };
    if (!origin.hosts.includes(parsed.hostname))
      return { ok: false, message: `url must be on ${origin.hosts.join(" or ")} for ${provider}.` };
    if (parsed.search || parsed.hash)
      return { ok: false, message: "url must not have a query or fragment." };
    fromUrl = origin.path.exec(parsed.pathname)?.[1];
    if (fromUrl === undefined) return { ok: false, message: `url is not a ${provider} run page.` };
  }
  if (input.externalId !== undefined && fromUrl !== undefined && input.externalId !== fromUrl)
    return { ok: false, message: "externalId and url name different runs." };
  const externalId = input.externalId ?? fromUrl;
  if (externalId === undefined) return { ok: false, message: "Pass externalId or url." };
  if (!origin.id.test(externalId))
    return { ok: false, message: `externalId is not a ${provider} id.` };
  return { ok: true, externalId, url: cloudRunUrl(provider, externalId) };
}
