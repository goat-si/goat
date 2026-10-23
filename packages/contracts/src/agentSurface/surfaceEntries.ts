import type { AgentSurfaceEntry, CapabilityDeclaration } from "./types.ts";

type Named = Pick<AgentSurfaceEntry, "resource" | "verb" | "name">;

/** The name a path projects to: goat_<resource>_<verb>. */
export const canonicalToolName = (entry: Pick<AgentSurfaceEntry, "resource" | "verb">) =>
  `goat_${entry.resource}_${entry.verb}`;

/** The name /mcp lists a tool under. The meta tools keep their short names. */
export const listedToolName = (entry: Named) =>
  entry.resource === "surface" ? entry.name : canonicalToolName(entry);

/**
 * Names a tool shipped under that /mcp still accepts in tools/call without listing them. The
 * toolkit keeps registering the tool under its shipped name, so handlers and access
 * declarations keep their keys; only the listing and the call route change.
 */
export const legacyToolNames = (entry: Named): ReadonlyArray<string> =>
  listedToolName(entry) === entry.name ? [] : [entry.name];

/** The meta tools that reach every other path, kept beside the registry like notes.ts. */
export const metaSurfaceEntries = {
  describe: {
    resource: "surface",
    verb: "describe",
    name: "goat_describe",
    toolkit: "agentSurface",
    summary: "Find GOAT capabilities and whether this caller can use them",
    description:
      'Describe GOAT\'s agent surface. Without path: every resource and its verbs. With a resource such as "thread": its paths, one-line summaries and effects. With a full path such as "thread.send" (or a tool name): input and output JSON Schema, effect, human steps, legacy names, and available.now for this caller, with the reason when a static check already refuses it. With query: up to 20 paths whose path, summary or description contain every word, best first, and truncated when more match; a resource as path narrows the search. Other checks still run when the call is made. Call a path with goat_call.',
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { idempotentHint: true, openWorldHint: false },
  },
  call: {
    resource: "surface",
    verb: "call",
    name: "goat_call",
    toolkit: "agentSurface",
    summary: "Call any GOAT capability by path and get one result shape",
    description:
      'Call one GOAT capability by path ("thread.send"), canonical name ("goat_thread_send") or legacy tool name, with args exactly as that tool takes them. It runs the same checks as calling the tool directly and adds no permission. Returns status ok with value, error with code (invalid_request, unauthenticated, permission_denied, not_found, conflict, unavailable, timeout, expired, cancelled, internal), reason, message and retryable, or needs_human with a handoff: a person must finish a step, so do not retry; read the handoff\'s state instead. Find paths with goat_describe.',
    // Destructive so clients that prompt for destructive tools still prompt here; each call keeps its target's checks.
    effect: "destructive",
    capability: "none",
    capabilityReason: "Runs other tools, and each one checks its own capability for this caller.",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { idempotentHint: false, openWorldHint: false },
  },
} as const satisfies Record<string, AgentSurfaceEntry & CapabilityDeclaration>;
