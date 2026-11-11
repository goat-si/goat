import type { SpeechBenchmarkTier, SpeechModelList } from "@goat/contracts";

type Model = (typeof SpeechModelList.Type.models)[number];
export function filterSpeechModels(
  models: readonly Model[],
  search: string,
  installedOnly: boolean,
  sort: "recommended" | "size" | "name" | "speed",
  tier?: SpeechBenchmarkTier,
) {
  const query = search.trim().toLocaleLowerCase();
  return models
    .filter(
      (model) =>
        (!installedOnly || model.installed) &&
        (!query || `${model.name} ${model.description}`.toLocaleLowerCase().includes(query)),
    )
    .toSorted((a, b) => {
      if (sort === "speed" && tier !== undefined) {
        return (
          (a.benchmark?.[tier] ?? Infinity) - (b.benchmark?.[tier] ?? Infinity) ||
          a.name.localeCompare(b.name)
        );
      }
      if (sort === "size") return a.size - b.size || a.name.localeCompare(b.name);
      if (sort === "name") return a.name.localeCompare(b.name);
      return (
        Number(b.selected) - Number(a.selected) ||
        Number(b.installed) - Number(a.installed) ||
        Number(b.recommended === true) - Number(a.recommended === true) ||
        a.name.localeCompare(b.name)
      );
    });
}
