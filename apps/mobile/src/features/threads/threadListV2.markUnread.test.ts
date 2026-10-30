import { presentThreadShell } from "@goat/client-runtime/state/models";
import { EnvironmentId, RunId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { makeRawThreadShell } from "../../test-fixtures";
import { canMarkThreadUnread, threadHasUnseenCompletion } from "./threadListV2";

const environmentId = EnvironmentId.make("environment-1");
const NOW = "2026-06-02T00:00:00.000Z";

describe("canMarkThreadUnread", () => {
  const completedAt = DateTime.makeUnsafe(NOW);
  const shell = (input: Parameters<typeof makeRawThreadShell>[0]) =>
    presentThreadShell(
      environmentId,
      makeRawThreadShell({
        latestRunId: RunId.make("run-done"),
        status: "completed",
        latestRunCompletedAt: completedAt,
        ...input,
      }),
    );

  it("offers Mark unread only on a visited thread whose latest run completed", () => {
    expect(canMarkThreadUnread(shell({ lastVisitedAt: DateTime.makeUnsafe(NOW) }))).toBe(true);
    expect(
      canMarkThreadUnread(
        shell({ lastVisitedAt: DateTime.makeUnsafe("2026-06-01T00:00:00.000Z") }),
      ),
    ).toBe(false);
    expect(canMarkThreadUnread(shell({ lastVisitedAt: null }))).toBe(false);
    expect(
      canMarkThreadUnread(
        shell({ lastVisitedAt: DateTime.makeUnsafe(NOW), latestRunCompletedAt: null }),
      ),
    ).toBe(false);
  });

  it("hides Mark unread once the server marks the thread unread, until it is visited again", () => {
    const marked = shell({
      lastVisitedAt: DateTime.subtract(completedAt, { milliseconds: 1 }),
      markedUnreadCompletionAt: completedAt,
    });
    expect(threadHasUnseenCompletion(marked)).toBe(true);
    expect(canMarkThreadUnread(marked)).toBe(false);
  });

  it("hides Mark unread on servers without visit tracking", () => {
    const { lastVisitedAt: _omitted, ...legacy } = shell({
      lastVisitedAt: DateTime.makeUnsafe(NOW),
    });
    expect(canMarkThreadUnread(legacy)).toBe(false);
  });
});
