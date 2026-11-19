import type { CustomModelSetting } from "@goat/contracts";
import type { AcpRegistrySettings } from "./settings.ts";

export function resolveAcpCustomModels(
  settings: Pick<AcpRegistrySettings, "customModels" | "customModelDetails">,
): ReadonlyArray<CustomModelSetting> {
  const details = new Map((settings.customModelDetails ?? []).map((entry) => [entry.slug, entry]));
  return settings.customModels.map(
    (model) => details.get(typeof model === "string" ? model : model.slug) ?? model,
  );
}
