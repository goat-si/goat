import { DEFAULT_SERVER_SETTINGS, EnvironmentId, WORKTREE_CLEANUP_OFF } from "@goat/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  respond: vi.fn(),
  alert: vi.fn(),
  updateCommand: {},
  respondCommand: {},
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: mocks.alert }));
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
  TextInput: ({
    accessibilityLabel,
    value,
    onChangeText,
    onEndEditing,
  }: {
    accessibilityLabel: string;
    value: string;
    onChangeText: (value: string) => void;
    onEndEditing: () => void;
  }) => (
    <input
      aria-label={accessibilityLabel}
      value={value}
      onChange={(event) => onChangeText(event.target.value)}
      onBlur={onEndEditing}
    />
  ),
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

const offline = () => AsyncResult.failure(Cause.fail(new Error("Studio is not connected.")));

async function mountSection() {
  mocks.update.mockReset();
  mocks.respond.mockReset();
  mocks.alert.mockReset();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(() =>
    root.render(
      <WorktreeCleanupSection
        environmentId={EnvironmentId.make("local")}
        settings={{ ...DEFAULT_SERVER_SETTINGS.storageCleanup, worktreeKeepRecent: 15 }}
      />,
    ),
  );
  const field = container.querySelector<HTMLInputElement>(
    'input[aria-label="Keep most recent worktrees"]',
  );
  if (!field) throw new Error("Missing field");
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  return {
    field,
    press: (label: string) =>
      act(async () =>
        [...container.querySelectorAll("button")]
          .find((entry) => entry.textContent === label)
          ?.click(),
      ),
    type: (text: string) =>
      act(async () => {
        field.focus();
        setValue?.call(field, text);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }),
    submit: () => act(async () => field.blur()),
    [Symbol.asyncDispose]: async () => {
      await act(() => root.unmount());
      container.remove();
    },
  };
}

it.each([
  ["Turn off", "update", "Could not save settings"],
  ["Clean up now", "respond", "Could not clean up worktrees"],
] as const)(
  "says why %s failed in an alert and sends it again when pressed again (#3556)",
  async (label, command, title) => {
    await using section = await mountSection();
    mocks[command]
      .mockResolvedValueOnce(offline())
      .mockResolvedValueOnce(AsyncResult.success(undefined));
    await section.press(label);
    expect(mocks.alert).toHaveBeenCalledExactlyOnceWith(title, "Studio is not connected.");
    await section.press(label);
    expect(mocks[command]).toHaveBeenCalledTimes(2);
    expect(mocks.alert).toHaveBeenCalledOnce();
  },
);

it("a failure on one control is still reported when another control is pressed (#3556)", async () => {
  await using section = await mountSection();
  mocks.respond.mockResolvedValueOnce(offline());
  mocks.update.mockResolvedValueOnce(AsyncResult.success(undefined));
  await section.press("Clean up now");
  await section.press("Turn off");
  expect(mocks.alert).toHaveBeenCalledExactlyOnceWith(
    "Could not clean up worktrees",
    "Studio is not connected.",
  );
});

it("puts a number back to the saved value when saving it fails (#3556)", async () => {
  await using section = await mountSection();
  mocks.update.mockResolvedValueOnce(offline());
  await section.type("40");
  await section.submit();
  expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
    environmentId: "local",
    input: { patch: { storageCleanup: { worktreeKeepRecent: 40 } } },
  });
  expect(mocks.alert).toHaveBeenCalledExactlyOnceWith(
    "Could not save settings",
    "Studio is not connected.",
  );
  expect(section.field.value).toBe("15");
});

it("leaving a number field without typing sends nothing and alerts nothing (#3556)", async () => {
  await using section = await mountSection();
  mocks.update.mockResolvedValue(offline());
  await act(async () => section.field.focus());
  await section.submit();
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.alert).not.toHaveBeenCalled();
});

it("retyping the saved number sends nothing (#3556)", async () => {
  await using section = await mountSection();
  mocks.update.mockResolvedValue(offline());
  await section.type("15");
  await section.submit();
  expect(mocks.update).not.toHaveBeenCalled();
  expect(section.field.value).toBe("15");
});

it("a number save that fails after the person typed again leaves the new typing (#3556)", async () => {
  await using section = await mountSection();
  const save = Promise.withResolvers<AsyncResult.AsyncResult<unknown, unknown>>();
  mocks.update.mockReturnValueOnce(save.promise);
  await section.type("40");
  await section.submit();
  await section.type("45");
  await act(async () => save.resolve(offline()));
  expect(section.field.value).toBe("45");
});

it("an older number save that fails does not reset a newer one (#3556)", async () => {
  await using section = await mountSection();
  const older = Promise.withResolvers<AsyncResult.AsyncResult<unknown, unknown>>();
  const newer = Promise.withResolvers<AsyncResult.AsyncResult<unknown, unknown>>();
  mocks.update.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  await section.type("40");
  await section.submit();
  await section.type("50");
  await section.submit();
  await act(async () => older.resolve(offline()));
  expect(section.field.value).toBe("50");
  await act(async () => newer.resolve(AsyncResult.success(undefined)));
  expect(section.field.value).toBe("50");
});
