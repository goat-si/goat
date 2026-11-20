type Model = {
  readonly id: string;
  readonly languages?: unknown;
  readonly accuracy?: unknown;
  readonly benchmark?: { readonly cpu: number | null; readonly accelerated: number | null };
};

export function recommendSpeechModel(
  models: readonly Model[],
  language: string,
  tier: "cpu" | "accelerated" | undefined,
): string | undefined {
  if (!language || tier === undefined) return undefined;
  const scored = models.flatMap((model) => {
    if (
      !Array.isArray(model.languages) ||
      !model.languages.includes(language) ||
      typeof model.accuracy !== "object" ||
      model.accuracy === null ||
      Array.isArray(model.accuracy)
    )
      return [];
    const accuracy = Reflect.get(model.accuracy, language);
    const seconds = model.benchmark?.[tier];
    if (
      typeof accuracy !== "number" ||
      !Number.isFinite(accuracy) ||
      accuracy < 0 ||
      typeof seconds !== "number" ||
      !Number.isFinite(seconds) ||
      seconds < 0
    )
      return [];
    return [{ id: model.id, accuracy, seconds, cost: accuracy + 0.5 * Math.max(0, seconds - 3) }];
  });
  const useful = scored.filter((model) => model.accuracy < 20);
  const pool = useful.length ? useful : scored;
  const withinBudget = pool.filter((model) => model.seconds <= 5);
  return [...(useful.length && withinBudget.length ? withinBudget : pool)].sort((a, b) =>
    useful.length ? a.cost - b.cost : a.accuracy - b.accuracy,
  )[0]?.id;
}
