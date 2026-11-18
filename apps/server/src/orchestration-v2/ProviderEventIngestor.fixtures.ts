import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as FileSystem from "effect/FileSystem";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
export const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
export const CODEX_DRIVER = ProviderDriverKind.make("codex");

export const threadCreatedEvent = Effect.fn("ProviderEventIngestorTest.threadCreatedEvent")(
  function* (now: DateTime.Utc) {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const projectId = yield* idAllocator.allocate.project({
      fixtureName: "provider-event-ingestor",
    });
    const threadId = yield* idAllocator.allocate.thread({
      fixtureName: "provider-event-ingestor",
      projectId,
    });
    const providerThreadId = idAllocator.derive.providerThread({
      driver: CODEX_DRIVER,
      nativeThreadId: "native-thread",
    });
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId,
      title: "Provider event ingestor",
      providerInstanceId: modelSelection.instanceId,
      modelSelection: modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      branchPullRequest: null,
      activeOrderKey: null,
      activeProviderThreadId: providerThreadId,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: threadId,
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };

    return {
      id: yield* idAllocator.allocate.event({ threadId }),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: thread,
    } satisfies OrchestrationV2DomainEvent;
  },
);

export const makeSharedWorktree = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "ingestor-worktree-" });
  const repo = `${directory}/repo`;
  const worktreePath = `${directory}/shared`;
  yield* fs.makeDirectory(repo);
  const command = (cwd: string, args: string[]) =>
    git.execute({ operation: "ingestor-test", cwd, args });
  yield* command(repo, ["init", "-b", "main"]);
  yield* command(repo, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  ]);
  yield* command(repo, ["worktree", "add", "-b", "t3/abcd1234", worktreePath]);
  return { repo, worktreePath, command };
});
