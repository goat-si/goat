import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import * as Effect from "effect/Effect";
import { runOpenCodeSdk, type ParsedOpenCodeModelSlug } from "./OpenCodeRuntime.ts";

export type OpenCodeVariantCache = Map<string, ReadonlySet<string> | undefined>;

export const resolveOpenCodeVariant = Effect.fnUntraced(function* (
  client: OpencodeClient,
  model: ParsedOpenCodeModelSlug | undefined,
  variant: string | undefined,
  abortSignal?: AbortSignal,
  cache?: OpenCodeVariantCache,
) {
  if (!variant || !model) return variant;

  const key = `${model.providerID}/${model.modelID}`;
  const cached = cache?.get(key);
  if (cache?.has(key)) {
    return cached !== undefined && !cached.has(variant) ? undefined : variant;
  }

  // Only a confirmed catalog mismatch can invalidate a persisted selection.
  const response = yield* runOpenCodeSdk("provider.list", (signal) =>
    client.provider.list(undefined, {
      signal: abortSignal ? AbortSignal.any([signal, abortSignal]) : signal,
    }),
  ).pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() => undefined),
  );
  if (response?.data === undefined) return variant;

  const catalogModel = response.data.all.find((provider) => provider.id === model.providerID)
    ?.models[model.modelID];
  const variants = catalogModel ? new Set(Object.keys(catalogModel.variants ?? {})) : undefined;
  if (cache !== undefined) {
    // Keep only this model's names; provider.list can return several megabytes.
    cache.set(key, variants);
  }
  return variants !== undefined && !variants.has(variant) ? undefined : variant;
});
