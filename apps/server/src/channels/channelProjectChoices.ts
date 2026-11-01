/**
 * The project question GOAT Bot asks when work names no project. Reception and the dispatcher
 * share it, so both offer the same projects in the same words.
 *
 * @module channelProjectChoices
 */
import { CHANNEL_HOST_WORKSPACE_LABEL, CHANNEL_RECEPTION_MAX_OPTIONS } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";

export interface ChoosableProject {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
}

export const makeChannelProjectChoices = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const isManagedWorktree = yield* makeIsManagedWorktreePath;

  const contains = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  };

  /**
   * Projects a person means when asked to pick one. GOAT's own worktrees and folders that only
   * hold other projects (a home or org folder) are left out; they stay valid when named.
   */
  const offered = (projects: ReadonlyArray<ChoosableProject>) =>
    Effect.gen(function* () {
      const kept: Array<ChoosableProject> = [];
      for (const project of projects) {
        if (yield* isManagedWorktree(project.workspaceRoot)) continue;
        const holdsOthers = projects.some(
          (other) =>
            other.id !== project.id && contains(project.workspaceRoot, other.workspaceRoot),
        );
        // A repository with a nested project is still a project; a plain folder is not.
        if (
          holdsOthers &&
          !(yield* fileSystem
            .exists(path.join(project.workspaceRoot, ".git"))
            .pipe(Effect.orElseSucceed(() => false)))
        )
          continue;
        kept.push(project);
      }
      return kept.length > 0 ? kept : projects;
    });

  /**
   * The project of the most recently active thread first, then the others, then the bot's
   * workspace for work about the machine itself.
   */
  const question = (projects: ReadonlyArray<ChoosableProject>, hostWorkspace: boolean) =>
    Effect.gen(function* () {
      const allowed = yield* offered(projects);
      const recent = yield* threads
        .listProjectThreads({ projectId: undefined, includeSubagents: false })
        .pipe(Effect.orElseSucceed(() => []));
      const allowedIds = new Set(allowed.map((project) => project.id));
      const recentFirst: ReadonlyArray<string> = [
        ...new Set(
          recent
            .filter((shell) => shell.archivedAt === null && allowedIds.has(shell.projectId))
            .map((shell) => shell.projectId),
        ),
      ];
      const ordered = [
        ...recentFirst.flatMap((id) => allowed.filter((project) => project.id === id)),
        ...allowed.filter((project) => !recentFirst.includes(project.id)),
      ];
      const room = CHANNEL_RECEPTION_MAX_OPTIONS - (hostWorkspace ? 1 : 0);
      const choices = [
        ...ordered.slice(0, room).map((project) => project.title),
        ...(hostWorkspace ? [CHANNEL_HOST_WORKSPACE_LABEL] : []),
      ];
      const recommended = recentFirst.length > 0 ? ordered[0]?.title : undefined;
      const text =
        "Which project should I use?" +
        (recommended === undefined
          ? ""
          : " I'd go with " + recommended + ", where you worked most recently.") +
        (ordered.length > room
          ? " All projects: " + ordered.map((project) => project.title).join(", ")
          : "");
      return { type: "question" as const, text, choices };
    });

  return { question };
});
