import * as Schema from "effect/Schema";

/**
 * What tools/list shows: "core", the entries whose registry listing is "core", or "full", every
 * tool the caller can use. Either way every tool stays callable by name and through goat_call.
 */
export const AgentToolListing = Schema.Literals(["core", "full"]);
export type AgentToolListing = typeof AgentToolListing.Type;

/**
 * Every harness gets the core listing unless the environment's settings ask for "full", the
 * rollback for a harness that regresses (D21 in docs/internals/agent-surface.md).
 */
export const DEFAULT_AGENT_TOOL_LISTING: AgentToolListing = "core";

/** The _meta key Claude Code reads to load a tool up front instead of deferring it. */
export const ALWAYS_LOAD_META_KEY = "anthropic/alwaysLoad";
