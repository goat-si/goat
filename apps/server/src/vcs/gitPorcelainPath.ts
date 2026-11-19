// Space-separated fields precede the path in each porcelain v2 record type. The path itself
// may contain spaces, so it is everything after them.
const PORCELAIN_V2_FIELDS_BEFORE_PATH: Record<string, number> = {
  "1": 8,
  "2": 9,
  u: 10,
  "?": 1,
  "!": 1,
};

export function parsePorcelainPath(record: string): string | null {
  const fieldsBeforePath = PORCELAIN_V2_FIELDS_BEFORE_PATH[record[0] ?? ""];
  if (fieldsBeforePath === undefined) return null;
  const filePath = record.split(" ").slice(fieldsBeforePath).join(" ");
  return filePath.length > 0 ? filePath : null;
}
