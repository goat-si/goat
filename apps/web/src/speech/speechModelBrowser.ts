import type { SpeechBenchmarkTier, SpeechModelList } from "@goat/contracts";
import { recommendSpeechModel } from "@goat/shared/speechRecommendation";

type Model = (typeof SpeechModelList.Type.models)[number];
export function filterSpeechModels(
  models: readonly Model[],
  search: string,
  installedOnly: boolean,
  sort: "recommended" | "size" | "name" | "speed",
  tier?: SpeechBenchmarkTier,
  language?: string,
) {
  const query = search.trim().toLocaleLowerCase();
  const recommended = recommendSpeechModel(models, language ?? "", tier);
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
        (recommended ? Number(b.id === recommended) - Number(a.id === recommended) : 0) ||
        Number(b.recommended === true) - Number(a.recommended === true) ||
        a.name.localeCompare(b.name)
      );
    });
}
