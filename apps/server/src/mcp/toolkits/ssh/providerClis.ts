import type { GoatHostStatusResult, HubNode, SshPreflightReport } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as HostStatus from "../../HostStatusMcpService.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";

const UNKNOWN = { complete: false, missing: [] } as const;
/** Drivers whose probe runs their CLI; each answers present, missing, none or unknown. */
const CLI_DRIVERS: ReadonlySet<string> = new Set([
  "codex",
  "claudeAgent",
  "grok",
  "opencode",
  "omo",
  "pi",
]);

/** Which provider CLIs a host reported missing, and whether it had checked every one. */
const providerClisOf = (status: GoatHostStatusResult) => {
  const entry = status.hosts[0];
  // An unreachable read may carry the last good metrics; they say nothing about the host now.
  if (entry?.reachability !== "ok" || entry.lastKnown === true) return UNKNOWN;
  const providers = entry.metrics?.providers?.filter((provider) => provider.enabled);
  if (providers === undefined) return UNKNOWN;
  // Drivers that run no CLI report no cli; an older host reports none at all, so it cannot tell.
  const reported = providers.filter((provider) => provider.cli !== undefined);
  // A driver GOAT checks by its CLI that gave no answer was not checked.
  const unanswered = providers.some(
    (provider) => provider.cli === undefined && CLI_DRIVERS.has(provider.driver),
  );
  return {
    complete:
      reported.length > 0 &&
      !unanswered &&
      reported.every((provider) => provider.cli !== "unknown"),
    missing: providers
      .filter((provider) => provider.cli === "missing")
      .map((provider) => ({
        driver: provider.driver,
        displayName: provider.displayName ?? provider.driver,
      })),
  };
};

/** The alias this server reaches a just-saved device by: its node's SSH route, else what preflight used. */
export const savedAlias = (result: {
  readonly preflight: SshPreflightReport;
  readonly hub: { readonly saved: true; readonly node: HubNode } | { readonly saved: false };
}) => {
  const route = result.hub.saved
    ? result.hub.node.routes.find((candidate) => candidate.target.kind === "ssh")?.target
    : undefined;
  return route?.kind === "ssh"
    ? route.alias
    : (result.preflight.destination.alias ?? result.preflight.host);
};

/** Read once, right after a device is saved; a failed or slow read never changes the add's success. */
export const providerClisFor = Effect.fn("SshDeviceAdd.providerClis")(function* (
  scope: McpInvocationScope,
  host: string,
) {
  const status = yield* Effect.serviceOption(HostStatus.HostStatusMcpService);
  if (Option.isNone(status)) return UNKNOWN;
  return yield* status.value.read(scope, { host }).pipe(
    Effect.map(providerClisOf),
    Effect.orElseSucceed(() => UNKNOWN),
  );
});
