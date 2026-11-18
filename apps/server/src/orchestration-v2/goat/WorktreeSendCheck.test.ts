import { assert, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";

import { worktreeSendRefusal, type SendCheckReads } from "./WorktreeSendCheck.ts";

const thread = {
  id: ThreadId.make("thread:send-check"),
  projectId: ProjectId.make("project:send-check"),
  worktreePath: "/goat/worktrees/repo/feature",
  branch: "feature" as string | null,
  instanceId: ProviderInstanceId.make("codex"),
};

/** The check's whole world: these three reads, recorded, and nothing that could run Git. */
const reads = (state: { exists: boolean; managed: boolean; project: boolean; cloud?: boolean }) => {
  const calls: Array<string> = [];
  const value: SendCheckReads = {
    exists: (path) => Effect.sync(() => (calls.push(`exists ${path}`), state.exists)),
    isManaged: (path) => Effect.sync(() => (calls.push(`managed ${path}`), state.managed)),
    projectExists: (id) => Effect.sync(() => (calls.push(`project ${id}`), state.project)),
    runsInCloud: (id) => Effect.sync(() => (calls.push(`cloud ${id}`), state.cloud === true)),
  };
  return { value, calls };
};

it.effect("a present worktree is untouched: one existence read, no refusal", () =>
  Effect.gen(function* () {
    const { value, calls } = reads({ exists: true, managed: false, project: false });
    assert.isUndefined(yield* worktreeSendRefusal(value, thread));
    assert.deepEqual(calls, [`exists ${thread.worktreePath}`]);
  }),
);

it.effect("a missing worktree GOAT can restore passes; turn start restores it", () =>
  Effect.gen(function* () {
    const { value } = reads({ exists: false, managed: true, project: true });
    assert.isUndefined(yield* worktreeSendRefusal(value, thread));
    assert.isUndefined(yield* worktreeSendRefusal(value, { ...thread, worktreePath: null }));
  }),
);

it.effect.each([
  {
    case: "no branch",
    state: { exists: false, managed: true, project: true },
    branch: null,
    says: "the thread has no branch to recreate it from. Move the thread to an existing folder, or start a new thread.",
  },
  {
    case: "a worktree GOAT cannot recreate in place",
    state: { exists: false, managed: false, project: true },
    branch: "feature",
    says: "GOAT only recreates worktrees at <worktrees folder>/<repository>/<name>. Put the folder back at that path, or move the thread to another worktree.",
  },
  {
    case: "project gone",
    state: { exists: false, managed: true, project: false },
    branch: "feature",
    says: "its project is no longer available. Start a new thread in an available project.",
  },
])("a missing worktree GOAT cannot restore is refused with why and what to do: $case", (row) =>
  Effect.gen(function* () {
    const { value } = reads(row.state);
    assert.equal(
      yield* worktreeSendRefusal(value, { ...thread, branch: row.branch }),
      `The worktree of thread ${thread.id} at ${thread.worktreePath} is missing, and GOAT can't recreate it: ${row.says}`,
    );
  }),
);

it.effect("a cloud thread's missing worktree is not refused: turn start never prepares it", () =>
  Effect.gen(function* () {
    const { value } = reads({ exists: false, managed: false, project: false, cloud: true });
    assert.isUndefined(yield* worktreeSendRefusal(value, { ...thread, branch: null }));
  }),
);
