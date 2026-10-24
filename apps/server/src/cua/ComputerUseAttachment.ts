import {
  BuiltInSkillName,
  type CuaDriverMcpConfiguration,
  type ProviderDriverKind,
  type ProviderInteractionMode,
  type ThreadId,
} from "@goat/contracts";
import { resolveBuiltInSkills } from "@goat/provider-core/server/builtinSkills/registry";
import type { McpProviderSessionConfig } from "@goat/provider-core/server/mcpSession";
import { type SelfInvocation, selfInvocationArgs } from "@goat/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";
import type * as CuaDriver from "./CuaDriver.ts";
import type { ComputerUseLease } from "./ComputerUseLeases.ts";
import type { ComputerUseOrigin } from "./ComputerUseOrigin.ts";

/**
 * Providers whose agent process runs on this host and can spawn the driver's
 * stdio MCP server. Cloud providers run elsewhere, and the driver would
 * operate this host's desktop on their behalf; Muse only accepts HTTP session
 * servers. See ADR-0020 for the per-adapter table.
 */
const COMPUTER_USE_PROVIDER_DRIVERS: ReadonlySet<string> = new Set([
  "claudeAgent",
  "codex",
  "cursor",
  "grok",
  "antigravity",
  "acpRegistry",
  "opencode",
  "pi",
]);

export type ComputerUseRefusal =
  | "unsupported-provider"
  | "disabled"
  | "plan"
  | "read-only"
  | "unavailable"
  | "needs-approval";

/**
 * Every provider session's computer use comes from this one decision, so the
 * unattended gate lives here and adapters only carry out what it says.
 */
export type ComputerUseAttachment =
  | {
      readonly _tag: "none";
      readonly reason: ComputerUseRefusal;
      /** An unattended turn without a lease: a `cua-driver` the user configured must not run. */
      readonly blockUserConfig: boolean;
    }
  | {
      readonly _tag: "direct";
      readonly mcp: CuaDriverMcpConfiguration;
      /** The managed server replaces a `cua-driver` the user configured for the provider. */
      readonly overrideUserConfig: boolean;
      readonly skills: ReadonlyArray<BuiltInSkillName>;
    }
  | {
      /** An unattended turn with an approved lease reaches the driver only through GOAT's proxy. */
      readonly _tag: "leased";
      readonly mcp: CuaDriverMcpConfiguration;
      readonly lease: ComputerUseLease;
      readonly proxy: SelfInvocation;
      readonly skills: ReadonlyArray<BuiltInSkillName>;
    };

export interface ComputerUseAttachmentInput {
  readonly threadId: ThreadId;
  readonly driver: ProviderDriverKind | undefined;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly readOnly: boolean;
  readonly origin: ComputerUseOrigin;
  readonly lease: Option.Option<ComputerUseLease>;
  /** How this server runs its own lease proxy subcommand; absent where it cannot. */
  readonly proxy: SelfInvocation | undefined;
}

const none = (reason: ComputerUseRefusal, blockUserConfig = false): ComputerUseAttachment => ({
  _tag: "none",
  reason,
  blockUserConfig,
});

/**
 * Starting the driver is the last step: a thread that cannot use it never
 * starts the daemon.
 */
export const computerUseAttachment = Effect.fn("ComputerUse.attachment")(function* (
  cua: Option.Option<CuaDriver.CuaDriver["Service"]>,
  input: ComputerUseAttachmentInput,
) {
  const unattended = input.origin._tag === "unattended";
  if (input.driver === undefined || !COMPUTER_USE_PROVIDER_DRIVERS.has(input.driver))
    return none("unsupported-provider", unattended);
  if (Option.isNone(cua) || !(yield* cua.value.enabled)) return none("disabled", unattended);
  if (input.interactionMode === "plan") return none("plan", unattended);
  if (input.readOnly) return none("read-only", unattended);
  if (unattended && Option.isNone(input.lease)) return none("needs-approval", true);
  const mcp = yield* cua.value.acquire;
  if (Option.isNone(mcp)) return none("unavailable", unattended);
  // Names this build does not know are ignored; unreadable settings keep the default on.
  const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const disabled = Option.isNone(settings)
    ? []
    : yield* settings.value.getSettings.pipe(
        Effect.map((value) => value.disabledBuiltInSkills.filter(Schema.is(BuiltInSkillName))),
        Effect.orElseSucceed(() => []),
      );
  const { active: skills } = resolveBuiltInSkills({ attached: ["computer"], disabled });
  if (!unattended)
    return { _tag: "direct", mcp: mcp.value, overrideUserConfig: false, skills } as const;
  if (Option.isNone(input.lease) || input.proxy === undefined) return none("unavailable", true);
  return {
    _tag: "leased",
    mcp: mcp.value,
    lease: input.lease.value,
    proxy: input.proxy,
    skills,
  } as const;
});

/** Subcommand of this server that stands between a leased thread and the driver. */
const LEASE_PROXY_COMMAND = "cua-lease-proxy";
export const LEASE_PROXY_ENV = {
  url: "GOAT_CUA_LEASE_URL",
  authorization: "GOAT_CUA_LEASE_AUTHORIZATION",
  driver: "GOAT_CUA_DRIVER_MCP",
} as const;

/**
 * The stdio server a leased thread's provider spawns. It carries the thread's own GOAT MCP
 * credential to read its lease, and the driver descriptor it forwards to. The lease id is in the
 * arguments, so a new lease changes the attachment key and adapters respawn it.
 */
function leaseProxyDescriptor(
  config: Pick<McpProviderSessionConfig, "endpoint" | "authorizationHeader">,
  attachment: Extract<ComputerUseAttachment, { readonly _tag: "leased" }>,
  leaseRoute: string,
): CuaDriverMcpConfiguration {
  return {
    command: attachment.proxy.command,
    args: [
      ...selfInvocationArgs(attachment.proxy, [
        LEASE_PROXY_COMMAND,
        "--handoff",
        attachment.lease.handoffId,
        "--expires",
        DateTime.formatIso(attachment.lease.expiresAt),
      ]),
    ],
    environment: [
      // Desktop servers run as Electron's node; the proxy must too.
      { name: "ELECTRON_RUN_AS_NODE", value: "1" },
      { name: LEASE_PROXY_ENV.url, value: new URL(leaseRoute, config.endpoint).toString() },
      { name: LEASE_PROXY_ENV.authorization, value: config.authorizationHeader },
      { name: LEASE_PROXY_ENV.driver, value: JSON.stringify(attachment.mcp) },
    ],
    ...(attachment.mcp.socketPath === undefined ? {} : { socketPath: attachment.mcp.socketPath }),
  };
}

/** The session config adapters read, carrying exactly this decision's driver. */
export function withComputerUse(
  config: McpProviderSessionConfig,
  attachment: ComputerUseAttachment,
  leaseRoute: string,
): McpProviderSessionConfig {
  const {
    cuaDriver: _previous,
    cuaDriverOverridesUserConfig: _previousOverride,
    cuaDriverBlocked: _previousBlock,
    builtInSkills: _previousSkills,
    ...rest
  } = config;
  switch (attachment._tag) {
    case "none":
      return attachment.blockUserConfig ? { ...rest, cuaDriverBlocked: true } : rest;
    case "direct":
      return {
        ...rest,
        cuaDriver: attachment.mcp,
        builtInSkills: attachment.skills,
        ...(attachment.overrideUserConfig ? { cuaDriverOverridesUserConfig: true } : {}),
      };
    case "leased":
      return {
        ...rest,
        cuaDriver: leaseProxyDescriptor(config, attachment, leaseRoute),
        cuaDriverOverridesUserConfig: true,
        builtInSkills: attachment.skills,
      };
  }
}
