import type { PullRequestDiffResult, PullRequestOmittedFileStat } from "@goat/contracts";
import {
  buildFileDiffRenderKey,
  fnv1a32,
  getDiffLineStat,
  getRenderablePatch,
  type RenderablePatch,
} from "~/lib/diffRendering";
import { orderDiffFilesLikeTree } from "../diffs/diffFileTree.logic";
import { orderDiffFiles } from "./pullRequestFileOrder.logic";

export interface DiffSlice {
  readonly source: PullRequestDiffResult;
  readonly cursor: string | null;
  readonly patch: string;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
  readonly omittedFileStats: ReadonlyArray<PullRequestOmittedFileStat>;
}

export const NO_SLICES: ReadonlyArray<DiffSlice> = [];

// Query results outlive the panel's slices, so their parses survive closing and reopening
// without retaining anything beyond the query cache's lifetime.
const sliceParses = new WeakMap<PullRequestDiffResult, Map<string, RenderablePatch | null>>();

function parseSlice(slice: DiffSlice, cacheKey: string, ignoreWhitespace: boolean) {
  let parses = sliceParses.get(slice.source);
  if (parses === undefined) {
    parses = new Map();
    sliceParses.set(slice.source, parses);
  }
  if (parses.has(cacheKey)) return parses.get(cacheKey) ?? null;
  const parsed = getRenderablePatch(slice.patch, cacheKey, {
    compactPartialHunkOffsets: true,
    ignoreWhitespace,
  });
  parses.set(cacheKey, parsed);
  return parsed;
}

type DiffModel = {
  readonly parsedSlices: ReadonlyArray<RenderablePatch | null>;
  readonly loadedFiles: ReadonlyArray<Extract<RenderablePatch, { kind: "files" }>["files"][number]>;
  readonly sourceFileStats: ReadonlyMap<string, ReturnType<typeof getDiffLineStat>>;
};
const diffModels = new WeakMap<ReadonlyArray<DiffSlice>, Map<string, DiffModel>>();
const patchHashes = new WeakMap<DiffSlice, number>();

// Hashing, ordering and counting every file of a huge pull request costs a second, and the tab
// renders far more often than its slices change, so the model is kept per slice list.
export function diffModel(
  slices: ReadonlyArray<DiffSlice>,
  keyPrefix: string,
  ignoreWhitespace: boolean,
): DiffModel {
  let models = diffModels.get(slices);
  if (models === undefined) diffModels.set(slices, (models = new Map()));
  const cached = models.get(keyPrefix);
  if (cached !== undefined) return cached;
  const parsedSlices = slices.map((slice) => {
    let hash = patchHashes.get(slice);
    if (hash === undefined) patchHashes.set(slice, (hash = fnv1a32(slice.patch)));
    // The cache key carries the theme, which the tokenizer caches against, and the patch's
    // hash: a refreshed page reuses its cursor, so position alone would return a stale parse.
    return parseSlice(slice, `${keyPrefix}:${slice.cursor ?? "first"}:${hash}`, ignoreWhitespace);
  });
  const model: DiffModel = {
    parsedSlices,
    loadedFiles: orderDiffFilesLikeTree(
      parsedSlices.flatMap((parsed) =>
        parsed?.kind === "files" ? orderDiffFiles(parsed.files) : [],
      ),
    ),
    sourceFileStats: new Map(
      parsedSlices.flatMap((parsed) =>
        parsed?.kind === "files"
          ? parsed.files.map(
              (file, index) =>
                [
                  buildFileDiffRenderKey(file),
                  getDiffLineStat([parsed.sourceFiles[index] ?? file]),
                ] as const,
            )
          : [],
      ),
    ),
  };
  models.set(keyPrefix, model);
  return model;
}
