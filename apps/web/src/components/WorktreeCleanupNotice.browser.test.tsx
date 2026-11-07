import { render } from "../../test/render";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ respond: vi.fn(), toast: vi.fn() }));
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentIdentities: () => [{ environmentId: "env", label: "Machine" }] as never,
  useEnvironment: () =>
    ({
      connection: { phase: "connected" },
      serverConfig: { environment: { capabilities: { worktreeRestore: true } } },
    }) as never,
}));
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const report = Atom.make({
    _tag: "Success" as const,
    value: { worktreePreview: { id: "p1", plannedCount: 3, seenAt: null } },
  });
  const allowed = Atom.make(true);
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      storageCleanupReport: (() => report) as never,
      respondWorktreeCleanupPreview: {
        ...actual.serverEnvironment.respondWorktreeCleanupPreview,
        permissionAtom: () => allowed,
      },
    },
  };
});
vi.mock(import("../state/use-atom-command"), () => ({
  useAtomCommand: (() => state.respond) as never,
}));
vi.mock(import("./ui/toast"), async (original) => ({
  ...(await original()),
  toastManager: { add: state.toast } as never,
}));
import { WorktreeCleanupNotice } from "./WorktreeCleanupNotice";

it("marks each preview seen once across rerenders", async () => {
  state.respond.mockReset();
  state.toast.mockReset();
  await using screen = await render(<WorktreeCleanupNotice />);
  await screen.rerender(<WorktreeCleanupNotice />);
  expect(state.respond).toHaveBeenCalledTimes(1);
  expect(state.respond).toHaveBeenCalledWith({
    environmentId: "env",
    input: { previewId: "p1", response: "seen" },
  });
  expect(state.toast).toHaveBeenCalledTimes(1);
});
