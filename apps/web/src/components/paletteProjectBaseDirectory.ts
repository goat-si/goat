import type { EnvironmentId } from "@goat/contracts";
import type { EnvironmentPresentation } from "../state/environments";
import { ensureBrowseDirectoryPath } from "../lib/projectPaths";

export function makeAddProjectInitialQuery(environments: ReadonlyArray<EnvironmentPresentation>) {
  return (environmentId: EnvironmentId | null): string => {
    const environment = environments.find((candidate) => candidate.environmentId === environmentId);
    const environmentSettings = environment?.serverConfig?.settings ?? null;
    const baseDirectory = environmentSettings?.addProjectBaseDirectory?.trim() ?? "";
    if (baseDirectory.length === 0) {
      return "~/";
    }
    return ensureBrowseDirectoryPath(baseDirectory);
  };
}
