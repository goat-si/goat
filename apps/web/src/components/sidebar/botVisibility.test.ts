import { scopeThreadRef, scopedThreadKey } from "@goat/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import type { Thread } from "../../types";
import { withBotSearchCandidates, withoutBotThreads } from "./botVisibility";

const local = EnvironmentId.make("environment-local");
const remote = EnvironmentId.make("environment-remote");
const project = ProjectId.make("project-1");
const other = ProjectId.make("project-2");

const row = (id: string, overrides: Partial<Thread> = {}): Thread =>
  makeThreadFixture({
    id: ThreadId.make(id),
    environmentId: local,
    projectId: project,
    runtime: null,
    ...overrides,
  });
const keyOf = (thread: Thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
const ids = (threads: readonly Thread[]) =>
  threads.map((thread) => `${thread.environmentId}/${thread.id}`);

describe("GOAT Bot threads in the sidebar", () => {
  const user = row("user-thread");
  const session = row("goat-bot-session:conversation");
  const observer = row("observer", {
    lineage: {
      parentThreadId: session.id,
      relationshipToParent: "subagent",
      rootThreadId: session.id,
    },
  });
  const sameIdElsewhere = row("observer", { environmentId: remote });
  const archived = row("archived-observer", { archivedAt: "2026-10-27T00:00:00.000Z" });
  const otherProject = row("other-project-observer", { projectId: other });
  const threads = [user, session, observer, sameIdElsewhere, archived, otherProject];
  const observation = new Set([session, observer, archived, otherProject].map(keyOf));

  it("leaves hidden bot threads out of the list and keeps everything else", () => {
    expect(ids(withoutBotThreads([user, session, sameIdElsewhere], observation))).toEqual([
      "environment-local/user-thread",
      "environment-remote/observer",
    ]);
    expect(withoutBotThreads(threads, new Set())).toBe(threads);
  });

  it("lets search find hidden bot threads, subagents included, once and in scope", () => {
    const scope = new Set([`${local}:${project}`]);
    expect(ids(withBotSearchCandidates([user, session], threads, observation, scope))).toEqual([
      "environment-local/user-thread",
      "environment-local/goat-bot-session:conversation",
      "environment-local/observer",
    ]);
  });
});
