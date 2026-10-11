import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  OrchestrationV2ThreadLauncher,
  OrchestrationV2ThreadShell,
  ScopedThreadRef,
} from "@t3tools/contracts";

export function isLaunchedFromThread(
  shell: Pick<OrchestrationV2ThreadShell, "launchedBy"> & { environmentId: EnvironmentId },
  launcher: ScopedThreadRef,
): boolean {
  return (
    shell.launchedBy?.kind === "launch" &&
    shell.launchedBy.threadId === launcher.threadId &&
    (shell.launchedBy.environmentId ?? shell.environmentId) === launcher.environmentId
  );
}

export function resolveLauncherRef(
  launchedBy: OrchestrationV2ThreadLauncher,
  ownEnvironmentId: EnvironmentId,
): ScopedThreadRef {
  return scopeThreadRef(launchedBy.environmentId ?? ownEnvironmentId, launchedBy.threadId);
}

export function threadLauncherLabel(kind: OrchestrationV2ThreadLauncher["kind"]) {
  return kind === "launch" ? "Launched by" : "Promoted from";
}
