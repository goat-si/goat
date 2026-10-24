import { ProjectReadFileError, type ProjectReadFileResult } from "@goat/contracts";
import * as Schema from "effect/Schema";

import { toastManager } from "~/components/ui/toast";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";

const isProjectReadFileError = Schema.is(ProjectReadFileError);

export function fileBaseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).at(-1) || trimmed;
}

export type FileContentsRead =
  | { readonly _tag: "Success"; readonly value: ProjectReadFileResult }
  | { readonly _tag: "Failure"; readonly error: unknown };

/**
 * Why a read cannot be copied whole. A truncated read, a binary file and text the
 * server could only decode with replacement characters would all paste something
 * other than the file, so they are refused.
 */
function contentsCopyRefusal(read: FileContentsRead): string | null {
  if (read._tag === "Failure") {
    const failure = isProjectReadFileError(read.error) ? read.error.failure : undefined;
    if (failure === "binary_file") return "Binary files cannot be copied as text.";
    if (failure === "unsupported_text_format") return "This file's text encoding cannot be copied.";
    return isProjectReadFileError(read.error) ? read.error.message : "The file could not be read.";
  }
  if (read.value.textFormat?.encoding === "unsupported") {
    return "This file's text encoding cannot be copied.";
  }
  if (read.value.truncated) return "This file is too large to copy whole.";
  return null;
}

export async function copyFileContents(path: string, read: FileContentsRead): Promise<void> {
  const refusal = contentsCopyRefusal(read);
  if (refusal !== null || read._tag === "Failure") {
    toastManager.add({ type: "error", title: "Contents not copied", description: refusal });
    return;
  }
  try {
    if (!(await writeTextToClipboard(read.value.contents, "file contents"))) return;
    toastManager.add({
      type: "success",
      title: "Contents copied",
      description: fileBaseName(path),
    });
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Failed to copy contents",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  }
}

export async function copyFileNames(paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  const text = paths.map(fileBaseName).join("\n");
  try {
    if (!(await writeTextToClipboard(text, "file name"))) return;
    toastManager.add({
      type: "success",
      title: paths.length === 1 ? "Name copied" : `${paths.length} names copied`,
      description: text,
    });
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Failed to copy name",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  }
}
