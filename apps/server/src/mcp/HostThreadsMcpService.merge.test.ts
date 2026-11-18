import { describe, expect, it } from "@effect/vitest";

import * as HostThreadsMcpService from "./HostThreadsMcpService.ts";
import { item } from "./hostThreadsList.testkit.ts";

describe("mergeHostThreadLists", () => {
  it("keeps the newest threads across environments and says when more exist", () => {
    const merged = HostThreadsMcpService.mergeHostThreadLists(
      [
        {
          threads: [item("a", "2026-10-11T10:00:00.000Z"), item("b", "2026-10-11T08:00:00.000Z")],
          total: 5,
        },
        {
          threads: [
            item("c", "2026-10-11T09:00:00.000Z", "box"),
            item("d", "2026-10-11T07:00:00.000Z", "box"),
          ],
          total: 2,
        },
      ],
      3,
    );
    expect(merged.threads.map((thread) => thread.threadId)).toEqual(["a", "c", "b"]);
    expect(merged.total).toBe(7);
    expect(merged.truncated).toBe(true);
  });

  it("orders equal times by thread id, then this environment before a host", () => {
    const at = "2026-10-11T10:00:00.000Z";
    const merged = HostThreadsMcpService.mergeHostThreadLists(
      [
        { threads: [item("x", at, "box")], total: 1 },
        { threads: [item("x", at), item("y", at)], total: 2 },
      ],
      10,
    );
    expect(merged.threads.map((thread) => [thread.threadId, thread.host ?? "here"])).toEqual([
      ["y", "here"],
      ["x", "here"],
      ["x", "box"],
    ]);
    expect(merged.truncated).toBe(false);
  });
});
