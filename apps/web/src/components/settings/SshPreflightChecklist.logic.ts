import type { DesktopSshEnvironmentTarget, SshPreflightReport } from "@goat/contracts";
import { type ConnectionCatalogEntry, connectionRoutes } from "@goat/client-runtime/connection";
import { parseSshDestination } from "@goat/shared/sshDestination";
import * as Option from "effect/Option";

export function parseDesktopSshTarget(input: {
  readonly host: string;
  readonly username: string;
  readonly port: string;
}): DesktopSshEnvironmentTarget {
  const parsed = parseSshDestination({ host: input.host, user: input.username, port: input.port });
  if (!parsed.ok) throw new Error(parsed.message);
  const { hostname, user, port } = parsed.destination;
  return { alias: hostname, hostname, username: user, port };
}

export function sshPreflightFlow(report: SshPreflightReport | null) {
  if (report === null) return "check";
  if (report.steps.some((step) => step.state === "failed")) return "blocked";
  if (report.steps.some((step) => step.id === "host_key" && step.state === "needs_review"))
    return "review";
  return report.ready ? "connect" : "blocked";
}

export function sshPreflightAction(input: {
  readonly report: SshPreflightReport | null;
  readonly checking: boolean;
  readonly busy: boolean;
  readonly reviewing: boolean;
  readonly allowed: boolean;
  readonly hasHost: boolean;
}) {
  const flow = sshPreflightFlow(input.report);
  return {
    label: input.checking
      ? "Checking…"
      : input.busy
        ? input.reviewing
          ? "Reviewing…"
          : "Connecting…"
        : flow === "check"
          ? "Check"
          : "Connect",
    disabled:
      !input.allowed ||
      !input.hasHost ||
      input.busy ||
      input.checking ||
      input.reviewing ||
      flow === "review" ||
      flow === "blocked",
  };
}

/**
 * The managed alias a failed or abandoned check left pinned, when no saved connection uses it.
 * Every route counts: one machine can be saved under several SSH aliases.
 */
export function unsavedManagedSshAlias(
  report: SshPreflightReport | null,
  savedEntries: ReadonlyArray<ConnectionCatalogEntry>,
) {
  const destination = report?.destination;
  if (destination?.managed !== true || destination.alias === undefined) return null;
  const alias = destination.alias;
  const saved = savedEntries.some((entry) =>
    connectionRoutes(entry).some(
      (route) =>
        Option.isSome(route.profile) &&
        route.profile.value._tag === "SshConnectionProfile" &&
        route.profile.value.target.alias === alias,
    ),
  );
  return saved ? null : alias;
}
