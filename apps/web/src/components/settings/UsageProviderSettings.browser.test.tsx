import { EnvironmentId, ServerSettings } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

vi.mock(import("../../env"), () => ({ isSecretsFeatureEnabled: true, isElectron: false }));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: ((_id: unknown, selector: (settings: unknown) => unknown) =>
    selector({
      secretProviders: {
        vault: { kind: "one_password", label: "Work", config: { account: "team" } },
      },
    })) as never,
  useUpdateEnvironmentSettings: vi.fn(),
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => vi.fn()) as never,
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const config = Atom.make({ secretReferences: true, environment: { platform: { os: "linux" } } });
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => config) as never },
  };
});

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { UsageProviderSettings } from "./UsageProviderSettings";

const decodeSettings = Schema.decodeSync(ServerSettings);

it("repairs a saved hub reference without discarding it before replacement", async () => {
  const update = vi.fn();
  vi.mocked(useUpdateEnvironmentSettings).mockReturnValue(update);
  const sources = decodeSettings({
    usageLimitSources: {
      hub: {
        kind: "cliproxy",
        url: "https://hub.example",
        managementKey: "",
        managementKeyReference: { provider: "removed", reference: "op://work/item/token" },
        enabled: true,
      },
    },
  }).usageLimitSources;
  await using screen = await render(
    <UsageProviderSettings
      environmentId={EnvironmentId.make("fixture")}
      environmentLabel="Fixture"
      sources={sources}
      cursorKeychainUsageEnabled={false}
      readOnly={false}
    />,
  );
  await expect.element(screen.getByRole("alert")).toBeVisible();
  await expect
    .element(screen.getByRole("textbox", { name: "Secret reference" }))
    .toHaveValue("op://work/item/token");
  await userEvent.click(screen.getByRole("combobox", { name: "Secret source" }));
  await userEvent.click(screen.getByRole("option", { name: "Stored value" }));
  expect(update).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await userEvent.click(screen.getByRole("combobox", { name: "Secret source" }));
  await userEvent.click(screen.getByRole("option", { name: "Work" }));
  await userEvent.fill(
    screen.getByRole("textbox", { name: "Secret reference" }),
    "op://work/new/token",
  );
  await userEvent.keyboard("{Enter}");
  expect(update).toHaveBeenCalledWith({
    usageLimitSources: {
      hub: expect.objectContaining({
        managementKeyReference: { provider: "vault", reference: "op://work/new/token" },
      }),
    },
  });
});
