import { scopeThreadRef, scopedThreadKey } from "@goat/client-runtime/environment";
import {
  goatBotListedWork,
  goatBotObservationThreadKeys,
} from "@goat/client-runtime/state/threads";
import { EnvironmentId, ThreadId, type BotThreadRow } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import type { Thread } from "../../types";
import { withBotSearchCandidates } from "./botVisibility";
import { partitionSidebarThreads } from "./sidebarPartition";
import { resolveNestedRowVariant } from "./settledLaunchShelf";

describe("nested thread row variants", () => {
  it("keeps settled children as cards under card parents", () => {
    expect(resolveNestedRowVariant("settled", "card")).toBe("card");
    expect(resolveNestedRowVariant("settled", "slim")).toBe("slim");
    expect(resolveNestedRowVariant("settled")).toBe("slim");
  });

  it("preserves the existing variants for other sections", () => {
    for (const section of ["priority", "pinned", "active"] as const) {
      expect(resolveNestedRowVariant(section, "slim")).toBe("card");
    }
    for (const section of ["snoozed", "working"] as const) {
      expect(resolveNestedRowVariant(section, "card")).toBe("slim");
    }
  });
});

const local = EnvironmentId.make("environment-local");

function row(
  id: string,
  launch?: {
    readonly by: string;
    readonly via: "thread_launch" | "delegate_task";
    readonly workKind?: "coding" | "chore";
  },
): Thread {
  const base = makeThreadFixture({ id: ThreadId.make(id), environmentId: local, runtime: null });
  if (launch === undefined) return base;
  return {
    ...base,
    source: {
      ...base.source,
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

const keyOf = (id: string) => scopedThreadKey(scopeThreadRef(local, ThreadId.make(id)));

function partition(
  threads: readonly Thread[],
  hiddenBotThreadKeys: ReadonlySet<string>,
  connectedEnvironmentIds: readonly EnvironmentId[] = [local],
) {
  return partitionSidebarThreads({
    threads,
    scopedProjectKeys: null,
    serverConfigs: new Map(),
    connectedEnvironmentIds,
    optimisticDrop: null,
    workingShelfEnabled: false,
    clockKey: "",
    globalAgentRef: null,
    goatBotRef: null,
    attentionByOwnerKey: new Map(),
    openSubagentOwnerKey: undefined,
    localLastVisitedAtByKey: {},
    priorityHolds: new Map(),
    acknowledgedWakes: new Set(),
    priorityReleases: new Set(),
    hiddenBotThreadKeys,
  });
}

const rowIds = (result: ReturnType<typeof partition>) =>
  result.launchFold.roots.map((thread) => String(thread.id)).toSorted();

describe("partitionSidebarThreads with GOAT Bot threads", () => {
  const session = row("goat-bot-session:conversation");
  const observation = row("bot-observation", { by: session.id, via: "delegate_task" });
  const coding = row("bot-coding", { by: session.id, via: "thread_launch" });
  const work = row("channel-worker:work");
  const threads = [session, observation, coding, work];

  it("gives hidden bot threads no row and keeps the coding thread a session launched", () => {
    const result = partition(threads, new Set([keyOf(session.id), keyOf(observation.id)]));
    expect(rowIds(result)).toEqual(["bot-coding", "channel-worker:work"]);
    expect(result.launchFold.folded).toEqual([]);
  });

  it("lists every bot thread with today's folding when nothing is hidden", () => {
    const result = partition(threads, new Set());
    expect(rowIds(result)).toEqual([
      "bot-observation",
      "channel-worker:work",
      "goat-bot-session:conversation",
    ]);
    expect(result.launchFold.parentKeyByKey.get(keyOf(coding.id))).toBe(keyOf(session.id));
  });

  it("hides exactly what the shared classifier finds for GOAT Bot", () => {
    const result = partition(threads, goatBotObservationThreadKeys({ threads }));
    expect(rowIds(result)).toEqual(["bot-coding", "channel-worker:work"]);
  });

  it("regression GB-W-01: hides a member bot and a listed chore until bot threads are shown, and search finds them", () => {
    const member = row("channel-member-bot:member");
    const chore = row("channel-child-work:chore", {
      by: session.id,
      via: "thread_launch",
      workKind: "chore",
    });
    const all = [...threads, member, chore];
    const rows: BotThreadRow[] = [
      {
        kind: "coding",
        taskId: "channel-task:a" as never,
        environmentId: local,
        threadId: chore.id,
        state: "bound",
        lastActivityAt: "2026-11-09T00:00:00.000Z",
        workKind: "chore",
      },
    ];
    const observation = goatBotObservationThreadKeys({
      threads: all,
      listedWork: goatBotListedWork(rows),
    });
    const hiddenResult = partition(all, observation);
    expect(rowIds(hiddenResult)).toEqual(["bot-coding", "channel-worker:work"]);
    // "Show GOAT Bot threads" passes no hidden keys; the chore folds under its session's row.
    const shown = partition(all, new Set());
    expect(rowIds(shown)).toEqual(expect.arrayContaining(["channel-member-bot:member"]));
    expect(shown.launchFold.parentKeyByKey.get(keyOf(chore.id))).toBe(keyOf(session.id));
    const searchable = withBotSearchCandidates(
      hiddenResult.visibleThreads,
      all,
      observation,
      null,
    ).map((thread) => String(thread.id));
    expect(searchable).toEqual(
      expect.arrayContaining(["channel-member-bot:member", "channel-child-work:chore"]),
    );
  });
  it("hides a chore on another connected machine only there, shows it when asked, and search finds it", () => {
    const box = EnvironmentId.make("environment-box");
    const worker = ThreadId.make("channel-worker:task-a");
    const remoteBase = makeThreadFixture({
      id: ThreadId.make("restart-3774"),
      environmentId: box,
      runtime: null,
    });
    const remoteChore: Thread = {
      ...remoteBase,
      source: {
        ...remoteBase.source,
        launchedBy: {
          kind: "launch",
          threadId: worker,
          environmentId: local,
          environmentLabel: "studio",
          threadTitle: null,
          via: "ssh_thread_launch",
          workKind: "chore",
        },
      },
    };
    // A person's thread here that happens to share the remote thread's id.
    const twin = row("restart-3774");
    const all = [...threads, remoteChore, twin];
    const listedWork = (openable: boolean) =>
      goatBotListedWork([], {
        originEnvironmentId: local,
        items: [
          {
            childWorkId: "cw-restart" as never,
            taskId: "channel-task:a" as never,
            callerThreadId: worker,
            host: "box",
            state: "bound",
            lastActivityAt: "2026-11-09T00:00:00.000Z",
            threadId: remoteChore.id,
            environmentId: box,
            workKind: "chore",
          },
        ],
        isOpenable: (environmentId) => openable && environmentId === box,
      });
    const remoteKey = scopedThreadKey(scopeThreadRef(box, remoteChore.id));
    const observation = goatBotObservationThreadKeys({
      threads: all,
      listedWork: listedWork(true),
    });
    expect(observation.has(remoteKey)).toBe(true);
    expect(observation.has(keyOf("restart-3774"))).toBe(false);
    const connected = [local, box];
    const hiddenResult = partition(all, observation, connected);
    expect(
      hiddenResult.visibleThreads.map((thread) => thread.environmentId + ":" + thread.id),
    ).toEqual(expect.not.arrayContaining([box + ":restart-3774"]));
    expect(hiddenResult.visibleThreads.some((thread) => thread === twin)).toBe(true);
    expect(partition(all, new Set(), connected).visibleThreads).toContain(remoteChore);
    expect(withBotSearchCandidates(hiddenResult.visibleThreads, all, observation, null)).toContain(
      remoteChore,
    );
    // Its machine is not connected here, so the bot cannot open it: it stays listed.
    const unavailable = goatBotObservationThreadKeys({
      threads: all,
      listedWork: listedWork(false),
    });
    expect(unavailable.has(remoteKey)).toBe(false);
  });
});

it("orders active threads by their latest user prompt when the working shelf is off", () => {
  const older = {
    ...row("older"),
    createdAt: "2026-03-01T00:00:00Z",
    latestUserAuthoredMessageAt: "2026-03-03T00:00:00Z",
  };
  const newer = { ...row("newer"), createdAt: "2026-03-02T00:00:00Z" };
  expect(partition([newer, older], new Set()).activeThreads.map((thread) => thread.id)).toEqual([
    "older",
    "newer",
  ]);
});
