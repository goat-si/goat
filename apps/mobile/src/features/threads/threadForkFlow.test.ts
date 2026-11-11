import { describe, expect, it, vi } from "vite-plus/test";
import {
  CommandId,
  EnvironmentId,
  OrchestrationV2ThreadForkError,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadForkResult,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import { runThreadFork, type ThreadForkFlowDeps, type ThreadForkRequest } from "./threadForkFlow";

const environmentId = EnvironmentId.make("environment-a");
const sourceThreadId = ThreadId.make("source");

const request = (overrides: Partial<ThreadForkRequest> = {}): ThreadForkRequest => ({
  environmentId,
  sourceThreadId,
  sourceTitle: "Plan the release",
  workspace: { type: "worktree" },
  serverForks: true,
  ...overrides,
});

const forkError = (reason: OrchestrationV2ThreadForkError["reason"], message: string) =>
  new OrchestrationV2ThreadForkError({
    commandId: CommandId.make("command"),
    sourceThreadId,
    reason,
    message,
  });

function harness(results: ReadonlyArray<unknown>, confirm = true) {
  let id = 0;
  const pending = [...results];
  const execute = vi.fn<ThreadForkFlowDeps["execute"]>(async ({ input }) => {
    const next = pending.shift();
    return next instanceof Error
      ? AsyncResult.failure(Cause.fail(next))
      : AsyncResult.success<OrchestrationV2ThreadForkResult>({
          sequence: 1,
          targetThreadId: input.targetThreadId,
        });
  });
  const deps = {
    execute,
    newId: () => `id-${++id}`,
    confirmWithoutUncommitted: vi.fn(async () => confirm),
    openThread: vi.fn(async () => undefined),
    showError: vi.fn(),
  } satisfies ThreadForkFlowDeps;
  return deps;
}

describe("runThreadFork", () => {
  it("forks from a response's run into the current workspace and opens the fork", async () => {
    const deps = harness([null]);
    await runThreadFork(
      request({ workspace: { type: "current" }, runId: RunId.make("run-1"), serverForks: false }),
      deps,
    );
    expect(deps.execute).toHaveBeenCalledWith({
      environmentId,
      input: {
        commandId: "id-1",
        creationSource: "mobile",
        sourceThreadId,
        targetThreadId: "id-2",
        sourcePoint: { type: "run", runId: "run-1" },
        title: "Plan the release fork",
        workspace: { type: "current" },
        serverForks: false,
      },
    });
    expect(deps.openThread).toHaveBeenCalledWith(environmentId, "id-2");
  });

  it("forks the latest finished turn when no run is named", async () => {
    const deps = harness([null]);
    await runThreadFork(request(), deps);
    expect(deps.execute.mock.calls[0]?.[0].input.sourcePoint).toEqual({ type: "latest_stable" });
  });

  it("offers to leave uncommitted changes behind and retries as a new request", async () => {
    const message = "Git cannot carry these uncommitted changes.";
    const deps = harness([forkError("uncommitted_unsupported", message), null]);
    await runThreadFork(request({ runId: RunId.make("run-1") }), deps);

    expect(deps.confirmWithoutUncommitted).toHaveBeenCalledWith(message);
    const [first, retry] = deps.execute.mock.calls.map(([call]) => call.input);
    expect(retry).toMatchObject({
      sourcePoint: { type: "run", runId: "run-1" },
      workspace: { type: "worktree", includeUncommitted: false },
    });
    expect(retry?.commandId).not.toBe(first?.commandId);
    expect(retry?.targetThreadId).not.toBe(first?.targetThreadId);
    expect(deps.openThread).toHaveBeenCalledWith(environmentId, retry?.targetThreadId);
    expect(deps.showError).not.toHaveBeenCalled();
  });

  it("stops when the person keeps their uncommitted changes", async () => {
    const deps = harness([forkError("uncommitted_unsupported", "No snapshot.")], false);
    await runThreadFork(request(), deps);
    expect(deps.execute).toHaveBeenCalledTimes(1);
    expect(deps.openThread).not.toHaveBeenCalled();
    expect(deps.showError).not.toHaveBeenCalled();
  });

  it("shows the server's message for any other refusal", async () => {
    const deps = harness([forkError("branch_exists", "That branch already exists.")]);
    await runThreadFork(request(), deps);
    expect(deps.confirmWithoutUncommitted).not.toHaveBeenCalled();
    expect(deps.showError).toHaveBeenCalledWith("That branch already exists.");
  });

  it("ignores a second fork of the same thread until the first settles", async () => {
    const deps = harness([null, null]);
    const first = runThreadFork(request(), deps);
    await expect(runThreadFork(request({ workspace: { type: "current" } }), deps)).resolves.toBe(
      "busy",
    );
    await expect(first).resolves.toBe("done");
    expect(deps.execute).toHaveBeenCalledTimes(1);
    await expect(runThreadFork(request(), deps)).resolves.toBe("done");
  });
});
