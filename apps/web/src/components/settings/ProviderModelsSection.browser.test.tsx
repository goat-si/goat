import { ProviderDriverKind, ProviderInstanceId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act } from "../../../test/render";

import { render } from "../../../test/render";
import { ProviderModelsSection } from "./ProviderModelsSection";

it("lists a favorite the provider no longer reports so it can be unstarred", async () => {
  const onToggleFavorite = vi.fn();
  await using screen = await render(
    <ProviderModelsSection
      instanceId={ProviderInstanceId.make("claude")}
      driverKind={ProviderDriverKind.make("claude")}
      models={[]}
      customModels={[]}
      canManageCustomModels
      hiddenModels={[]}
      favoriteModels={["retired-model"]}
      modelOrder={[]}
      onChange={() => {}}
      onHiddenModelsChange={() => {}}
      onFavoriteModelsChange={() => {}}
      onToggleFavorite={onToggleFavorite}
      onModelOrderChange={() => {}}
    />,
  );
  await screen.getByRole("button", { name: "Remove retired-model from favorites" }).click();
  expect(onToggleFavorite).toHaveBeenCalledWith("retired-model");
});

it("keeps a custom model draft until a save succeeds and ignores a late result after cancel", async () => {
  let resolveSave!: (saved: boolean) => void;
  const pending = new Promise<boolean>((resolve) => {
    resolveSave = resolve;
  });
  const onChange = vi.fn(() => pending);
  await using screen = await render(
    <ProviderModelsSection
      instanceId={ProviderInstanceId.make("codex")}
      driverKind={ProviderDriverKind.make("codex")}
      models={[]}
      customModels={[]}
      canManageCustomModels
      hiddenModels={[]}
      favoriteModels={[]}
      modelOrder={[]}
      onChange={onChange}
      onHiddenModelsChange={() => {}}
      onFavoriteModelsChange={() => {}}
      onToggleFavorite={() => {}}
      onModelOrderChange={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Add custom model" }));
  await userEvent.type(screen.getByRole("textbox"), "model-one");
  await userEvent.click(screen.getByRole("button", { name: "Add", exact: true }));
  await expect.element(screen.getByRole("textbox")).toHaveValue("model-one");
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await userEvent.click(screen.getByRole("button", { name: "Add custom model" }));
  await userEvent.type(screen.getByRole("textbox"), "model-two");
  await act(async () => {
    resolveSave(true);
    await pending;
  });
  await expect.element(screen.getByRole("textbox")).toHaveValue("model-two");
});

it("keeps a custom model draft when persistence fails", async () => {
  const onChange = vi.fn().mockResolvedValue(false);
  await using screen = await render(
    <ProviderModelsSection
      instanceId={ProviderInstanceId.make("codex")}
      driverKind={ProviderDriverKind.make("codex")}
      models={[]}
      customModels={[]}
      canManageCustomModels
      hiddenModels={[]}
      favoriteModels={[]}
      modelOrder={[]}
      onChange={onChange}
      onHiddenModelsChange={() => {}}
      onFavoriteModelsChange={() => {}}
      onToggleFavorite={() => {}}
      onModelOrderChange={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Add custom model" }));
  await userEvent.type(screen.getByRole("textbox"), "model-one");
  await userEvent.click(screen.getByRole("button", { name: "Add", exact: true }));
  await expect.element(screen.getByRole("textbox")).toHaveValue("model-one");
});

it("closes a custom model draft after the server confirms it", async () => {
  const onChange = vi.fn().mockResolvedValue(true);
  await using screen = await render(
    <ProviderModelsSection
      instanceId={ProviderInstanceId.make("codex")}
      driverKind={ProviderDriverKind.make("codex")}
      models={[]}
      customModels={[]}
      canManageCustomModels
      hiddenModels={[]}
      favoriteModels={[]}
      modelOrder={[]}
      onChange={onChange}
      onHiddenModelsChange={() => {}}
      onFavoriteModelsChange={() => {}}
      onToggleFavorite={() => {}}
      onModelOrderChange={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Add custom model" }));
  await userEvent.type(screen.getByRole("textbox"), "model-one");
  await userEvent.click(screen.getByRole("button", { name: "Add", exact: true }));
  await expect.element(screen.getByRole("button", { name: "Add custom model" })).toBeVisible();
});
