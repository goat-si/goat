import type { SpeechModelList } from "@goat/contracts";

type Model = (typeof SpeechModelList.Type.models)[number];
export function filterSpeechModels(
  models: readonly Model[],
  search: string,
  installedOnly: boolean,
  sort: "recommended" | "size" | "name",
) {
  const query = search.trim().toLocaleLowerCase();
  return models
    .filter(
      (model) =>
        (!installedOnly || model.installed) &&
        (!query || `${model.name} ${model.description}`.toLocaleLowerCase().includes(query)),
    )
    .toSorted((a, b) => {
      if (sort === "size") return a.size - b.size || a.name.localeCompare(b.name);
      if (sort === "name") return a.name.localeCompare(b.name);
      return (
        Number(b.selected) - Number(a.selected) ||
        Number(b.installed) - Number(a.installed) ||
        a.name.localeCompare(b.name)
      );
    });
}

export function chooseSetupSpeechModel(models: readonly Model[], preferred: readonly string[]) {
  for (const locale of preferred) {
    const language = locale.toLowerCase().split(/[-_]/)[0];
    if (!language) continue;
    const capable = models.filter((model) =>
      model.languages?.some((entry) => entry.toLowerCase().split(/[-_]/)[0] === language),
    );
    const match =
      capable.find((model) => model.selected) ??
      capable.find((model) => model.recommended) ??
      capable[0];
    if (match) return match;
  }
  return undefined;
}
