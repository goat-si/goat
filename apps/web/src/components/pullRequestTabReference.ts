import type { ProjectId } from "@goat/contracts";
import type { RightPanelSurface } from "~/rightPanelStore";

export function pullRequestTabReference(
  surface: Extract<RightPanelSurface, { kind: "pull-request" }>,
) {
  return {
    projectId: surface.projectId as ProjectId,
    ...(surface.host === undefined ? {} : { host: surface.host }),
    repository: surface.repository,
    number: surface.number,
  };
}
