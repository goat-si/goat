export interface QuickPickModel {
  readonly key: string;
  readonly isHidden?: boolean | undefined;
  readonly isUnavailable?: boolean | undefined;
}

export interface RecentModelThread {
  readonly environmentId: string;
  readonly modelSelection: { readonly instanceId: string; readonly model: string } | null;
  readonly latestUserMessageAt: string | null;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly deletedAt?: string | null;
}

export type ModelQuickPickReason = "favorite" | "recent";

export function providerModelKey(instanceId: string, model: string): string {
  return `${instanceId}:${model}`;
}

/** Distinct models of an environment's live threads, most recently prompted first. */
export function recentModelKeys(
  threads: ReadonlyArray<RecentModelThread>,
  environmentId: string,
  limit: number,
): ReadonlyArray<string> {
  const latestByKey = new Map<string, string>();
  for (const thread of threads) {
    if (
      thread.environmentId !== environmentId ||
      thread.modelSelection === null ||
      thread.archivedAt !== null ||
      (thread.deletedAt ?? null) !== null
    ) {
      continue;
    }
    const key = providerModelKey(thread.modelSelection.instanceId, thread.modelSelection.model);
    const usedAt = thread.latestUserMessageAt ?? thread.updatedAt;
    const previous = latestByKey.get(key);
    if (previous === undefined || usedAt > previous) latestByKey.set(key, usedAt);
  }
  return [...latestByKey]
    .sort(([, left], [, right]) => (left < right ? 1 : left > right ? -1 : 0))
    .slice(0, Math.max(0, limit))
    .map(([key]) => key);
}

/**
 * Favorites in catalog order, then recents in recency order. Models the caller already shows
 * (`excludeKeys`), hidden models and unavailable models are skipped.
 */
export function buildModelQuickPicks<T extends QuickPickModel>(input: {
  readonly models: ReadonlyArray<T>;
  readonly excludeKeys: ReadonlySet<string>;
  readonly favoriteKeys: ReadonlySet<string>;
  readonly recentKeys: ReadonlyArray<string>;
  readonly limit: number;
}): ReadonlyArray<{ readonly model: T; readonly reason: ModelQuickPickReason }> {
  const byKey = new Map(input.models.map((model) => [model.key, model] as const));
  const picks: Array<{ readonly model: T; readonly reason: ModelQuickPickReason }> = [];
  const taken = new Set(input.excludeKeys);
  const add = (model: T | undefined, reason: ModelQuickPickReason) => {
    if (
      picks.length >= input.limit ||
      !model ||
      taken.has(model.key) ||
      model.isHidden === true ||
      model.isUnavailable === true
    ) {
      return;
    }
    taken.add(model.key);
    picks.push({ model, reason });
  };
  for (const model of input.models) {
    if (input.favoriteKeys.has(model.key)) add(model, "favorite");
  }
  for (const key of input.recentKeys) add(byKey.get(key), "recent");
  return picks;
}
