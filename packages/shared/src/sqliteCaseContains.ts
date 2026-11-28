// The inline version runs in SQLite worker threads, where module files may not exist.
export const sqliteCaseContains = (value: unknown, needle: unknown) =>
  typeof value === "string" &&
  typeof needle === "string" &&
  value.toLocaleLowerCase().includes(needle.toLocaleLowerCase())
    ? 1
    : 0;

export const sqliteCaseContainsSource = `
const sqliteCaseContains = (value, needle) =>
  typeof value === "string" && typeof needle === "string" &&
  value.toLocaleLowerCase().includes(needle.toLocaleLowerCase()) ? 1 : 0;
`;
