import { DEFAULT_SERVER_SETTINGS, EnvironmentId, WORKTREE_CLEANUP_OFF } from "@goat/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  respond: vi.fn(),
  updateCommand: {},
  respondCommand: {},
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "permission"
      ? true
      : {
          _tag: "Success",
          value: { worktreePreview: { id: "p1", seenAt: "now", plannedCount: 3 } },
        },
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TextInput: () => null,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("./components/SettingsSection", () => ({
  SettingsSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("./components/SettingsSwitchRow", () => ({ SettingsSwitchRow: () => null }));
vi.mock("./components/SettingsActionRow", () => ({
  SettingsActionRow: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    updateSettings: Object.assign(mocks.updateCommand, { permissionAtom: () => "permission" }),
    storageCleanupReport: () => "report",
    respondWorktreeCleanupPreview: mocks.respondCommand,
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === mocks.updateCommand ? mocks.update : mocks.respond,
}));
import { WorktreeCleanupSection } from "./WorktreeCleanupSection";

it("turns off the three automatic cleanup rules", async () => {
  mocks.update.mockResolvedValue(AsyncResult.success(undefined));
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(() =>
    root.render(
      <WorktreeCleanupSection
        environmentId={EnvironmentId.make("local")}
        settings={DEFAULT_SERVER_SETTINGS.storageCleanup}
      />,
    ),
  );
  const button = [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent === "Turn off",
  );
  await act(() => button?.click());
  expect(mocks.update).toHaveBeenCalledWith({
    environmentId: "local",
    input: {
      patch: {
        storageCleanup: WORKTREE_CLEANUP_OFF,
      },
    },
  });
  await act(() => root.unmount());
});

it.each([
  ["Turn off", "update"],
  ["Clean up now", "respond"],
] as const)(
  "shows why %s could not reach the computer and clears it when pressed again (#3556)",
  async (label, command) => {
    mocks.update.mockReset();
    mocks.respond.mockReset();
    mocks[command]
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Studio is not connected."))))
      .mockResolvedValueOnce(AsyncResult.success(undefined));
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(() =>
      root.render(
        <WorktreeCleanupSection
          environmentId={EnvironmentId.make("local")}
          settings={DEFAULT_SERVER_SETTINGS.storageCleanup}
        />,
      ),
    );
    const button = () =>
      [...container.querySelectorAll("button")].find((entry) => entry.textContent === label);
    await act(async () => button()?.click());
    expect(container.textContent).toContain("Studio is not connected.");
    await act(async () => button()?.click());
    expect(mocks[command]).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("Studio is not connected.");
    await act(() => root.unmount());
  },
);
