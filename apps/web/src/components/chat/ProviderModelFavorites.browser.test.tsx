import { ProviderDriverKind, ProviderInstanceId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import "~/index.css";
import { render } from "../../../test/render";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderModelPicker } from "./ProviderModelPicker";
vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentModelPreferences: () => ({
    favorites: [{ provider: ProviderInstanceId.make("claude"), model: "claude" }],
    providerModelPreferences: {},
  }),
  useToggleEnvironmentModelFavorite: () => async () => {},
}));
it("opens on the active provider when every favorite belongs to a disabled provider", async () => {
  const entries = deriveProviderInstanceEntries(
    ["Codex", "Claude"].map((name) => ({
      instanceId: ProviderInstanceId.make(name.toLowerCase()),
      driver: ProviderDriverKind.make(name.toLowerCase()),
      enabled: name === "Codex",
      installed: true,
      version: null,
      status: "ready" as const,
      auth: { status: "authenticated" as const },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [
        { slug: name.toLowerCase(), name: `${name} model`, isCustom: false, capabilities: {} },
      ],
      slashCommands: [],
      skills: [],
    })),
  );
  const [codex] = entries;

  await using screen = await render(
    <ProviderModelPicker
      environmentId={null}
      activeInstanceId={codex!.instanceId}
      model="codex"
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={new Map(entries.map((entry) => [entry.instanceId, entry.models]))}
      triggerAriaLabel="Choose model"
      onInstanceModelChange={() => {}}
    />,
  );
  await screen.getByRole("button", { name: "Choose model" }).click();
  await expect.element(page.getByRole("option", { name: /Codex model/ })).toBeVisible();
});
