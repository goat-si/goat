import type { PreviewSessionSnapshot, ProjectScript } from "@goat/contracts";

export function previewNavigationStatus(
  snapshot: PreviewSessionSnapshot | null,
  native: PreviewSessionSnapshot["navStatus"] | undefined,
): PreviewSessionSnapshot["navStatus"] {
  // The server can already be loading the first URL while the native guest is idle.
  if (snapshot && native && native._tag !== "Idle") return native;
  return snapshot?.navStatus ?? { _tag: "Idle" };
}

export function getConfiguredPreviewUrls(
  scripts: ReadonlyArray<ProjectScript> | undefined,
): ReadonlyArray<string> {
  return scripts?.flatMap((script) => (script.previewUrl ? [script.previewUrl] : [])) ?? [];
}
