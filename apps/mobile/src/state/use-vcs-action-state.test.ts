import { expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "./atom-registry";

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: Parameters<typeof appAtomRegistry.get>[0]) => appAtomRegistry.get(atom),
}));
vi.mock("./vcs", () => ({ vcsActionManager: {} }));
vi.mock("./use-thread-selection", () => ({ useThreadSelection: () => ({ selectedThread: null }) }));

import {
  dismissGitActionResult,
  dismissThreadGitActionResult,
  showGitActionResult,
  useGitActionResultNotification,
} from "./use-vcs-action-state";

const threadA = { environmentId: "environment-1", threadId: "thread-a" };
const threadB = { environmentId: "environment-1", threadId: "thread-b" };
const shown = (thread = threadA) => useGitActionResultNotification(thread).result?.type ?? null;

it("keeps a failed Git action's message until the person dismisses it, and clears a success after 5 seconds", () => {
  vi.useFakeTimers();
  try {
    showGitActionResult(
      { type: "error", title: "Git action failed", description: "Refused." },
      threadA,
    );
    vi.advanceTimersByTime(60_000);
    const failure = shown();
    dismissGitActionResult();
    const dismissed = shown();
    showGitActionResult({ type: "success", title: "Pushed" }, threadA);
    const success = shown();
    vi.advanceTimersByTime(5_000);

    expect([failure, dismissed, success, shown()]).toEqual(["error", null, "success", null]);
  } finally {
    vi.useRealTimers();
  }
});

it("shows a thread's failure only on that thread, which another thread's new action leaves in place", () => {
  showGitActionResult(
    { type: "error", title: "Git action failed", description: "Refused." },
    threadA,
  );
  const onB = shown(threadB);
  dismissThreadGitActionResult(threadB);
  const onAAfterB = shown(threadA);
  dismissThreadGitActionResult(threadA);

  expect([onB, onAAfterB, shown(threadA)]).toEqual([null, "error", null]);
});

it("clears a failure when its banner's dismiss is called as an event handler, with the event", () => {
  showGitActionResult(
    { type: "error", title: "Git action failed", description: "Refused." },
    threadA,
  );
  const onDismiss: (event: unknown) => void = dismissGitActionResult;
  onDismiss({ nativeEvent: {} });

  expect(shown(threadA)).toBeNull();
});
