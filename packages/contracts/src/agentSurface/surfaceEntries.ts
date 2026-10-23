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
      "Find GOAT capabilities and how to call them. query takes words or a tool name: exact names come first, then paths with every word, then paths sharing some, with matchedWords. total, truncated and nextCursor say what else matched; a short or partial result never means nothing else exists. path takes a resource for its paths, or a path or tool name for its schemas and availability for this caller.",
    guide:
      "detail is names (path, name, summary), summary (the default: adds effect, requires, available and description) or full, for one path: input and output schema, guide, legacy names and human steps. limit is 1-50, default 10; pass nextCursor with the same query for the next page. coverage lists the fields and resources searched, the words ignored, and how many matches this server does not serve or this caller cannot use now; those are still returned, with available.now false. A query nothing matches returns the nearest paths. available.now reports only the static refusals the server is sure of; other checks run when the call is made. Call a path with goat_call.",
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
      "Call one GOAT capability by path, canonical name or legacy tool name, with args exactly as that tool takes them; it runs the same checks as a direct call and adds no permission. Returns status ok with value, error with code, reason and retryable, or needs_human with a handoff: a person must finish a step, so do not retry; read the handoff's state.",
    guide:
      "Error codes: invalid_request, unauthenticated, permission_denied, not_found, conflict, unavailable, timeout, expired, cancelled, internal; each carries reason, message and retryable. goat_call cannot call itself or goat_eval. Find paths with goat_describe.",
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
