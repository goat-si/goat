import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@goat/contracts";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@goat/contracts/settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const persistenceMocks = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({ persistence: persistenceMocks }),
}));

import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  ensureClientSettingsHydrated,
  getClientSettings,
  mergeEnvironmentSettings,
  persistClientSettingsPatch,
  persistClientSettingsUpdate,
  prepareModelPreferencesPatch,
  resolveEnvironmentIdentificationMode,
} from "./useSettings";
import { resolveSidebarViewIsProjects } from "../components/Sidebar.logic";
import { applyServerSettingsPatch } from "@goat/shared/serverSettings";

beforeEach(() => {
  persistenceMocks.getClientSettings.mockReset().mockResolvedValue(null);
  persistenceMocks.setClientSettings.mockReset().mockResolvedValue(undefined);
  __resetClientSettingsPersistenceForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("client settings hydration", () => {
  const savedSettings = {
    ...DEFAULT_CLIENT_SETTINGS,
    timestampFormat: "12-hour" as const,
    favorites: [{ provider: ProviderInstanceId.make("codex_work"), model: "gpt-5.6" }],
  };
  const onboardingCompletedAt = "2026-09-05T12:00:00.000Z";
  const complete = (current: ClientSettings) => ({ ...current, onboardingCompletedAt });

  it("waits for saved model preferences before applying the first server edit", async () => {
    const provider = ProviderInstanceId.make("codex_work");
    let finishRead!: (settings: ClientSettings) => void;
    persistenceMocks.getClientSettings.mockReturnValueOnce(
      new Promise((resolve) => {
        finishRead = resolve;
      }),
    );
    const patch = prepareModelPreferencesPatch(DEFAULT_SERVER_SETTINGS, {
      setModelFavorites: [{ provider, model: "new", favorite: true }],
      setModelsHidden: [{ provider, model: "new", hidden: true }],
    });
    expect(getClientSettings()).toBe(DEFAULT_CLIENT_SETTINGS);
    finishRead({
      ...savedSettings,
      providerModelPreferences: {
        [provider]: { hiddenModels: ["saved-hidden"], modelOrder: ["saved-order"] },
      },
    });
    const edited = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, await patch);
    expect(edited.favorites).toEqual([...savedSettings.favorites, { provider, model: "new" }]);
    expect(edited.providerModelPreferences?.[provider]).toEqual({
      hiddenModels: ["saved-hidden", "new"],
      modelOrder: ["saved-order"],
    });
  });

  it("does not prepare a model preference write after a failed legacy read", async () => {
    const failure = new Error("storage unavailable");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    persistenceMocks.getClientSettings.mockRejectedValueOnce(failure);
    await expect(
      prepareModelPreferencesPatch(DEFAULT_SERVER_SETTINGS, {
        setProviderModelOrder: { provider: ProviderInstanceId.make("codex_work"), modelOrder: [] },
      }),
    ).rejects.toBe(failure);
  });

  it("rejects completion after a failed read and preserves saved preferences on retry", async () => {
    const failure = new Error("storage unavailable");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    persistenceMocks.getClientSettings
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(savedSettings);

    await expect(persistClientSettingsUpdate(complete)).rejects.toBe(failure);
    expect(persistenceMocks.setClientSettings).not.toHaveBeenCalled();
    expect(getClientSettings()).toBe(DEFAULT_CLIENT_SETTINGS);

    const completedSettings = { ...savedSettings, onboardingCompletedAt };
    await expect(persistClientSettingsUpdate(complete)).resolves.toEqual(completedSettings);
    expect(persistenceMocks.setClientSettings).toHaveBeenCalledExactlyOnceWith(completedSettings);
    expect(persistenceMocks.getClientSettings).toHaveBeenCalledTimes(2);
  });

  it("holds patches until a pending read supplies the saved preferences", async () => {
    let finishRead!: (settings: ClientSettings) => void;
    persistenceMocks.getClientSettings.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    const persisted = new Promise<ClientSettings>((resolve) => {
      persistenceMocks.setClientSettings.mockImplementationOnce(async (settings) => {
        resolve(settings);
      });
    });

    const hydration = ensureClientSettingsHydrated();
    persistClientSettingsPatch({ wordWrap: false });
    expect(getClientSettings()).toBe(DEFAULT_CLIENT_SETTINGS);
    expect(persistenceMocks.setClientSettings).not.toHaveBeenCalled();

    finishRead(savedSettings);
    await hydration;
    await expect(persisted).resolves.toEqual({ ...savedSettings, wordWrap: false });
    expect(persistenceMocks.getClientSettings).toHaveBeenCalledOnce();
  });

  it("handles failed patch reads without writing and retries with the saved preferences", async () => {
    const failure = new Error("storage unavailable");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    persistenceMocks.getClientSettings.mockRejectedValue(failure);

    const hydration = ensureClientSettingsHydrated();
    const patch = persistClientSettingsPatch({ wordWrap: false });
    await Promise.all([
      expect(hydration).rejects.toBe(failure),
      expect(patch).rejects.toBe(failure),
    ]);
    expect(persistenceMocks.setClientSettings).not.toHaveBeenCalled();

    persistenceMocks.getClientSettings.mockResolvedValue(savedSettings);
    const persisted = new Promise<ClientSettings>((resolve) => {
      persistenceMocks.setClientSettings.mockImplementationOnce(async (settings) => {
        resolve(settings);
      });
    });
    persistClientSettingsPatch({ wordWrap: false });

    await expect(persisted).resolves.toEqual({ ...savedSettings, wordWrap: false });
  });

  it("preserves patch order across hydration and a blocked completion write", async () => {
    let finishRead!: (settings: ClientSettings) => void;
    const read = new Promise<ClientSettings>((resolve) => {
      finishRead = resolve;
    });
    persistenceMocks.getClientSettings.mockReturnValue(read);
    let finishCompletionWrite!: () => void;
    const blockedWrite = new Promise<void>((resolve) => {
      finishCompletionWrite = resolve;
    });
    let signalCompletionWrite!: () => void;
    const completionWriteStarted = new Promise<void>((resolve) => {
      signalCompletionWrite = resolve;
    });
    let durableSettings: ClientSettings = savedSettings;
    const persist = vi
      .fn<(settings: ClientSettings) => Promise<void>>()
      .mockImplementationOnce(async (settings) => {
        signalCompletionWrite();
        await blockedWrite;
        durableSettings = settings;
      })
      .mockImplementation(async (settings) => {
        durableSettings = settings;
      });

    const completion = persistClientSettingsUpdate(complete, persist);
    const olderPatch = persistClientSettingsPatch({ wordWrap: false }, persist);
    expect(getClientSettings()).toBe(DEFAULT_CLIENT_SETTINGS);
    finishRead(savedSettings);
    await completionWriteStarted;
    const newerPatch = persistClientSettingsPatch({ wordWrap: true }, persist);
    expect(getClientSettings().wordWrap).toBe(true);
    const finalWrite = persistClientSettingsUpdate((current) => current, persist);

    finishCompletionWrite();
    await Promise.all([completion, olderPatch, newerPatch, finalWrite]);
    expect(persist.mock.calls.map(([settings]) => settings.wordWrap)).toEqual([
      true,
      false,
      true,
      true,
    ]);

    const expected = { ...savedSettings, onboardingCompletedAt, wordWrap: true };
    expect(getClientSettings()).toEqual(expected);
    expect(durableSettings).toEqual(expected);
  });
});

describe("persistClientSettingsPatch", () => {
  it("publishes immediately and rolls back only failed keys before the next write", async () => {
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    const failure = new Error("disk full");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let rejectWrite!: (error: Error) => void;
    persistenceMocks.setClientSettings.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectWrite = reject;
      }),
    );

    const failed = persistClientSettingsPatch({ wordWrap: false });
    expect(getClientSettings().wordWrap).toBe(false);
    await Promise.resolve();
    const later = persistClientSettingsPatch({ snapShotFlash: false });
    expect(getClientSettings()).toMatchObject({ wordWrap: false, snapShotFlash: false });
    expect(persistenceMocks.setClientSettings).toHaveBeenCalledTimes(1);

    const rejection = expect(failed).rejects.toBe(failure);
    rejectWrite(failure);
    await rejection;
    await later;
    expect(getClientSettings()).toEqual({ ...DEFAULT_CLIENT_SETTINGS, snapShotFlash: false });
    expect(persistenceMocks.setClientSettings).toHaveBeenLastCalledWith(getClientSettings());
  });

  it("does not roll back a newer value for a key from a failed patch", async () => {
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    const failure = new Error("disk full");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let rejectWrite!: (error: Error) => void;
    persistenceMocks.setClientSettings.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectWrite = reject;
      }),
    );
    const failed = persistClientSettingsPatch({ fontSizeTerminal: 16, wordWrap: false });
    await Promise.resolve();
    const later = persistClientSettingsPatch({ fontSizeTerminal: 18 });
    expect(getClientSettings().fontSizeTerminal).toBe(18);
    const rejection = expect(failed).rejects.toBe(failure);
    rejectWrite(failure);
    await rejection;
    await later;
    expect(getClientSettings()).toEqual({ ...DEFAULT_CLIENT_SETTINGS, fontSizeTerminal: 18 });
    expect(persistenceMocks.setClientSettings).toHaveBeenLastCalledWith(getClientSettings());
  });

  it("rejects failed patches, keeps the saved snapshot, and continues queued writes", async () => {
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    const failure = new Error("disk full");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    persistenceMocks.setClientSettings.mockRejectedValueOnce(failure);

    const failed = persistClientSettingsPatch({ wordWrap: false });
    const later = persistClientSettingsPatch({ snapShotFlash: false });
    await expect(failed).rejects.toBe(failure);
    await later;
    expect(getClientSettings()).toEqual({ ...DEFAULT_CLIENT_SETTINGS, snapShotFlash: false });
    expect(persistenceMocks.setClientSettings).toHaveBeenLastCalledWith({
      ...DEFAULT_CLIENT_SETTINGS,
      snapShotFlash: false,
    });
    await persistClientSettingsPatch({ wordWrap: false });
    expect(getClientSettings()).toMatchObject({ wordWrap: false, snapShotFlash: false });
  });

  it("waits for settings writes in request order", async () => {
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    let finishFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    persistenceMocks.setClientSettings.mockImplementationOnce(() => {
      markFirstStarted();
      return new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
    });

    const firstSettings = { ...DEFAULT_CLIENT_SETTINGS, snapShotFlash: false };
    const secondSettings = { ...firstSettings, snapShotPlaySound: false };
    const first = persistClientSettingsPatch({ snapShotFlash: false });
    await firstStarted;
    const second = persistClientSettingsPatch({ snapShotPlaySound: false });

    expect(persistenceMocks.setClientSettings).toHaveBeenCalledTimes(1);
    expect(getClientSettings()).toEqual(secondSettings);
    finishFirst();
    await Promise.all([first, second]);

    expect(persistenceMocks.setClientSettings).toHaveBeenNthCalledWith(1, firstSettings);
    expect(persistenceMocks.setClientSettings).toHaveBeenNthCalledWith(2, secondSettings);
  });
});

describe("persistClientSettingsUpdate", () => {
  it("publishes the update only after persistence succeeds", async () => {
    let finishPersistence!: () => void;
    const persistence = new Promise<void>((resolve) => {
      finishPersistence = resolve;
    });
    const setClientSettings = vi.fn(() => persistence);
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);

    const pending = persistClientSettingsUpdate(
      (current) => ({
        ...current,
        timestampFormat: "12-hour",
      }),
      setClientSettings,
    );

    expect(getClientSettings().timestampFormat).toBe(DEFAULT_CLIENT_SETTINGS.timestampFormat);
    finishPersistence();
    await expect(pending).resolves.toMatchObject({ timestampFormat: "12-hour" });
    expect(getClientSettings().timestampFormat).toBe("12-hour");
  });

  it("preserves a patch queued while an awaited update persists", async () => {
    let finishFirstPersistence!: () => void;
    let durableSettings = DEFAULT_CLIENT_SETTINGS;
    const firstPersistence = new Promise<void>((resolve) => {
      finishFirstPersistence = resolve;
    });
    const persist = vi
      .fn<(settings: typeof DEFAULT_CLIENT_SETTINGS) => Promise<void>>()
      .mockImplementationOnce((settings) =>
        firstPersistence.then(() => {
          durableSettings = settings;
        }),
      )
      .mockImplementation(async (settings) => {
        durableSettings = settings;
      });
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    const importedProfile = { id: "profile-import", name: "Imported", kind: "persistent" as const };

    const pending = persistClientSettingsUpdate(
      (current) => ({
        ...current,
        browserProfiles: [...current.browserProfiles, importedProfile],
      }),
      persist,
    );
    await Promise.resolve();
    const patch = persistClientSettingsPatch({ wordWrap: false }, persist);
    finishFirstPersistence();
    await Promise.all([pending, patch]);

    expect(persist).toHaveBeenCalledTimes(3);
    expect(persist.mock.calls[1]?.[0]).toMatchObject({
      wordWrap: false,
    });
    expect(persist.mock.calls[1]?.[0].browserProfiles).toContainEqual(importedProfile);
    expect(durableSettings.wordWrap).toBe(false);
    expect(durableSettings.browserProfiles).toContainEqual(importedProfile);
    expect(getClientSettings().wordWrap).toBe(false);
    expect(getClientSettings().browserProfiles).toContainEqual(importedProfile);
  });

  it("orders an awaited update after an older patch", async () => {
    let finishOldWrite!: () => void;
    let durableSettings = DEFAULT_CLIENT_SETTINGS;
    const oldWrite = new Promise<void>((resolve) => {
      finishOldWrite = resolve;
    });
    const persist = vi
      .fn<(settings: typeof DEFAULT_CLIENT_SETTINGS) => Promise<void>>()
      .mockImplementationOnce((settings) =>
        oldWrite.then(() => {
          durableSettings = settings;
        }),
      )
      .mockImplementation(async (settings) => {
        durableSettings = settings;
      });
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);

    void persistClientSettingsPatch({ wordWrap: false }, persist);
    const importedProfile = { id: "profile-import", name: "Imported", kind: "persistent" as const };
    const registration = persistClientSettingsUpdate(
      (current) => ({
        ...current,
        browserProfiles: [...current.browserProfiles, importedProfile],
      }),
      persist,
    );
    await Promise.resolve();
    expect(persist).toHaveBeenCalledTimes(1);

    finishOldWrite();
    await registration;

    expect(persist).toHaveBeenCalledTimes(2);
    expect(durableSettings.wordWrap).toBe(false);
    expect(durableSettings.browserProfiles).toContainEqual(importedProfile);
  });
});

describe("resolveEnvironmentIdentificationMode", () => {
  it.each(["artwork", "pill", "none"] as const)(
    "keeps %s hidden until client settings hydrate",
    (mode) => {
      expect(resolveEnvironmentIdentificationMode({ mode, settingsHydrated: false })).toBe("none");
    },
  );

  it.each([
    ["artwork", "pill"],
    ["pill", "pill"],
    ["none", "none"],
  ] as const)("resolves stored %s to %s", (mode, expected) => {
    expect(resolveEnvironmentIdentificationMode({ mode, settingsHydrated: true })).toBe(expected);
  });
});

describe("mergeEnvironmentSettings", () => {
  it("keeps server settlement settings when legacy client data contains retired keys", () => {
    const serverSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      sidebarAutoSettleAfterDays: 14,
      sidebarAutoSettleOnMerge: false,
    };
    const legacyClientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      sidebarAutoSettleAfterDays: 1,
      sidebarAutoSettleOnMerge: true,
    };

    const settings = mergeEnvironmentSettings(serverSettings, legacyClientSettings);

    expect(settings.sidebarAutoSettleAfterDays).toBe(14);
    expect(settings.sidebarAutoSettleOnMerge).toBe(false);
  });
});

describe("onboarding completion persistence", () => {
  it("keeps onboarding incomplete after a failed save and preserves preferences on retry", async () => {
    const failure = new Error("disk full");
    const persist = vi
      .fn<(settings: typeof DEFAULT_CLIENT_SETTINGS) => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined);
    const existingSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      timestampFormat: "12-hour" as const,
      favorites: [
        {
          provider: ProviderInstanceId.make("codex_work"),
          model: "gpt-5.6",
        },
      ],
    };
    __setClientSettingsForTests(existingSettings);
    const onboardingCompletedAt = "2026-09-01T12:00:00.000Z";
    const complete = (current: typeof DEFAULT_CLIENT_SETTINGS) => ({
      ...current,
      onboardingCompletedAt,
    });

    await expect(persistClientSettingsUpdate(complete, persist)).rejects.toBe(failure);
    expect(getClientSettings()).toBe(existingSettings);
    expect(getClientSettings().onboardingCompletedAt).toBeNull();

    const completedSettings = { ...existingSettings, onboardingCompletedAt };
    await expect(persistClientSettingsUpdate(complete, persist)).resolves.toEqual(
      completedSettings,
    );
    expect(getClientSettings()).toEqual(completedSettings);
    expect(persist).toHaveBeenLastCalledWith(completedSettings);
  });
});

describe("Projects view hydration policy", () => {
  it("holds the sidebar until settings resolve when no view was saved", () => {
    expect(
      resolveSidebarViewIsProjects({ status: "pending", value: true, synchronousValue: null }),
    ).toBeNull();
    expect(
      resolveSidebarViewIsProjects({ status: "retrying", value: false, synchronousValue: null }),
    ).toBeNull();
  });

  it.each([true, false])("paints a synchronous last view of %s before hydration", (value) => {
    expect(
      resolveSidebarViewIsProjects({ status: "pending", value: !value, synchronousValue: value }),
    ).toBe(value);
  });

  it.each([true, false])("preserves a hydrated choice of %s", (value) => {
    expect(resolveSidebarViewIsProjects({ status: "ready", value, synchronousValue: !value })).toBe(
      value,
    );
  });

  it("uses Activity with no saved settings", async () => {
    await ensureClientSettingsHydrated();
    expect(
      resolveSidebarViewIsProjects({
        status: "ready",
        value: getClientSettings().projectsSidebarEnabled,
        synchronousValue: null,
      }),
    ).toBe(false);
  });

  it("uses Activity after hydration fails and keeps a synchronous Projects choice", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    persistenceMocks.getClientSettings.mockRejectedValueOnce(new Error("read failed"));
    await expect(ensureClientSettingsHydrated()).rejects.toThrow("read failed");
    expect(
      resolveSidebarViewIsProjects({
        status: "failed",
        value: getClientSettings().projectsSidebarEnabled,
        synchronousValue: null,
      }),
    ).toBe(false);
    expect(
      resolveSidebarViewIsProjects({
        status: "failed",
        value: false,
        synchronousValue: true,
      }),
    ).toBe(true);
  });
});

it("uses the environment's model preferences after migration, including empty lists", () => {
  const client = {
    ...DEFAULT_CLIENT_SETTINGS,
    favorites: [{ provider: ProviderInstanceId.make("codex_work"), model: "old" }],
    providerModelPreferences: { codex_work: { hiddenModels: ["old"], modelOrder: [] } },
  };
  expect(mergeEnvironmentSettings(DEFAULT_SERVER_SETTINGS, client).favorites).toEqual(
    client.favorites,
  );
  const merged = mergeEnvironmentSettings(
    { ...DEFAULT_SERVER_SETTINGS, favorites: [], providerModelPreferences: {} },
    client,
  );
  expect(merged.favorites).toEqual([]);
  expect(merged.providerModelPreferences).toEqual({});
});
