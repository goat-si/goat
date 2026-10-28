import { goatBotObservationThreadKeys } from "@goat/client-runtime/state/threads";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import { buildThreadListV2Items, getThreadListV2OrderedSection } from "./threadListV2";

const environmentId = EnvironmentId.make("environment-1");
const NOW = "2026-06-02T00:00:00.000Z";

function makeThread(
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
  launch?: { readonly by: string; readonly via: "thread_launch" | "delegate_task" },
): EnvironmentThreadShell {
  const thread = makeThreadShellFixture({
    environmentId,
    id: ThreadId.make(id),
    title: id,
    ...overrides,
  });
  if (launch === undefined) return thread;
  return {
    ...thread,
    source: {
      ...thread.source,
      launchedBy: {
        kind: "launch",
        threadId: ThreadId.make(launch.by),
        environmentId: null,
        environmentLabel: null,
        threadTitle: null,
        via: launch.via,
      },
    },
  };
}

const SESSION = "goat-bot-session:conversation";
const pinned = (key: string) => ({ pinnedAt: "2026-06-01T00:00:00.000Z", pinOrderKey: key });

describe("threadListV2 with GOAT Bot threads", () => {
  const threads = [
    makeThread("mine"),
    makeThread(SESSION),
    makeThread("observer", {}, { by: SESSION, via: "delegate_task" }),
    makeThread("coding", {}, { by: SESSION, via: "thread_launch" }),
    makeThread("channel-worker:work"),
  ];
  const hiddenBotThreadKeys = goatBotObservationThreadKeys({ threads });
  const listed = (searchQuery: string, keys?: ReadonlySet<string>) =>
    buildThreadListV2Items({
      threads,
      environmentId: null,
      searchQuery,
      now: NOW,
      ...(keys ? { hiddenBotThreadKeys: keys } : {}),
    })
      .items.map((item) => String(item.thread.id))
      .toSorted();

  it("gives bot observation threads no row and keeps coding work, in the bot's workspace too", () => {
    expect(listed("", hiddenBotThreadKeys)).toEqual(["channel-worker:work", "coding", "mine"]);
  });

  it("still finds hidden bot threads in search", () => {
    expect(listed("observer", hiddenBotThreadKeys)).toEqual(["observer"]);
  });

  it("lists every thread as before when no bot visibility is passed", () => {
    expect(listed("")).toEqual([
      "channel-worker:work",
      "coding",
      "goat-bot-session:conversation",
      "mine",
      "observer",
    ]);
  });

  it("orders a section without hidden bot threads, so a move crosses the next shown row", () => {
    const rows = [
      makeThread("a", pinned("a")),
      makeThread(SESSION, pinned("b")),
      makeThread("b", pinned("c")),
    ];
    const keys = goatBotObservationThreadKeys({ threads: rows });
    const ordered = getThreadListV2OrderedSection({
      threads: rows,
      section: "pinned",
      now: NOW,
      hiddenBotThreadKeys: keys,
    });
    const shown = buildThreadListV2Items({
      threads: rows,
      environmentId: null,
      searchQuery: "",
      now: NOW,
      hiddenBotThreadKeys: keys,
    });
    expect(ordered.map((thread) => String(thread.id))).toEqual(["a", "b"]);
    expect(shown.items.map((item) => String(item.thread.id))).toEqual(["a", "b"]);
  });
});
