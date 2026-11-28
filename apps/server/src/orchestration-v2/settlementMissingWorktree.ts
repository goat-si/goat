import { resolveProjectScripts, settleProjectScript } from "@goat/shared/projectScripts";
import type { OrchestrationV2AppThread } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as ProjectStore from "./ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";

export const logMissingWorktreeSettleScript = Effect.fn(
  "ThreadSettlementService.logMissingWorktreeSettleScript",
)(function* (
  thread: OrchestrationV2AppThread,
  worktreePath: string,
  projects: ProjectStore.ProjectStoreV2["Service"],
  settings: ServerSettings.ServerSettingsService["Service"],
) {
  const project = (yield* projects.listShells()).find((item) => item.id === thread.projectId);
  if (project && settleProjectScript(resolveProjectScripts(yield* settings.getSettings, project))) {
    yield* Effect.logWarning("settle script skipped: the thread's worktree no longer exists", {
      threadId: thread.id,
      worktreePath,
    });
  }
});
