import { expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "./atom-registry";

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: Parameters<typeof appAtomRegistry.get>[0]) => appAtomRegistry.get(atom),
}));
vi.mock("./vcs", () => ({ vcsActionManager: {} }));

import {
  dismissGitActionResult,
  showGitActionResult,
  useGitActionResultNotification,
} from "./use-vcs-action-state";

const shown = () => useGitActionResultNotification().result?.type ?? null;

it("keeps a failed Git action's message until the person dismisses it, and clears a success after 5 seconds", () => {
  vi.useFakeTimers();
  try {
    showGitActionResult({ type: "error", title: "Git action failed", description: "Refused." });
    vi.advanceTimersByTime(60_000);
    const failure = shown();
    dismissGitActionResult();
    const dismissed = shown();
    showGitActionResult({ type: "success", title: "Pushed" });
    const success = shown();
    vi.advanceTimersByTime(5_000);

    expect([failure, dismissed, success, shown()]).toEqual(["error", null, "success", null]);
  } finally {
    vi.useRealTimers();
  }
});
