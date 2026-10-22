import { agentSurfaceRegistry } from "./registry.ts";

type Entry = (typeof agentSurfaceRegistry)[keyof typeof agentSurfaceRegistry];

/**
 * Who asked. Anonymous gets every path; a credential sees what its kind can
 * reach. Permission profiles and capabilities are checked when the tool runs,
 * so a listed path can still be refused.
 */
export type LlmsTxtCaller =
  | { readonly kind: "anonymous" }
  | { readonly kind: "thread" }
  | { readonly kind: "client"; readonly readOnly: boolean };

const REQUIRES_FLAG = { thread: "thread only", client: "client only", either: null } as const;

/** Mirrors McpToolAccess: thread-only tools refuse clients, and read-only clients reach reads only. */
export const usableBy = (entry: Entry, caller: LlmsTxtCaller): boolean => {
  switch (caller.kind) {
    case "anonymous":
      return true;
    case "thread":
      return entry.requires !== "client";
    case "client":
      return entry.requires !== "thread" && (!caller.readOnly || entry.effect === "read");
  }
};

const AUDIENCE = {
  anonymous:
    "Unfiltered: every path in this GOAT version. Request this page with the bearer credential you use for /mcp to list only the paths that credential can reach.",
  thread: "Filtered for this GOAT thread's credential.",
  client: "Filtered for this MCP client credential.",
  readOnlyClient: "Filtered for this read-only MCP client credential: reads only.",
} as const;

// Code-unit comparison, so the order does not depend on the machine's locale.
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const renderLine = (entry: Entry) => {
  const notes = [
    entry.effect,
    entry.name,
    entry.hostRoutable ? "host-routable" : null,
    REQUIRES_FLAG[entry.requires],
  ].filter((note) => note !== null);
  const summary = entry.summary.replace(/\s+/g, " ").trim().replace(/\.$/, "");
  return "- " + entry.path + ": " + summary + " (" + notes.join("; ") + ")";
};

/** The compact agent surface index served at /llms.txt. Same input, same bytes. */
export const renderLlmsTxt = (
  caller: LlmsTxtCaller = { kind: "anonymous" },
  entries: ReadonlyArray<Entry> = Object.values(agentSurfaceRegistry),
): string => {
  const audience =
    caller.kind === "client" && caller.readOnly ? AUDIENCE.readOnlyClient : AUDIENCE[caller.kind];
  const sorted = entries
    .filter((entry) => usableBy(entry, caller))
    .sort((a, b) => compare(a.resource, b.resource) || compare(a.verb, b.verb));
  const lines = [
    "# GOAT agent surface",
    "",
    "> What an agent can do through this GOAT server's MCP endpoint (/mcp), one resource.verb path per line.",
    "",
    audience +
      " Permission profiles and capabilities are checked when a tool runs, so a listed path can still be refused.",
    "",
    "Each line reads `path: summary (effect; MCP tool name; flags)`. The effect is read, write, or destructive. host-routable means the tool takes `host` to act on another connected machine. thread only means the caller must be an agent running in a GOAT thread; client only means an MCP client signed in from outside GOAT.",
  ];
  let resource: string | undefined;
  for (const entry of sorted) {
    if (entry.resource !== resource) {
      resource = entry.resource;
      lines.push("", "## " + resource, "");
    }
    lines.push(renderLine(entry));
  }
  return lines.join("\n") + "\n";
};
