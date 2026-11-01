import { scopeThreadRef } from "@goat/client-runtime/environment";
import type {
  EnvironmentId,
  OrchestrationV2ThreadLauncher,
  OrchestrationV2ThreadShell,
  ScopedThreadRef,
} from "@goat/contracts";

export function isLaunchedFromThread(
  shell: Pick<OrchestrationV2ThreadShell, "launchedBy"> & { environmentId: EnvironmentId },
  launcher: ScopedThreadRef,
): boolean {
  return (
    shell.launchedBy?.kind === "launch" &&
    shell.launchedBy.via !== "delegate_task" &&
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

/**
 * Names the launching thread and, for a launch from another machine, that
 * machine. When the launcher is not loaded here, says how to reach it.
 */
export function describeThreadLauncher(input: {
  readonly kind: OrchestrationV2ThreadLauncher["kind"];
  readonly title: string;
  readonly machine: string | null;
  readonly available: boolean;
}): string {
  const lead = `${threadLauncherLabel(input.kind)} “${input.title}”${input.machine === null ? "" : ` on ${input.machine}`}`;
  if (input.available) return lead;
  return input.machine === null
    ? `${lead}. It is not available in this app.`
    : `${lead}. Connect ${input.machine} to open it.`;
}
