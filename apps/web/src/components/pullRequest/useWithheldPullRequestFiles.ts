import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { PullRequestDiffResult } from "@goat/contracts";
import { hasCutLines } from "@goat/shared/diffCutLines";
import type { FileDiffMetadata } from "@pierre/diffs";
import { useContext, useState } from "react";
import {
  buildFileDiffRenderKey,
  getRenderablePatch,
  fnv1a32,
  resolveFileDiffPath,
  resolveFileDiffPreviousPath,
} from "~/lib/diffRendering";
import { pullRequestEnvironment } from "~/state/pullRequests";

type DiffTarget = Parameters<typeof pullRequestEnvironment.withheldDiff>[0];
type LoadStatus = "idle" | "loading" | "error" | "empty";
const NO_PATHS: readonly string[] = [];
const parsedFiles = new WeakMap<PullRequestDiffResult, FileDiffMetadata | null>();

function parseFile(result: PullRequestDiffResult, key: string) {
  const cached = parsedFiles.get(result);
  if (cached !== undefined) return cached;
  // Cut lines may look identical up to the cut, so keep their hunk coordinates intact.
  const parsed = getRenderablePatch(result.patch, key + ":" + fnv1a32(result.patch), {
    compactPartialHunkOffsets: true,
    ignoreWhitespace: false,
  });
  const only = parsed?.kind === "files" && parsed.files.length === 1 ? parsed.files[0] : undefined;
  const file = only && only.hunks.length > 0 ? only : null;
  parsedFiles.set(result, file);
  return file;
}

export function useWithheldPullRequestFiles(
  target: DiffTarget,
  canLoad: boolean,
  pagedFiles: readonly FileDiffMetadata[],
) {
  const scope = JSON.stringify(target);
  const [selection, setSelection] = useState({ scope, paths: NO_PATHS });
  const paths = selection.scope === scope ? selection.paths : NO_PATHS;
  const registry = useContext(RegistryContext);
  const answers = useAtomValue(
    pullRequestEnvironment.withheldDiffs(JSON.stringify({ target, paths })),
  );
  const query = (path: string) =>
    pullRequestEnvironment.withheldDiff({ ...target, input: { ...target.input, path } });
  const refresh = () => paths.forEach((path) => registry.refresh(query(path)));
  const load = (path: string | undefined) => {
    if (!canLoad || path === undefined) return;
    registry.refresh(query(path));
    if (!paths.includes(path)) setSelection({ scope, paths: [...paths, path] });
  };

  const overlay = (() => {
    const statuses = new Map<string, LoadStatus>();
    const identities = new WeakMap<FileDiffMetadata, string>();
    const cutFiles = new WeakSet<FileDiffMetadata>();
    const replacements = new Map<string, { file: FileDiffMetadata; cut: boolean }>();
    paths.forEach((path, index) => {
      const result = answers[index];
      if (result?._tag !== "Success" || result.waiting) {
        statuses.set(path, result?._tag === "Failure" && !result.waiting ? "error" : "loading");
        return;
      }
      const file = parseFile(result.value, JSON.stringify([scope, path]));
      if (!file || resolveFileDiffPath(file) !== path) {
        statuses.set(path, "empty");
        return;
      }
      replacements.set(path, { file, cut: hasCutLines(result.value.patch) });
    });
    const files =
      replacements.size === 0
        ? pagedFiles
        : pagedFiles.map((file) => {
            const replacement = replacements.get(resolveFileDiffPath(file));
            if (!replacement || file.hunks.length > 0) return file;
            if (
              resolveFileDiffPreviousPath(replacement.file) !== resolveFileDiffPreviousPath(file)
            ) {
              statuses.set(resolveFileDiffPath(file), "error");
              return file;
            }
            identities.set(replacement.file, buildFileDiffRenderKey(file));
            if (replacement.cut) cutFiles.add(replacement.file);
            return replacement.file;
          });
    return { statuses, identities, cutFiles, files };
  })();

  return {
    ...overlay,
    fileKey: (file: FileDiffMetadata) =>
      overlay.identities.get(file) ?? buildFileDiffRenderKey(file),
    waiting: answers.some((answer) => answer.waiting),
    load,
    refresh,
  };
}
