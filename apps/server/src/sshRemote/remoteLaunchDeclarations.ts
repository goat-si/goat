import type { OrchestrationV2ThreadLauncher } from "@goat/contracts";

import type { AcpMcpListedTool } from "../mcp/AcpMcpStdioBridge.ts";

/**
 * The arguments a remote goat_thread_launch declares. A nested field is declared as
 * "argument.field", since a remote that decodes an object drops the fields it does not know.
 */
export const declaredLaunchArguments = (tools: ReadonlyArray<AcpMcpListedTool>) => {
  const launch = tools.find((tool) => tool.name === "goat_thread_launch");
  return new Set([
    ...(launch?.argumentNames ?? []),
    ...Object.entries(launch?.nestedArgumentNames ?? {}).flatMap(([argument, fields]) =>
      fields.map((field) => argument + "." + field),
    ),
  ]);
};

/**
 * The launcher as the remote may record it. GOAT Bot's work kind goes only to a remote whose
 * launcher declares it; an older one keeps the thread in its lists, which is the safe side.
 */
export const launcherForRemote = (
  launcher: OrchestrationV2ThreadLauncher | undefined,
  declared: ReadonlySet<string> | undefined,
): Partial<OrchestrationV2ThreadLauncher> => {
  if (launcher === undefined) return {};
  if (launcher.workKind === undefined || declared?.has("launchedBy.workKind") === true)
    return launcher;
  const { workKind: _workKind, ...withoutWorkKind } = launcher;
  return withoutWorkKind;
};
