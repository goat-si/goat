import { EnvironmentId, ThreadId } from "@goat/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ restore: vi.fn() }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({ _tag: "Success", value: { state: "cleaned" } }),
}));
vi.mock("@goat/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: () => new Error("Snapshot conflict"),
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: { refresh: vi.fn() } }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { threadWorkspaceStatus: () => ({}), restoreThreadWorkspace: {} },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.restore }));
import { ThreadWorkspaceBanner } from "./ThreadWorkspaceBanner";

it("offers a fresh worktree when restoring fails", async () => {
  mocks.restore.mockResolvedValue({ _tag: "Failure" });
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(() =>
    root.render(
      <ThreadWorkspaceBanner
        environmentId={EnvironmentId.make("local")}
        threadId={ThreadId.make("thread")}
      />,
    ),
  );
  await act(async () => {
    container.querySelector("button")?.click();
  });
  expect(container.textContent).toContain("Snapshot conflict");
  expect(container.textContent).toContain("Start in a new worktree");
  await act(() => root.unmount());
});
