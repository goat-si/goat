import { getCloneDestinationForPickedFolder } from "@goat/client-runtime/operations/projects";
import type { EnvironmentId } from "@goat/contracts";
import type { AddProjectCloneFlow } from "./CommandPalette.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";

export async function clonePickedFolder(input: {
  flow: AddProjectCloneFlow | null;
  path: string;
  environmentId?: EnvironmentId;
  name: string;
  caseSensitive: boolean;
  submit: (path?: string) => Promise<void>;
}) {
  if (input.flow?.step !== "confirm") return false;
  if (input.environmentId !== undefined && input.environmentId !== input.flow.environmentId) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Clone failed",
        description: "Choose a folder in the environment the repository is cloned into.",
      }),
    );
    return true;
  }
  await input.submit(
    getCloneDestinationForPickedFolder({
      pickedPath: input.path,
      cloneDirectoryName: input.name,
      caseSensitive: input.caseSensitive,
    }),
  );
  return true;
}
