import {
  BuiltInSkillName,
  COMPUTER_USE_PROVIDER_DRIVERS,
  type CuaAgentBlock,
  type CuaDriverMcpConfiguration,
  type ProviderDriverKind,
  type ProviderInteractionMode,
  type RunId,
  type RuntimeMode,
  type ThreadId,
  type TurnCapability,
} from "@goat/contracts";
import { resolveBuiltInSkills } from "@goat/provider-core/server/builtinSkills/registry";
import type { McpProviderSessionConfig } from "@goat/provider-core/server/mcpSession";
import { type SelfInvocation, selfInvocationArgs } from "@goat/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";
import * as CuaDriver from "./CuaDriver.ts";
import { everyAppKind } from "./ComputerUseFullAccess.ts";
import type * as ComputerUseLeases from "./ComputerUseLeases.ts";
import type { ComputerUseOrigin } from "./ComputerUseOrigin.ts";

export type ComputerUseRefusal =
  | "unsupported-provider"
  | "disabled"
  | "plan"
  | "read-only"
  | "unavailable"
  /** The desktop would not start the driver: macOS has not granted what it needs (#1399). */
  | "not-granted"
  | "needs-approval"
  /** Another thread holds the screen for unattended work; one does at a time. */
  | "held"
  /** Unattended work needs a helper that reports secret fields (#1235). */
  | "detection-unsupported";

/**
 * Every provider session's computer use comes from this one decision, so the
 * unattended gate lives here and adapters only carry out what it says.
 * Interactive and unattended turns alike reach the driver only through GOAT's proxy,
 * so Stop, the kill switch, a person's takeover and app approvals hold for both.
 */
export type ComputerUseAttachment =
  | {
      readonly _tag: "none";
      readonly reason: ComputerUseRefusal;
      /** Which grants, for "not-granted"; every surface that explains the refusal reads it. */
      readonly block?: CuaAgentBlock;
      /** An unattended turn without a lease: a `cua-driver` the user configured must not run. */
      readonly blockUserConfig: boolean;
    }
  | {
      readonly _tag: "proxied";
      readonly mcp: CuaDriverMcpConfiguration;
      readonly control: ComputerUseLeases.ComputerUseControl;
      readonly proxy: SelfInvocation;
      /** The managed server replaces a `cua-driver` the user configured for the provider. */
      readonly overrideUserConfig: boolean;
      readonly skills: ReadonlyArray<BuiltInSkillName>;
      /** The X display the driver was started on; the proxy checks its windows against it. */
      readonly x11Display?: CuaDriver.CuaX11Display;
    };

export interface ComputerUseAttachmentInput {
  readonly threadId: ThreadId;
  readonly driver: ProviderDriverKind | undefined;
  readonly interactionMode: ProviderInteractionMode | undefined;
  /** The thread's mode; full access skips grants for a person's runs, and when the host allows it. */
  readonly runtimeMode?: RuntimeMode | undefined;
  /** The run this session is prepared for; absent outside a turn. */
  readonly runId?: RunId | undefined;
  /** A person caused that run (ComputerUseOrigin.personStarted). */
  readonly personStarted?: boolean | undefined;
  readonly readOnly: boolean;
  readonly origin: ComputerUseOrigin;
  /** Absent only in test assemblies, where no turn gets computer use. */
  readonly leases: Option.Option<ComputerUseLeases.ComputerUseLeases["Service"]>;
  /** Capabilities this turn asked for with a chip; they load their skill even when it is off (D13). */
  readonly requested?: ReadonlyArray<TurnCapability> | undefined;
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
  // Unreadable settings keep every default: the built-in skills on and grants required.
  const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const current = Option.isNone(settings)
    ? undefined
    : yield* settings.value.getSettings.pipe(Effect.orElseSucceed(() => undefined));
  const kind = everyAppKind({
    runtimeMode: input.runtimeMode,
    unattended,
    personStarted: input.personStarted === true && input.runId !== undefined,
    setting: current?.cuaFullAccessAutoAdmit === true,
  });
  const everyApp = kind !== undefined;
  const leases = input.leases;
  const lease =
    unattended && !everyApp && Option.isSome(leases)
      ? yield* leases.value.active(input.threadId).pipe(Effect.orElseSucceed(() => Option.none()))
      : Option.none<ComputerUseLeases.ComputerUseLease>();
  if (unattended && !everyApp && Option.isNone(lease)) return none("needs-approval", true);
  if (unattended && everyApp && Option.isSome(leases)) {
    const held = yield* leases.value
      .holder(input.threadId, undefined)
      .pipe(Effect.orElseSucceed(() => Option.some(undefined)));
    if (Option.isSome(held)) return none("held", true);
  }
  if (unattended && Option.isSome(leases)) {
    const detection = yield* leases.value.detection;
    // Admitted work continues while a person uses the machine; secret-field detection still
    // protects unattended turns. Supported human-input signals never become an admission gate.
    if (!detection.privateMode) return none("detection-unsupported", true);
  }
  // Without its proxy nothing could stop the driver, so there is no computer use at all.
  if (Option.isNone(leases) || leases.value.proxy === undefined)
    return none("unavailable", unattended);
  const mcp = yield* cua.value.acquire;
  if (Option.isNone(mcp)) {
    const block = CuaDriver.agentBlock(yield* cua.value.lastFailure);
    // The trace says why a turn ran without computer use, not only that it did.
    yield* Effect.annotateCurrentSpan({
      "computerUse.refusal":
        block === undefined
          ? "unavailable"
          : block.reason === "permissionsNotGranted"
            ? "not-granted"
            : "desktop-unavailable",
      ...(block?.reason === "permissionsNotGranted"
        ? { "computerUse.missing": block.missing.join(",") }
        : block?.reason === "desktopUnavailable"
          ? { "computerUse.blocker": block.blocker ?? "helper" }
          : {}),
    });
    if (block === undefined) return none("unavailable", unattended);
    // The session list shows the turn as waiting for the grant while it runs.
    yield* leases.value.blocked(input.threadId, block);
    return { ...none("not-granted", unattended), block };
  }
  if (unattended) {
    // Acquisition may have started another helper build than the one readiness described (an
    // update between a check and this turn); the desktop reports the started one's signals before
    // it reports the driver ready, so this reads the helper the agent will actually get (#1553).
    const detection = yield* leases.value.detection;
    if (!detection.privateMode) return none("detection-unsupported", true);
  }
  const x11Display =
    cua.value.x11Display === undefined ? Option.none() : yield* cua.value.x11Display;
  // Names this build does not know are ignored.
  const disabled = current?.disabledBuiltInSkills.filter(Schema.is(BuiltInSkillName)) ?? [];
  // Claimed only now, so a turn that cannot get the driver holds nothing; the claim itself
  // refuses unattended work that lost a race for the screen.
  const control = everyApp
    ? yield* leases.value
        .everyAppControl(input.threadId, unattended, {
          person: kind === "person",
          ...(input.runId === undefined ? {} : { runId: input.runId }),
        })
        .pipe(Effect.orElseSucceed(() => Option.none()))
    : Option.some(yield* leases.value.control(input.threadId, lease, input.runId));
  if (Option.isNone(control)) return none("held", unattended);
  // Sessions are also prepared outside a turn: a re-attach, a rollback, a memory policy
  // rotation. With no run open, no turn end will settle the control this minted or reused,
  // and the session list would show an agent acting until it expires (#1551). A turn's own
  // run is already open here, so its control stays acting.
  yield* leases.value.turnEnded(input.threadId).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("computer use control left acting until a turn ends", {
        threadId: input.threadId,
        cause,
      }),
    ),
  );
  return {
    _tag: "proxied",
    mcp: mcp.value,
    ...(Option.isSome(x11Display) ? { x11Display: x11Display.value } : {}),
    control: control.value,
    proxy: leases.value.proxy,
    // A user's own cua-driver would skip Stop, pauses and app approvals, so it never runs here.
    overrideUserConfig: true,
    skills: resolveBuiltInSkills({
      attached: ["computer-use"],
      ...(input.requested === undefined ? {} : { requested: input.requested }),
      disabled,
    }).active,
  } as const;
});

/** Subcommand of this server that stands between a thread and the driver. */
const LEASE_PROXY_COMMAND = "cua-lease-proxy";
export const LEASE_PROXY_ENV = {
  url: "GOAT_CUA_LEASE_URL",
  authorization: "GOAT_CUA_LEASE_AUTHORIZATION",
  driver: "GOAT_CUA_DRIVER_MCP",
  x11Display: "GOAT_CUA_X11_DISPLAY",
} as const;

/**
 * The stdio server a thread's provider spawns. It carries the thread's own GOAT MCP credential
 * to read its control, and the driver descriptor it forwards to. The control id is in the
 * arguments, so a new control changes the attachment key and adapters respawn it.
 */
function leaseProxyDescriptor(
  config: Pick<McpProviderSessionConfig, "endpoint" | "authorizationHeader">,
  attachment: Extract<ComputerUseAttachment, { readonly _tag: "proxied" }>,
  leaseRoute: string,
): CuaDriverMcpConfiguration {
  return {
    command: attachment.proxy.command,
    args: [
      ...selfInvocationArgs(attachment.proxy, [
        LEASE_PROXY_COMMAND,
        "--control",
        attachment.control.controlId,
        "--expires",
        DateTime.formatIso(attachment.control.expiresAt),
      ]),
    ],
    environment: [
      // Desktop servers run as Electron's node; the proxy must too.
      { name: "ELECTRON_RUN_AS_NODE", value: "1" },
      { name: LEASE_PROXY_ENV.url, value: new URL(leaseRoute, config.endpoint).toString() },
      { name: LEASE_PROXY_ENV.authorization, value: config.authorizationHeader },
      { name: LEASE_PROXY_ENV.driver, value: JSON.stringify(attachment.mcp) },
      ...(attachment.x11Display === undefined
        ? []
        : [{ name: LEASE_PROXY_ENV.x11Display, value: JSON.stringify(attachment.x11Display) }]),
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
    case "proxied":
      return {
        ...rest,
        cuaDriver: leaseProxyDescriptor(config, attachment, leaseRoute),
        ...(attachment.overrideUserConfig ? { cuaDriverOverridesUserConfig: true } : {}),
        builtInSkills: attachment.skills,
      };
  }
}
