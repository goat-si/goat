import type { SDKModel } from "@cursor/sdk";
import type { ServerProviderModel, ProviderOptionDescriptor } from "@goat2/contracts-rs";

// v1 status.ts:88-188: surface the SDK's parameters as GOAT model options.
export function cursorCatalog(models: ReadonlyArray<SDKModel>): ServerProviderModel[] {
  const seen = new Set<string>();
  return models.flatMap(model => {
    const slug = model.id.trim(), name = model.displayName.trim();
    if (!slug || !name || seen.has(slug)) return [];
    seen.add(slug);
    const ids = new Set<string>();
    const parameters = [...(model.parameters ?? [])].sort((a, b) => priority(a.id) - priority(b.id));
    const optionDescriptors: ProviderOptionDescriptor[] = [];
    for (const parameter of parameters) {
      const native = parameter.id.trim();
      const id = ({ context: "contextWindow", fast: "fastMode" } as Record<string, string>)[native] ?? native;
      if (!id || ids.has(id)) continue;
      const values = parameter.values.flatMap(v => v.value.trim() ? [{ id: v.value.trim(), label: v.displayName?.trim() || v.value.trim() }] : []);
      if (!values.length) continue;
      ids.add(id);
      const label = parameter.displayName?.trim() || id.split(/[\s_-]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
      const current = model.variants?.find(v => v.isDefault)?.params.find(p => p.id === native)?.value;
      const normalized = new Set(values.map(v => v.id.toLowerCase()));
      if (values.length === 2 && normalized.has("true") && normalized.has("false")) {
        optionDescriptors.push({ type: "boolean", id, label, ...(current === "true" || current === "false" ? { currentValue: current === "true" } : {}) });
      } else {
        optionDescriptors.push({ type: "select", id, label, options: values.map(v => ({ ...v, ...(v.id === current ? { isDefault: true } : {}) })) });
      }
    }
    const aliases = model.aliases?.map(a => a.trim()).filter(Boolean) ?? [];
    return [{ slug, name, ...(aliases.length ? { aliases } : {}), isCustom: false, capabilities: { optionDescriptors } }];
  });
}
function priority(id: string): number {
  switch (id) { case "effort": case "reasoning": return 0; case "context": return 1; case "fast": return 2; case "thinking": return 3; default: return 4; }
}
