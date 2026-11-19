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
