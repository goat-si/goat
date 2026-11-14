import type { EnvironmentId, ProjectScript } from "@goat/contracts";
import { isPreviewAvailableFor } from "../../browser/previewRuntime";

export function shouldAutoOpenProjectPreview(
  script: Pick<ProjectScript, "autoOpenPreview" | "previewUrl">,
  environmentId: EnvironmentId,
): script is Pick<ProjectScript, "autoOpenPreview" | "previewUrl"> & { previewUrl: string } {
  return Boolean(
    script.autoOpenPreview && script.previewUrl && isPreviewAvailableFor(environmentId),
  );
}
