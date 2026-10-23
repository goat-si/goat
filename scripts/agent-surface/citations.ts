import { type SourceRef, findLine } from "./inventory.ts";
import { code } from "./markdown.ts";

// The audit cites a file, plus the symbol that names the evidence when one does. Line numbers
// would move with every unrelated edit and make open pull requests conflict in the page (#1017).
export const ref = (source: SourceRef | null) => (source ? source.path : "(not found)");

export const at = (file: string, pattern: RegExp, symbol?: string) =>
  findLine(file, pattern) === null ? "(not found)" : file + (symbol ? " " + code(symbol) : "");

/** The distinct files a list of references points into, in first-seen order. */
export const files = (refs: ReadonlyArray<SourceRef>) => [
  ...new Set(refs.map((source) => source.path)),
];
