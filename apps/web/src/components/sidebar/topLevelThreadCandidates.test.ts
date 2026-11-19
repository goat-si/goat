import { paletteListedThreads } from "@goat/client-runtime/state/launch-fold";
import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@goat/contracts";
import { makeThreadFixture } from "../../test-fixtures";
import { topLevelThreadCandidates } from "./topLevelThreadCandidates";

describe("project opening candidates", () => {
  it("excludes settled and currently snoozed threads but keeps a woken thread", () => {
    const active = makeThreadFixture({ id: ThreadId.make("active") });
    const settled = makeThreadFixture({ id: ThreadId.make("settled"), settledOverride: "settled" });
    const snoozed = makeThreadFixture({
      id: ThreadId.make("snoozed"),
      snoozedAt: "2026-01-01T00:00:00Z",
      snoozedUntil: "2099-01-01T00:00:00Z",
    });
    const woken = makeThreadFixture({
      id: ThreadId.make("woken"),
      snoozedAt: "2026-01-01T00:00:00Z",
      snoozedUntil: "2026-01-02T00:00:00Z",
    });
    expect(
      topLevelThreadCandidates([active, settled, snoozed, woken], "2026-11-19T00:00:00Z").map(
        (thread) => thread.id,
      ),
    ).toEqual([active.id, woken.id]);
  });
});

it("keeps promoted, orphan, fork and parked rows in both palettes", () => {
  const parent = makeThreadFixture({ id: ThreadId.make("parent") });
  const childBase = makeThreadFixture({ id: ThreadId.make("child") });
  const launched = {
    kind: "launch" as const,
    threadId: parent.id,
    environmentId: null,
    environmentLabel: null,
    threadTitle: null,
    via: "thread_launch" as const,
  };
  const child = { ...childBase, source: { ...childBase.source, launchedBy: launched } };
  const promotedBase = makeThreadFixture({ id: ThreadId.make("promoted") });
  const promoted = {
    ...promotedBase,
    source: { ...promotedBase.source, launchedBy: { ...launched, kind: "promotion" as const } },
  };
  const orphanBase = makeThreadFixture({ id: ThreadId.make("orphan") });
  const orphan = {
    ...orphanBase,
    source: {
      ...orphanBase.source,
      launchedBy: { ...launched, threadId: ThreadId.make("missing") },
    },
  };
  const fork = makeThreadFixture({
    id: ThreadId.make("fork"),
    lineage: { rootThreadId: parent.id, parentThreadId: parent.id, relationshipToParent: "fork" },
  });
  const parked = makeThreadFixture({ id: ThreadId.make("parked"), settledOverride: "settled" });
  expect(
    paletteListedThreads(
      [parent, child, promoted, orphan, fork, parked],
      "2026-11-19T00:00:00Z",
    ).map((thread) => thread.id),
  ).toEqual([parent.id, promoted.id, orphan.id, fork.id, parked.id]);
});
