import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import { isScratchProject } from "@goat/client-runtime/state/projects";
import { AuthOrchestrationOperateScope } from "@goat/contracts";
import * as Haptics from "expo-haptics";

import * as Dialog from "../../components/ui/Dialog";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentProjects, projectEnvironment } from "../../state/projects";
import { environmentServerConfigsAtom } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";

/** A No project thread that already has its own folder, on a server that can promote it. */
export function canTurnThreadIntoProject(thread: EnvironmentThreadShell): boolean {
  if (thread.worktreePath === null) return false;
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(thread.environmentId);
  if (config?.environment.capabilities.threadProjectFromScratch !== true) return false;
  const project = appAtomRegistry.get(
    environmentProjects.projectAtom({
      environmentId: thread.environmentId,
      projectId: thread.projectId,
    }),
  );
  return project != null && isScratchProject(project, config.scratchWorkspaceRoot);
}

export async function turnThreadIntoProject(thread: EnvironmentThreadShell): Promise<void> {
  const title = "Could not turn thread into a project";
  if (!readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)) {
    Dialog.alert(title, "This connection cannot change threads.");
    return;
  }
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  const result = await runAtomCommand(
    appAtomRegistry,
    projectEnvironment.createFromThread,
    { environmentId: thread.environmentId, input: { threadId: thread.id } },
    { reportFailure: false },
  );
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    Dialog.alert(title, error instanceof Error ? error.message : "Try again.");
  }
}
