import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@goat/contracts";
import { modelRef } from "./modelRef.ts";
import { openCode2ProviderModels } from "../status.ts";

describe("OpenCode default reasoning", () => {
  it("offers a Default choice and sends no variant while keeping a native default variant", () => {
    const models = openCode2ProviderModels({ customModels: [] }, [
      { providerID: "acme", id: "chat", name: "Chat", variants: [{ id: "low" }, { id: "high" }] },
    ]);
    const option = models[0]?.capabilities?.optionDescriptors?.find(
      (entry) => entry.id === "variant",
    );
    expect(option?.type === "select" && option.options.map((entry) => entry.id)).toEqual([
      "goat:default",
      "low",
      "high",
    ]);
    const selection = {
      instanceId: ProviderInstanceId.make("opencode"),
      model: "acme/chat",
      options: [{ id: "variant", value: "goat:default" }],
    };
    expect(modelRef(selection, undefined)?.variant).toBeUndefined();
    expect(
      modelRef({ ...selection, options: [{ id: "variant", value: "default" }] }, undefined)
        ?.variant,
    ).toBe("default");
  });
});
