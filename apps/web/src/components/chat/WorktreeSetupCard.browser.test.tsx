import { ThreadId, type WorktreeSetupSnapshot } from "@goat/contracts";
import { Profiler } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";
import { WorktreeSetupCard } from "./WorktreeSetupCard";

const NOW = new Date("2026-10-26T12:00:10.000Z");

function snapshot(overrides: Partial<WorktreeSetupSnapshot>): WorktreeSetupSnapshot {
  return {
    threadId: ThreadId.make("thread-1"),
    phase: "running",
    startedAt: "2026-10-26T12:00:00.000Z",
    endedAt: null,
    branch: "goat/feature",
    baseRef: "main",
    worktreePath: "/repo/.goat/worktrees/feature",
    setupScript: null,
    stages: [
      {
        id: "fetch",
        status: "done",
        startedAt: "2026-10-26T12:00:00.000Z",
        endedAt: "2026-10-26T12:00:03.000Z",
        percent: null,
        detail: null,
        tail: [],
      },
      {
        id: "checkout",
        status: "running",
        startedAt: "2026-10-26T12:00:03.000Z",
        endedAt: null,
        percent: null,
        detail: null,
        tail: [],
      },
    ],
    error: null,
    sequence: 1,
    ...overrides,
  };
}

const card = (value: WorktreeSetupSnapshot) => (
  <WorktreeSetupCard snapshot={value} onCancel={null} onWorkLocally={null} onOpenTerminal={null} />
);

it("ticks the running stage without rendering the card or changing finished durations", async () => {
  // The clock subscribes on mount, so fake its first scheduled tick too.
  using _timers = fakeTimers();
  vi.setSystemTime(NOW);
  const onRender = vi.fn();
  await using screen = await render(
    <Profiler id="setup" onRender={onRender}>
      {card(snapshot({}))}
    </Profiler>,
  );
  const initialRenders = onRender.mock.calls.length;
  // Assert synchronously: expect.element polls on timers these tests fake.
  const section = screen.getByRole("region", { name: "Worktree setup" });

  expect(section.element().textContent).toContain("Fetch base branch3.0s");
  expect(section.element().textContent).toContain("Check out files7.0s");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(section.element().textContent).toContain("Fetch base branch3.0s");
  expect(section.element().textContent).toContain("Check out files12s");
  expect(onRender).toHaveBeenCalledTimes(initialRenders);
});

it("stops a stage interrupted by the setup ending at the setup's end", async () => {
  // The clock subscribes on mount, so fake its first scheduled tick too.
  using _timers = fakeTimers();
  vi.setSystemTime(NOW);
  const failed = snapshot({ phase: "failed", endedAt: "2026-10-26T12:00:05.000Z" });
  await using screen = await render(card(failed));
  const section = screen.getByRole("region", { name: "Worktree setup" });

  expect(section.element().textContent).toContain("Check out files2.0s");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(section.element().textContent).toContain("Check out files2.0s");
});
