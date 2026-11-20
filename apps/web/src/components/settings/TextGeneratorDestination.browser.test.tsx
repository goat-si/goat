import { ProviderInstanceId, SecretProviderId, type ServerSettingsPatch } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { TextGeneratorSettings } from "./TextGeneratorSettings";

it("asks for a key again and drops the old reference when the destination changes", async () => {
  const onPatch = vi.fn(async (_patch: ServerSettingsPatch) => true);
  const id = ProviderInstanceId.make("api");
  await using screen = await render(
    <TextGeneratorSettings
      generators={{
        [id]: {
          kind: "openaiCompatible",
          baseUrl: "https://old.example/v1",
          model: "small",
          enabled: true,
          apiKey: {
            provider: SecretProviderId.make("personal"),
            reference: "op://vault/item/field",
          },
        },
      }}
      canManage
      canSelect
      onPatch={onPatch}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  const url = screen.getByRole("textbox", { name: "API base URL" });
  await userEvent.clear(url);
  await userEvent.type(url, "https://new.example/v1");
  await expect
    .element(screen.getByText("Re-enter the API key for the new address."))
    .toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Save text generator" }));
  await vi.waitFor(() => expect(onPatch).toHaveBeenCalledOnce());
  expect(onPatch.mock.calls[0]?.[0]).toMatchObject({
    textGenerators: { [id]: { baseUrl: "https://new.example/v1", apiKey: "" } },
  });
});
