import { EnvironmentId, ThreadId } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import { matchComposerThreadItems, type ComposerThreadCandidate } from "./composerThreadItems.ts";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
function candidate(id: string, environmentId = local, minute = 1): ComposerThreadCandidate {
  return {
    id: ThreadId.make(id),
    environmentId,
    title: `Fix ${id}`,
    updatedAt: `2026-10-25T00:0${minute}:00Z`,
    archivedAt: null,
  };
}

it("offers SSH-reachable foreign threads with their routing host", () => {
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

it("filters archives and empty queries and returns the five newest title matches", () => {
  const shells = Array.from({ length: 7 }, (_, index) => candidate(String(index), local, index));
  shells.push({ ...candidate("archived", local, 9), archivedAt: "2026-10-25" });
  const input = { shells, environmentId: local, excludeThreadId: null, query: "fix" };
  expect(matchComposerThreadItems(input).map((item) => item.thread.threadId)).toEqual([
    "6",
    "5",
    "4",
    "3",
    "2",
  ]);
  expect(matchComposerThreadItems({ ...input, query: "  " })).toEqual([]);
  expect(matchComposerThreadItems({ ...input, query: "absent" })).toEqual([]);
});
