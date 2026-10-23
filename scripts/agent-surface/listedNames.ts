// Loaded at run time: the scripts project does not compile the contracts package.
const { agentSurfaceRegistry } = (await import(
  new URL("../../packages/contracts/src/agentSurface/registry.ts", import.meta.url).href
)) as {
  readonly agentSurfaceRegistry: Readonly<
    Record<string, { readonly resource: string; readonly verb: string; readonly name: string }>
  >;
};

/**
 * Every way text can name a tool mapped to the shipped name the inventory counts it by: its
 * registry path for goat_call, the name /mcp lists since the listing flip, and the shipped name.
 */
export const SHIPPED_TOOL_NAMES: ReadonlyMap<string, string> = new Map(
  Object.entries(agentSurfaceRegistry).flatMap(([path, entry]) => [
    [path, entry.name],
    [
      entry.resource === "surface" ? entry.name : `goat_${entry.resource}_${entry.verb}`,
      entry.name,
    ],
    [entry.name, entry.name],
  ]),
);

/**
 * Snake-case words that may be tool names, known registry paths, and every explicit goat_call
 * path value, known or not, so a mistyped path still reaches the unknown-name check.
 */
export const toolTokensIn = (text: string): ReadonlyArray<string> => [
  ...[...text.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)].map((match) => match[1] ?? ""),
  ...[...text.matchAll(/\b([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)\b/g)]
    .map((match) => match[1] ?? "")
    .filter((path) => SHIPPED_TOOL_NAMES.has(path)),
  ...[...text.matchAll(/\bpath:\s*"([^"]+)"/g)].map((match) => match[1] ?? ""),
];
