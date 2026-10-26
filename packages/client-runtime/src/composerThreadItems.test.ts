import { EnvironmentId, ThreadId } from "@goat/contracts";
import { expect, it } from "vite-plus/test";

import { matchComposerThreadItems, type ComposerThreadCandidate } from "./composerThreadItems.ts";

const environmentId = EnvironmentId.make("env-composer");

function shell(
  id: string,
  title: string,
  overrides: Partial<ComposerThreadCandidate> = {},
): ComposerThreadCandidate {
  return {
    environmentId,
    id: ThreadId.make(id),
    title,
    branch: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    latestUserMessageAt: null,
    opens: null,
    archivedAt: null,
    lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
    ...overrides,
  };
}

it("ranks thread mentions like the palette and leaves out subagent threads", () => {
  const items = matchComposerThreadItems({
    shells: [
      shell("newer-mid-word", "Remodel the settings page", {
        updatedAt: "2026-10-20T00:00:00.000Z",
      }),
      shell("word", "Fix model picker"),
      shell("subagent", "Model review", {
        lineage: {
          rootThreadId: ThreadId.make("word"),
          parentThreadId: ThreadId.make("word"),
          relationshipToParent: "subagent",
        },
      }),
      shell("other-environment", "Model docs", { environmentId: EnvironmentId.make("env-other") }),
    ],
    environmentId,
    excludeThreadId: null,
    query: "model",
    now: Date.parse("2026-10-23T00:00:00.000Z"),
  });
  expect(items.map((item) => item.thread.threadId)).toEqual(["word", "newer-mid-word"]);
});

it("offers SSH-reachable foreign threads with their routing host", () => {
  const local = environmentId;
  const remote = EnvironmentId.make("remote");
  const candidate = (id: string, env = local, minute = 1) =>
    shell(id, `Fix ${id}`, {
      environmentId: env,
      updatedAt: `2026-10-25T00:0${minute}:00.000Z`,
    });
  const shells = [
    candidate("current"),
    candidate("current", remote, 2),
    candidate("local"),
    candidate("url", EnvironmentId.make("url")),
  ];
  const input = {
    shells,
    environmentId: local,
    excludeThreadId: ThreadId.make("current"),
    query: "  FIX ",
    now: Date.parse("2026-10-26T00:00:00.000Z"),
  };
  // #1406: identical IDs on different servers still name different threads.
  expect(
    matchComposerThreadItems({
      ...input,
      sshHostsByEnvironment: new Map([[remote, "build-box"]]),
    }).map((item) => [item.thread.environmentId, item.thread.threadId, item.description]),
  ).toEqual([
    [remote, "current", "Thread · build-box"],
    [local, "local", "Thread"],
  ]);
  expect(matchComposerThreadItems(input).map((item) => item.thread.threadId)).toEqual(["local"]);
});

it("leaves out archived threads and matches nothing for a blank or absent query", () => {
  const input = {
    shells: [
      shell("open", "Fix login"),
      shell("archived", "Fix logout", { archivedAt: "2026-10-02T00:00:00.000Z" }),
    ],
    environmentId,
    excludeThreadId: null,
    query: "fix",
    now: Date.parse("2026-10-23T00:00:00.000Z"),
  };
  expect(matchComposerThreadItems(input).map((item) => item.thread.threadId)).toEqual(["open"]);
  expect(matchComposerThreadItems({ ...input, query: "  " })).toEqual([]);
  expect(matchComposerThreadItems({ ...input, query: "absent" })).toEqual([]);
});
