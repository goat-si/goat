import {
  goatBotListedWork,
  goatBotObservationThreadKeys,
} from "@goat/client-runtime/state/threads";
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
  launch?: {
    readonly by: string;
    readonly via: "thread_launch" | "delegate_task";
    readonly workKind?: "coding" | "chore";
  },
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
        ...(launch.workKind === undefined ? {} : { workKind: launch.workKind }),
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

  it("regression GB-M-01: hides member bots and listed chores, lists them when shown, and finds them in search", () => {
    const withBot = [
      ...threads,
      makeThread("channel-member-bot:member"),
      makeThread(
        "channel-child-work:chore",
        {},
        { by: SESSION, via: "thread_launch", workKind: "chore" },
      ),
    ];
    const keys = goatBotObservationThreadKeys({
      threads: withBot,
      listedWork: goatBotListedWork([
        {
          kind: "coding",
          taskId: "channel-task:a" as never,
          environmentId,
          threadId: ThreadId.make("channel-child-work:chore"),
          state: "bound",
          lastActivityAt: NOW,
          workKind: "chore",
        },
      ]),
    });
    const ids = (searchQuery: string, hidden?: ReadonlySet<string>) =>
      buildThreadListV2Items({
        threads: withBot,
        environmentId: null,
        searchQuery,
        now: NOW,
        ...(hidden ? { hiddenBotThreadKeys: hidden } : {}),
      })
        .items.map((item) => String(item.thread.id))
        .toSorted();
    expect(ids("", keys)).toEqual(["channel-worker:work", "coding", "mine"]);
    expect(ids("")).toEqual(expect.arrayContaining(["channel-member-bot:member"]));
    expect(ids("chore", keys)).toEqual(["channel-child-work:chore"]);
    expect(ids("member", keys)).toEqual(["channel-member-bot:member"]);
  });

  it("hides a chore on another connected machine only there, and search still finds it", () => {
    const box = EnvironmentId.make("environment-box");
    const worker = ThreadId.make("channel-worker:task-a");
    const base = makeThreadShellFixture({
      environmentId: box,
      id: ThreadId.make("restart-3774"),
      title: "restart-3774",
    });
    const remoteChore: EnvironmentThreadShell = {
      ...base,
      source: {
        ...base.source,
        launchedBy: {
          kind: "launch",
          threadId: worker,
          environmentId,
          environmentLabel: "studio",
          threadTitle: null,
          via: "ssh_thread_launch",
          workKind: "chore",
        },
      },
    };
    const twin = makeThread("restart-3774");
    const all = [...threads, remoteChore, twin];
    const keysFor = (openable: boolean) =>
      goatBotObservationThreadKeys({
        threads: all,
        // The phone has no SSH alias for box; the destination's own id is what resolves it.
        listedWork: goatBotListedWork([], {
          originEnvironmentId: environmentId,
          items: [
            {
              childWorkId: "cw-restart" as never,
              taskId: "channel-task:a" as never,
              callerThreadId: worker,
              host: "box",
              state: "bound",
              lastActivityAt: NOW,
              threadId: remoteChore.id,
              environmentId: box,
              workKind: "chore",
            },
          ],
          isOpenable: (id) => openable && id === box,
        }),
      });
    const ids = (searchQuery: string, hidden?: ReadonlySet<string>) =>
      buildThreadListV2Items({
        threads: all,
        environmentId: null,
        searchQuery,
        now: NOW,
        ...(hidden ? { hiddenBotThreadKeys: hidden } : {}),
      })
        .items.map((item) => item.thread.environmentId + ":" + item.thread.id)
        .toSorted();
    const keys = keysFor(true);
    expect(ids("", keys)).not.toContain(box + ":restart-3774");
    expect(ids("", keys)).toContain(environmentId + ":restart-3774");
    expect(ids("")).toContain(box + ":restart-3774");
    expect(ids("restart", keys)).toContain(box + ":restart-3774");
    expect(ids("", keysFor(false))).toContain(box + ":restart-3774");
  });

  it("lists every thread when no bot visibility is passed, the bot's work folded under its session", () => {
    expect(listed("")).toEqual([
      "channel-worker:work",
      "goat-bot-session:conversation",
      "mine",
      "observer",
    ]);
    const layout = buildThreadListV2Items({
      threads,
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });
    expect(layout.launchMarkers?.map((marker) => marker.entry.parentKey)).toEqual([
      `${environmentId}:${SESSION}`,
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
