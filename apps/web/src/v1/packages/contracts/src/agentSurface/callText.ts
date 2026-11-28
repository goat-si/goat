import type { AgentSurfacePath } from "./registry.ts";

/**
 * How text names a GOAT capability an agent should run. goat_call stays listed under every
 * listing, while a harness binds a tool's own name only when tools/list shows it.
 * `args` is the argument object as the agent should write it, such as `{threadId:"t1"}`.
 */
export const goatCallText = (path: AgentSurfacePath, args?: string): string =>
  args === undefined ? `goat_call {path:"${path}"}` : `goat_call {path:"${path}", args:${args}}`;
