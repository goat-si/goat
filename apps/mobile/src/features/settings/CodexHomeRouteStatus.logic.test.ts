import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

// The production component exports these decisions; native view modules are not needed here.
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() }, View: "View" }));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: vi.fn(),
  useEnvironmentScope: vi.fn(),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: vi.fn() }));
vi.mock("./components/SettingsActionRow", () => ({ SettingsActionRow: "SettingsActionRow" }));
import { buildDefaultCodexRouteMutation, includesProviderAccount } from "./CodexHomeRouteStatus";

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
});
