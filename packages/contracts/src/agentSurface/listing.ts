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

/**
 * The _meta key on a tools/list result that names the listing agents GOAT runs get. Clients keep
 * the full listing unless they ask for core (D22), so this is how one, such as the D8 runner,
 * learns what agents see.
 */
export const AGENT_TOOL_LISTING_META_KEY = "goat/agentToolListing";

/**
 * The request header an MCP client outside GOAT sends to /mcp, with the value "core", to be listed
 * only the core tools. Without it a client keeps the full listing, which other GOAT hosts read to
 * learn a remote's launch arguments and memory tools (D22).
 */
export const AGENT_TOOL_LISTING_HEADER = "x-goat-tool-listing";
