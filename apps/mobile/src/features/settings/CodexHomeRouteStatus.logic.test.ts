import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

// The production component exports these decisions; native view modules are not needed here.
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() }, View: "View" }));
vi.mock("../../components/ui/AppText", () => ({ AppText: "Text" }));
vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: vi.fn(),
  useEnvironmentScope: vi.fn(),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: vi.fn() }));
vi.mock("./components/SettingsActionRow", () => ({ SettingsActionRow: "SettingsActionRow" }));
vi.mock("@react-navigation/native", () => ({ useNavigation: vi.fn() }));
import {
  buildDefaultCodexRouteMutation,
  confirmCodexRouteChange,
  includesProviderAccount,
} from "./CodexHomeRouteStatus";

const codex = ProviderDriverKind.make("codex");
describe("OpenCodex Home routing", () => {
  it("keeps Home routing reachable for the four adapters without in-app sign-in", () => {
    const noSignIn = { installed: false, setup: { canAuthenticate: false, canInstall: false } };
    expect(
      includesProviderAccount({
        ...noSignIn,
        driver: codex,
        codexRoute: { modelRoute: "opencodex" },
      }),
    ).toBe(true);
    for (const driver of ["codex", "claudeAgent", "opencode", "pi"])
      expect(
        includesProviderAccount({ ...noSignIn, driver: ProviderDriverKind.make(driver) }),
      ).toBe(true);
    expect(
      includesProviderAccount({ ...noSignIn, driver: ProviderDriverKind.make("cursor") }),
    ).toBe(false);
  });
  it("builds a default mutation for the selected environment without unlinking Home", () => {
    const instance: ProviderInstanceConfig = {
      driver: codex,
      displayName: "Work",
      enabled: true,
      environment: [{ name: "PROFILE", value: "work", sensitive: false }],
      config: {
        modelRoute: "opencodex",
        opencodexBaseUrl: "http://localhost:10101/v1",
        homePath: "/home/person/.codex",
        extensionOption: 42,
      },
    };
    expect(
      buildDefaultCodexRouteMutation(
        EnvironmentId.make("vps"),
        ProviderInstanceId.make("codex_home"),
        instance,
      ),
    ).toEqual({
      environmentId: "vps",
      input: {
        patch: {},
        providerInstanceMutation: {
          operation: "upsert",
          instanceId: "codex_home",
          instance: {
            ...instance,
            config: { ...(instance.config as Record<string, unknown>), modelRoute: "default" },
          },
          expectedInstance: instance,
        },
      },
    });
    expect(instance.config).toMatchObject({ modelRoute: "opencodex" });
  });
  it("changes only Home authentication on the selected environment's instance", () => {
    const instance: ProviderInstanceConfig = {
      driver: codex,
      displayName: "Child",
      config: { modelRoute: "opencodex", opencodexAuth: "openai", extensionOption: 42 },
    };
    const mutation = buildDefaultCodexRouteMutation(
      EnvironmentId.make("child"),
      ProviderInstanceId.make("child_codex"),
      instance,
      { opencodexAuth: "none" },
    );
    expect(mutation.environmentId).toBe("child");
    expect(mutation.input.providerInstanceMutation.instance).toEqual({
      ...instance,
      config: { modelRoute: "opencodex", opencodexAuth: "none", extensionOption: 42 },
    });
    expect(instance.config).toMatchObject({ opencodexAuth: "openai" });
  });
  it("refuses a confirmation after another device changed the route and keeps its settings", async () => {
    const opened: ProviderInstanceConfig = {
      driver: codex,
      config: { modelRoute: "opencodex", opencodexBaseUrl: "http://localhost:10100/v1" },
    };
    const latest: ProviderInstanceConfig = {
      driver: codex,
      config: { modelRoute: "default", opencodexBaseUrl: "http://localhost:10101/v1" },
    };
    const mutate = vi.fn<
      (mutation: ReturnType<typeof buildDefaultCodexRouteMutation>) => Promise<void>
    >(async () => undefined);
    for (const change of [{ opencodexAuth: "none" }, { modelRoute: "default" }] as const)
      await expect(
        confirmCodexRouteChange({
          environmentId: EnvironmentId.make("child"),
          instanceId: ProviderInstanceId.make("child_codex"),
          opened,
          readLatest: () => ({ instance: latest, supportsPreconditions: true }),
          change,
          mutate,
        }),
      ).rejects.toThrow("Settings changed on another device");
    expect(mutate).not.toHaveBeenCalled();
  });
  it("refuses a Home confirmation on a server that cannot enforce its precondition", async () => {
    const instance: ProviderInstanceConfig = {
      driver: codex,
      config: { modelRoute: "opencodex", opencodexAuth: "openai" },
    };
    const mutate = vi.fn(async () => undefined);
    await expect(
      confirmCodexRouteChange({
        environmentId: EnvironmentId.make("old"),
        instanceId: ProviderInstanceId.make("old_codex"),
        opened: instance,
        readLatest: () => ({ instance, supportsPreconditions: false }),
        change: { opencodexAuth: "none" },
        mutate,
      }),
    ).rejects.toThrow("Update GOAT on this machine to change Home authentication.");
    expect(mutate).not.toHaveBeenCalled();
  });
  it("refuses a confirmation when the server lost write preconditions after the Alert opened", async () => {
    const instance: ProviderInstanceConfig = {
      driver: codex,
      config: { modelRoute: "opencodex", opencodexAuth: "openai" },
    };
    const mutate = vi.fn(async () => undefined);
    await expect(
      confirmCodexRouteChange({
        environmentId: EnvironmentId.make("rolled_back"),
        instanceId: ProviderInstanceId.make("rolled_back_codex"),
        opened: instance,
        readLatest: () => ({ instance, supportsPreconditions: false }),
        change: { opencodexAuth: "none" },
        mutate,
      }),
    ).rejects.toThrow("Update GOAT on this machine to change Home authentication.");
    expect(mutate).not.toHaveBeenCalled();
  });
  it("applies only the confirmed authentication over the latest instance", async () => {
    const opened: ProviderInstanceConfig = {
      driver: codex,
      displayName: "Before",
      config: { modelRoute: "opencodex", opencodexAuth: "openai" },
    };
    const latest = { ...opened, displayName: "Renamed elsewhere" };
    const mutate = vi.fn<
      (mutation: ReturnType<typeof buildDefaultCodexRouteMutation>) => Promise<void>
    >(async () => undefined);
    await confirmCodexRouteChange({
      environmentId: EnvironmentId.make("child"),
      instanceId: ProviderInstanceId.make("child_codex"),
      opened,
      readLatest: () => ({ instance: latest, supportsPreconditions: true }),
      change: { opencodexAuth: "none" },
      mutate,
    });
    expect(mutate).toHaveBeenCalledExactlyOnceWith(
      buildDefaultCodexRouteMutation(
        EnvironmentId.make("child"),
        ProviderInstanceId.make("child_codex"),
        latest,
        { opencodexAuth: "none" },
      ),
    );
    // The server refuses the write if the instance changes between this check and its commit.
    expect(mutate.mock.calls[0]?.[0].input.providerInstanceMutation.expectedInstance).toBe(latest);
  });
});
