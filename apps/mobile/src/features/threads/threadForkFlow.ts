import {
  CommandId,
  OrchestrationV2ThreadForkError,
  ThreadId,
  type EnvironmentId,
  type OrchestrationV2ThreadForkInput,
  type OrchestrationV2ThreadForkResult,
  type OrchestrationV2ThreadForkWorkspace,
  type RunId,
} from "@goat/contracts";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@goat/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";

export interface ThreadForkRequest {
  readonly environmentId: EnvironmentId;
  readonly sourceThreadId: ThreadId;
  readonly sourceTitle: string;
  readonly workspace: OrchestrationV2ThreadForkWorkspace;
  /** Fork from this response's run; the latest finished turn when absent. */
  readonly runId?: RunId;
  /** The environment advertises threadForkWorkspace. */
  readonly serverForks: boolean;
}

export interface ThreadForkFlowDeps {
  readonly execute: (value: {
    readonly environmentId: EnvironmentId;
    readonly input: OrchestrationV2ThreadForkInput & { readonly serverForks: boolean };
  }) => Promise<AtomCommandResult<OrchestrationV2ThreadForkResult, unknown>>;
  readonly newId: () => string;
  readonly confirmWithoutUncommitted: (message: string) => Promise<boolean>;
  readonly openThread: (environmentId: EnvironmentId, threadId: ThreadId) => Promise<void>;
  readonly showError: (message: string) => void;
}

// One fork per source thread at a time, whichever entry point started it.
const inFlight = new Set<string>();

export async function runThreadFork(
  request: ThreadForkRequest,
  deps: ThreadForkFlowDeps,
): Promise<"done" | "busy"> {
  const key = `${request.environmentId}:${request.sourceThreadId}`;
  if (inFlight.has(key)) return "busy";
  inFlight.add(key);
  try {
    // Each attempt is a new request: a refused fork created nothing to replay.
    const attempt = (workspace: OrchestrationV2ThreadForkWorkspace) =>
      deps.execute({
        environmentId: request.environmentId,
        input: {
          commandId: CommandId.make(deps.newId()),
          creationSource: "mobile",
          sourceThreadId: request.sourceThreadId,
          targetThreadId: ThreadId.make(deps.newId()),
          sourcePoint:
            request.runId === undefined
              ? { type: "latest_stable" }
              : { type: "run", runId: request.runId },
          title: `${request.sourceTitle.trim() || "Thread"} fork`,
          workspace,
          serverForks: request.serverForks,
        },
      });
    const { workspace } = request;
    let result = await attempt(workspace);
    if (
      AsyncResult.isFailure(result) &&
      workspace.type === "worktree" &&
      workspace.includeUncommitted !== false
    ) {
      const error = squashAtomCommandFailure(result);
      if (
        error instanceof OrchestrationV2ThreadForkError &&
        error.reason === "uncommitted_unsupported"
      ) {
        if (!(await deps.confirmWithoutUncommitted(error.message))) return "done";
        result = await attempt({ ...workspace, includeUncommitted: false });
      }
    }
    if (AsyncResult.isSuccess(result)) {
      await deps.openThread(request.environmentId, result.value.targetThreadId);
      return "done";
    }
    const error = squashAtomCommandFailure(result);
    deps.showError(error instanceof Error ? error.message : "The fork could not be created.");
    return "done";
  } finally {
    inFlight.delete(key);
  }
}
