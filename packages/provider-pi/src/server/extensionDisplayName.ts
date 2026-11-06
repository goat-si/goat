export function piExtensionDisplayName(extensionPath: string | undefined): string {
  if (extensionPath === undefined) return "Pi extension";
  const segments = extensionPath.replace(/\\/g, "/").split("/").filter(Boolean);
  const fileName = segments.at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  // Pi loads a directory extension from its index file; the folder names it.
  const name = fileName === "index" ? (segments.at(-2) ?? fileName) : fileName;
  return name.length === 0 ? "Pi extension" : name;
}
