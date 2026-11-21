import { ProviderDriverKind, ProviderInstanceId, ServerProvider } from "@goat/contracts";
import { acpRegistryClient } from "@goat/provider-acp-registry/client";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { ProviderInstanceCard } from "./ProviderInstanceCard";

const decodeProvider = Schema.decodeSync(ServerProvider);

it.each([false, true])(
  "shows supported ACP custom model details (supported: %s)",
  async (supported) => {
    const instanceId = ProviderInstanceId.make("acp-model-test");
    const driver = ProviderDriverKind.make("acpRegistry");
    const instance = {
      driver,
      config: {
        agentId: "example",
        customModels: ["custom-x"],
        customModelDetails: [{ slug: "custom-x", name: "Friendly model" }],
      },
    };
    const provider = decodeProvider({
      instanceId,
      driver,
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "unknown" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [],
      ...(supported ? { supportsStructuredCustomModels: true } : {}),
    });
    await using screen = await render(
      <ProviderInstanceCard
        instanceId={instanceId}
        instance={instance}
        driverOption={acpRegistryClient}
        liveProvider={provider}
        mode="editor"
        onUpdate={vi.fn()}
        hiddenModels={[]}
        favoriteModels={[]}
        modelOrder={[]}
        onHiddenModelsChange={vi.fn()}
        onFavoriteModelsChange={vi.fn()}
        onToggleFavorite={vi.fn()}
        onModelOrderChange={vi.fn()}
      />,
    );
    await expect
      .element(screen.getByText(supported ? "Friendly model" : "custom-x", { exact: true }))
      .toBeVisible();
  },
);
