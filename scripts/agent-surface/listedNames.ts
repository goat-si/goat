// Loaded at run time: the scripts project does not compile the contracts package.
const { agentSurfaceRegistry } = (await import(
  new URL("../../packages/contracts/src/agentSurface/registry.ts", import.meta.url).href
)) as {
  readonly agentSurfaceRegistry: Readonly<
    Record<string, { readonly resource: string; readonly verb: string; readonly name: string }>
  >;
};

/** The names /mcp lists since the listing flip; docs and prompts name tools this way. */
export const LISTED_TOOL_NAMES: ReadonlyArray<string> = Object.values(agentSurfaceRegistry).map(
  (entry) => (entry.resource === "surface" ? entry.name : `goat_${entry.resource}_${entry.verb}`),
);
