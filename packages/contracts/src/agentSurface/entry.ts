import type { AgentSurfaceEntry, AgentSurfaceExample, CapabilityDeclaration } from "./types.ts";

/** Derives an entry's path, legacy names and schema references from its metadata. */
export const entry = <const E extends AgentSurfaceEntry & CapabilityDeclaration>(value: E) => ({
  ...value,
  path: `${value.resource}.${value.verb}` as `${E["resource"]}.${E["verb"]}`,
  legacyNames: [value.name],
  // Input resolves through Tool.getJsonSchema (including dynamic tools); outputs
  // reference the named tool's schema slots. No server imports enter contracts.
  schemaRefs: {
    toolkit: value.toolkit as E["toolkit"],
    tool: value.name as E["name"],
    input: "input",
    output: "successSchema",
    failure: "failureSchema",
  } as const,
  examples: [] as ReadonlyArray<AgentSurfaceExample>,
});
