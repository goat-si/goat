/**
 * Plain-text goat describe output. The value is goat_describe's result as the server sent it,
 * read defensively: --json prints it unchanged for anything that needs the exact shape.
 */

type Row = {
  readonly path?: unknown;
  readonly effect?: unknown;
  readonly summary?: unknown;
  readonly available?: { readonly now?: unknown; readonly reason?: unknown };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const rows = (value: unknown): ReadonlyArray<Row> =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const availability = (row: Row) =>
  row.available?.now === false
    ? `  (not now: ${typeof row.available.reason === "string" ? row.available.reason : "refused"})`
    : "";

const table = (entries: ReadonlyArray<Row>) => {
  const width = Math.max(0, ...entries.map((row) => String(row.path).length));
  return entries.map(
    (row) =>
      `  ${String(row.path).padEnd(width)}  ${String(row.effect).padEnd(11)}  ${String(row.summary)}${availability(row)}`,
  );
};

export const formatDescribe = (value: unknown): string => {
  if (!isRecord(value)) return JSON.stringify(value, null, 2);
  if (value.depth === "surface")
    return [
      `GOAT agent surface ${String(value.surfaceVersion)}`,
      "",
      ...(Array.isArray(value.resources) ? value.resources.filter(isRecord) : []).map(
        (resource) =>
          `  ${String(resource.resource)}: ${Array.isArray(resource.verbs) ? resource.verbs.join(", ") : ""}`,
      ),
      "",
      "goat describe <resource> lists its paths; goat describe <path> shows one.",
    ].join("\n");
  if (value.depth === "resource")
    return [`${String(value.resource)}:`, ...table(rows(value.entries))].join("\n");
  if (value.depth === "search")
    return [
      `Paths matching "${String(value.query)}":`,
      ...table(rows(value.entries)),
      ...(value.truncated === true ? ["  More paths match; narrow the query."] : []),
    ].join("\n");
  if (value.depth === "path" && isRecord(value.entry)) {
    const entry = value.entry;
    return [
      `${String(entry.path)} (${String(entry.name)}), ${String(entry.effect)}${availability(entry as Row) || "  (available)"}`,
      String(entry.summary),
      "",
      String(entry.description),
      "",
      "Input schema:",
      JSON.stringify(entry.inputSchema, null, 2),
    ].join("\n");
  }
  return JSON.stringify(value, null, 2);
};
