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
import {
  buildDefaultCodexRouteMutation,
  confirmCodexRouteChange,
  includesProviderAccount,
} from "./CodexHomeRouteStatus";

const codex = ProviderDriverKind.make("codex");
describe("OpenCodex Home routing", () => {
  it("includes Home without in-app sign-in capability", () => {
    expect(
      includesProviderAccount({
        driver: codex,
        installed: false,
        setup: { canAuthenticate: false, canInstall: false },
        codexRoute: { modelRoute: "opencodex" },
      }),
    ).toBe(true);
    expect(
      includesProviderAccount({
        driver: codex,
        installed: false,
        setup: { canAuthenticate: false, canInstall: false },
        codexRoute: { modelRoute: "default" },
      }),
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
    const mutate = vi.fn(async () => undefined);
    for (const change of [{ opencodexAuth: "none" }, { modelRoute: "default" }] as const)
      await expect(
        confirmCodexRouteChange({
          environmentId: EnvironmentId.make("child"),
          instanceId: ProviderInstanceId.make("child_codex"),
          opened,
          readLatest: () => latest,
          change,
          mutate,
        }),
      ).rejects.toThrow("Settings changed on another device");
    expect(mutate).not.toHaveBeenCalled();
  });
  it("applies only the confirmed authentication over the latest instance", async () => {
    const opened: ProviderInstanceConfig = {
      driver: codex,
      displayName: "Before",
      config: { modelRoute: "opencodex", opencodexAuth: "openai" },
    };
    const latest = { ...opened, displayName: "Renamed elsewhere" };
    const mutate = vi.fn(async () => undefined);
    await confirmCodexRouteChange({
      environmentId: EnvironmentId.make("child"),
      instanceId: ProviderInstanceId.make("child_codex"),
      opened,
      readLatest: () => latest,
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
  });
});
