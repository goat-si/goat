import { DEFAULT_SERVER_SETTINGS, EnvironmentId } from "@goat/contracts";
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
        storageCleanup: {
          worktreeKeepRecent: null,
          worktreeAfterDays: null,
          worktreeOnArchive: false,
        },
      },
    },
  });
  await act(() => root.unmount());
});
