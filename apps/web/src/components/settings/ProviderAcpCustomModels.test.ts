import { describe, expect, it } from "vite-plus/test";
import { encodeAcpCustomModels, readAcpCustomModels } from "./ProviderAcpCustomModels";

const models = [{ slug: "custom", name: "Friendly", capabilities: null }];

describe("ACP custom model settings", () => {
  it("writes strings only when the destination does not advertise structured settings", () => {
    const config = encodeAcpCustomModels(
      { agentId: "example", customModelDetails: [{ slug: "stale" }] },
      models,
      false,
    );
    expect(config).toEqual({ agentId: "example", customModels: ["custom"] });
    expect(readAcpCustomModels(config, false).map((entry) => entry.name)).toEqual(["custom"]);
  });
  it("preserves custom model options for a supporting destination", () => {
    const capabilities = {
      optionDescriptors: [
        {
          id: "effort",
          label: "Reasoning",
          type: "select" as const,
          options: [{ id: "high", label: "High", isDefault: true }],
        },
      ],
    };
    const config = encodeAcpCustomModels(
      {},
      [{ slug: "custom", name: "Friendly", capabilities }],
      true,
    );
    expect(readAcpCustomModels(config, true)[0]?.capabilities).toEqual(capabilities);
    expect(
      encodeAcpCustomModels(config, [{ slug: "custom", name: "Friendly", capabilities }], false),
    ).toEqual({ customModels: ["custom"] });
  });
  it("keeps legacy IDs and structured details when the destination supports them", () => {
    const config = encodeAcpCustomModels({ agentId: "example" }, models, true);
    expect(config).toEqual({
      agentId: "example",
      customModels: ["custom"],
      customModelDetails: [{ slug: "custom", name: "Friendly" }],
    });
    expect(readAcpCustomModels(config, true).map((entry) => entry.name)).toEqual(["Friendly"]);
  });
});
