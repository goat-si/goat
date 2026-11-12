import { ProviderHostSyncDriver } from "@goat/contracts";
import { goatCallText } from "@goat/contracts/agentSurface/callText";
import { listedToolName, resolveAgentSurfaceEntry } from "@goat/contracts/agentSurface/resolve";
import { compareSemverVersions, parseSemver } from "@goat/shared/semver";
import * as Schema from "effect/Schema";

import { undeclaredLaunchArguments } from "./dispatchFailure.ts";
import { quoteRemote } from "./remoteText.ts";

/**
 * The last version some of whose builds answer only to shipped tool names: canonical names became
 * callable (#906) and then listed (#781) within it. Every later version answers to both.
 */
const SHIPPED_NAMES_ONLY_THROUGH = "0.1.2";

/** Whether a remote at this serverVersion answers to canonical tool names. */
const answersToCanonicalNames = (serverVersion: string | undefined) =>
  serverVersion !== undefined &&
  parseSemver(serverVersion) !== null &&
  compareSemverVersions(serverVersion, SHIPPED_NAMES_ONLY_THROUGH) > 0;

/**
 * The name to send a tool call under to a remote GOAT: the listed canonical name when the remote
 * answers to it, else the name the tool shipped under, which every version since accepts. A
 * version this machine cannot read counts as old. Names outside the registry pass unchanged.
 */
export const remoteToolName = (tool: string, serverVersion: string | undefined): string => {
  const entry = resolveAgentSurfaceEntry(tool);
  if (entry === undefined) return tool;
  return answersToCanonicalNames(serverVersion) ? listedToolName(entry) : entry.name;
};

/**
 * Whether a remote's tools/list offers any memory tool. A remote that predates the listing flip
 * lists memory tools under their shipped names and a newer one under goat_memory_*, so both count.
 */
export const advertisesMemoryTools = (tools: ReadonlyArray<{ readonly name: string }>) =>
  tools.some((tool) => resolveAgentSurfaceEntry(tool.name)?.resource === "memory");

/** Refusals a destination's goat_thread_launch returns before it creates anything. */
const REFUSED_BEFORE_CREATE = new Set([
  "invalid_request",
  "capability_denied",
  "runtime_mode_escalation_denied",
  "interaction_mode_escalation_denied",
  "target_required",
]);

/**
 * What a tool's refusal tells the caller. A goat_thread_launch error may come after the thread
 * was created (its projection reads and bookkeeping run after the create commits), so only a
 * refusal it raises before creating anything says the launch never started.
 */
export const toolRefusal = (
  tool: string,
  result: {
    readonly code?: string | undefined;
    readonly classification?: string | undefined;
    readonly mayHaveStarted?: boolean | undefined;
    readonly threadId?: string | undefined;
    readonly driver?: string | undefined;
    readonly message?: string | undefined;
  },
) => {
  // The destination refused before creating anything because the provider's CLI is missing there.
  if (tool === "goat_thread_launch" && result.classification === CLI_MISSING)
    return {
      ...(result.code === undefined ? {} : { remoteCode: result.code }),
      remoteClassification: CLI_MISSING,
      // A destination that says it may have started is believed over its classification.
      ...(result.mayHaveStarted === true ? { launchMayHaveStarted: true } : {}),
      ...(syncDriver(result.driver) === undefined ? {} : { remoteDriver: result.driver }),
    };
  // A placement answer says itself whether the work may have started; absent, it may have.
  if (tool === "goat_thread_launch" && result.classification?.startsWith("placement_") === true)
    return {
      ...(result.code === undefined ? {} : { remoteCode: result.code }),
      remoteClassification: result.classification,
      ...(result.threadId === undefined ? {} : { remoteThreadId: result.threadId }),
      launchMayHaveStarted: result.mayHaveStarted !== false,
    };
  // A tool result's message carries this machine's "The remote ... refused: " prefix.
  const undeclared = undeclaredLaunchArguments(tool, {
    ...result,
    message: result.message?.replace(/^The remote goat_thread_launch refused: /u, ""),
  });
  if (undeclared !== undefined) return { remoteCode: result.code, undeclaredArguments: undeclared };
  return {
    ...(result.code === undefined ? {} : { remoteCode: result.code }),
    // A destination that says it may have started is believed over any refusal code.
    ...(tool === "goat_thread_launch" &&
    (result.mayHaveStarted === true ||
      result.code === undefined ||
      !REFUSED_BEFORE_CREATE.has(result.code))
      ? { launchMayHaveStarted: true }
      : {}),
  };
};

const CLI_MISSING = "provider_cli_missing";
const isSyncDriver = Schema.is(ProviderHostSyncDriver);
/** The remote names the driver; only one GOAT can sync becomes advice or a fact here. */
const syncDriver = (driver: string | undefined) =>
  driver !== undefined && isSyncDriver(driver) ? driver : undefined;

/**
 * A remote refusal as this machine reports it. A missing CLI quotes the destination's own words
 * under the alias this machine reached it by and, when provider.sync is the fix, adds the call
 * that installs it from here, built only from a known driver and the alias.
 */
export const refusalMessage = (
  tool: string,
  alias: string,
  result: {
    readonly message: string;
    readonly classification?: string | undefined;
    readonly driver?: string | undefined;
  },
) => {
  if (tool !== "goat_thread_launch" || result.classification !== CLI_MISSING) return result.message;
  const own = result.message.replace(/^The remote \S+ refused: /u, "");
  const driver = syncDriver(result.driver);
  const sync =
    driver === undefined
      ? ""
      : ` From here: ${goatCallText("provider.sync", JSON.stringify({ driver, hosts: [alias], login: false }))}.`;
  return quoteRemote(`On ${alias}, GOAT there says: `, own, 1_400) + sync;
};

/** The message and facts of a remote refusal, as failure(reason, message, facts) takes them. */
export const refusedBy = (
  tool: string,
  alias: string,
  result: Parameters<typeof refusalMessage>[2] & Parameters<typeof toolRefusal>[1],
) => [refusalMessage(tool, alias, result), toolRefusal(tool, result)] as const;
