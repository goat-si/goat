import { scopeThreadRef, scopedThreadKey } from "@goat/client-runtime/environment";
import { goatBotObservationThreadKeys } from "@goat/client-runtime/state/threads";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import type { Thread } from "../../types";
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
  launch?: { readonly by: string; readonly via: "thread_launch" | "delegate_task" },
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
      },
    },
  };
}

const keyOf = (id: string) => scopedThreadKey(scopeThreadRef(local, ThreadId.make(id)));

function partition(threads: readonly Thread[], hiddenBotThreadKeys: ReadonlySet<string>) {
  return partitionSidebarThreads({
    threads,
    scopedProjectKeys: null,
    serverConfigs: new Map(),
    connectedEnvironmentIds: [local],
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
});
