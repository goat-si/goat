import { retainWithheldDiffPaths } from "@goat/client-runtime/state/pull-requests";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { PullRequestDiffResult } from "@goat/contracts";
import { hasCutLines } from "@goat/shared/diffCutLines";
import { Atom } from "effect/reactivity";
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
const UNADVERTISED = Atom.make(() => false);
const NO_WITHHELD_ANSWERS = Atom.make(() => []);
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
  pageReadable: boolean,
  pagedFiles: readonly FileDiffMetadata[],
) {
  const scope = JSON.stringify(target);
  const [selection, setSelection] = useState({ scope, paths: NO_PATHS });
  const readable = useAtomValue(
    pageReadable ? pullRequestEnvironment.withheldDiffAdvertised(target) : UNADVERTISED,
  );
  const paths = readable && selection.scope === scope ? selection.paths : NO_PATHS;
  const registry = useContext(RegistryContext);
  const answers = useAtomValue(
    paths.length === 0
      ? NO_WITHHELD_ANSWERS
      : pullRequestEnvironment.withheldDiffs(JSON.stringify({ target, paths })),
  );
  const retained = retainWithheldDiffPaths(paths, (index) => {
    const answer = answers[index];
    return answer?._tag === "Success" ? answer.value : undefined;
  });
  if (retained !== paths) setSelection({ scope, paths: retained });
  const offset = paths.length - retained.length;
  const load = (path: string | undefined) => {
    if (!readable || path === undefined) return;
    if (retained.includes(path)) {
      registry.refresh(
        pullRequestEnvironment.withheldDiff({ ...target, input: { ...target.input, path } }),
      );
      return;
    }
    setSelection((current) => {
      const selected = current.scope === scope ? current.paths : NO_PATHS;
      return selected.includes(path)
        ? current
        : {
            scope,
            paths: retainWithheldDiffPaths([...selected, path], () => undefined),
          };
    });
  };

  const overlay = (() => {
    const statuses = new Map<string, LoadStatus>();
    const identities = new WeakMap<FileDiffMetadata, string>();
    const cutFiles = new WeakSet<FileDiffMetadata>();
    const replacements = new Map<string, { file: FileDiffMetadata; cut: boolean }>();
    retained.forEach((path, index) => {
      const result = answers[offset + index];
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
    readable,
    fileKey: (file: FileDiffMetadata) =>
      overlay.identities.get(file) ?? buildFileDiffRenderKey(file),
    waiting: answers.some((answer) => answer.waiting),
    load,
  };
}
