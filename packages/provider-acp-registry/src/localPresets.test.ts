import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ACP_LOCAL_PRESETS } from "./localPresets.ts";
import { AcpRegistrySettings } from "./settings.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);

it("decodes the Oh My Pi preset as local ACP settings", () => {
  const preset = ACP_LOCAL_PRESETS.find((entry) => entry.id === "omp");
  expect(preset).toBeDefined();
  if (!preset) throw new Error("Missing Oh My Pi preset");
  const settings = decodeSettings({
    source: "local",
    commandPath: preset.command,
    commandArgs: preset.args,
  });
  expect(settings).toMatchObject({
    source: "local",
    commandPath: "omp",
    commandArgs: ["acp", "--approval-mode", "always-ask"],
    enabled: true,
  });
});
