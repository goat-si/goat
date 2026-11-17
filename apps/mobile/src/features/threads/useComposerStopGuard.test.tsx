import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { useComposerStopGuard } from "./useComposerStopGuard";

type Guard = ReturnType<typeof useComposerStopGuard>;

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const onStop = vi.fn();
  const latest: { guard: Guard | null } = { guard: null };
  const report = (guard: Guard) => {
    latest.guard = guard;
  };
  function Harness(props: {
    canStop: boolean;
    runId: string | null;
    owner: string;
    report: (guard: Guard) => void;
  }) {
    const { canStop, runId, owner } = props;
    props.report(useComposerStopGuard({ canStop, runId, owner, canOperateThread: true, onStop }));
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const render = (canStop: boolean, runId: string | null = "run-a", owner = "thread-1") =>
    act(() =>
      root.render(<Harness canStop={canStop} runId={runId} owner={owner} report={report} />),
    );
  render(true);
  return {
    onStop,
    render,
    guard: () => latest.guard!,
    [Symbol.dispose]: () => act(() => root.unmount()),
  };
}

it("a second tap on Stop does not resume the run it just stopped", () => {
  vi.useFakeTimers();
  using screen = setup();
  act(() => screen.guard().stop());
  act(() => screen.guard().stop());
  expect(screen.onStop).toHaveBeenCalledTimes(1);
  expect(screen.guard()).toMatchObject({ stopDisabled: true, stopLabel: "Stopping agent" });

  // The stop lands: Resume takes Stop's place but ignores the tap meant for Stop.
  screen.render(false);
  expect(screen.guard()).toMatchObject({ showStop: false, replacementBlocked: true });
  act(() => vi.advanceTimersByTime(500));
  expect(screen.guard().replacementBlocked).toBe(false);
  vi.useRealTimers();
});

it("Stop can be tapped again when a stop never lands", () => {
  vi.useFakeTimers();
  using screen = setup();
  act(() => screen.guard().stop());
  act(() => vi.advanceTimersByTime(10_000));
  expect(screen.guard()).toMatchObject({ showStop: true, stopDisabled: false });
  act(() => screen.guard().stop());
  expect(screen.onStop).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});

it("a new run's Stop is live at once after Stop was tapped on the previous run", () => {
  using screen = setup();
  act(() => screen.guard().stop());
  screen.render(true, "run-b");
  expect(screen.guard()).toMatchObject({
    showStop: true,
    stopDisabled: false,
    stopLabel: "Stop agent",
  });
});

it("a stop tapped in one thread does not carry over when the composer shows another thread", () => {
  using screen = setup();
  act(() => screen.guard().stop());
  screen.render(false, null, "thread-2");
  expect(screen.guard()).toMatchObject({ showStop: false, replacementBlocked: false });
  screen.render(true, "run-c", "thread-2");
  expect(screen.guard()).toMatchObject({ stopDisabled: false, stopLabel: "Stop agent" });
});
