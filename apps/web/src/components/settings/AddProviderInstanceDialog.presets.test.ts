import { ACP_LOCAL_PRESETS } from "@goat/provider-acp-registry/localPresets";
import { expect, it } from "vite-plus/test";
import { localPresetDraft } from "./AddProviderInstanceDialog.presets";

it("fills the local command and display name from the Oh My Pi preset", () => {
  expect(localPresetDraft(ACP_LOCAL_PRESETS[0])).toEqual({
    label: "Oh My Pi",
    config: {
      source: "local",
      commandPath: "omp",
      commandArgs: ["acp", "--approval-mode", "always-ask"],
    },
  });
});
