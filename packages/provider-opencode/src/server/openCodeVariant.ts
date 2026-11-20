import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import * as Effect from "effect/Effect";
import { runOpenCodeSdk, type ParsedOpenCodeModelSlug } from "./OpenCodeRuntime.ts";

interface CatalogModel {
  readonly variants: ReadonlySet<string>;
  readonly contextWindow: number | undefined;
}

export type OpenCodeVariantCache = Map<string, CatalogModel | undefined>;

export const readOpenCodeCatalogModel = Effect.fn("OpenCode.readCatalogModel")(function* (
  client: OpencodeClient,
  model: ParsedOpenCodeModelSlug,
  abortSignal?: AbortSignal,
  cache?: OpenCodeVariantCache,
) {
  const key = `${model.providerID}/${model.modelID}`;
  if (cache?.has(key)) return cache.get(key);

  const response = yield* runOpenCodeSdk("provider.list", (signal) =>
    client.provider.list(undefined, {
      signal: abortSignal ? AbortSignal.any([signal, abortSignal]) : signal,
    }),
  ).pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() => undefined),
  );
  if (response?.data === undefined) return undefined;

  const catalogModel = response.data.all.find((provider) => provider.id === model.providerID)
    ?.models[model.modelID];
  const entry = catalogModel && {
    variants: new Set(Object.keys(catalogModel.variants ?? {})),
    contextWindow: catalogModel.limit?.input ?? catalogModel.limit?.context,
  };
  if (cache !== undefined && cache.size < 256) cache.set(key, entry);
  return entry;
});

export const resolveOpenCodeVariant = Effect.fnUntraced(function* (
  client: OpencodeClient,
  model: ParsedOpenCodeModelSlug | undefined,
  variant: string | undefined,
  abortSignal?: AbortSignal,
  cache?: OpenCodeVariantCache,
) {
  if (!variant || !model) return variant;
  // Only a confirmed catalog mismatch can invalidate a persisted selection.
  const entry = yield* readOpenCodeCatalogModel(client, model, abortSignal, cache);
  return entry !== undefined && !entry.variants.has(variant) ? undefined : variant;
});
