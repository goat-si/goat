import { appendGeneratedImageEmbeds } from "@goat/shared/generatedImageMarkdown";
import { markdownImageHrefs } from "@goat/shared/markdownImages";
import { parseMarkdownFileLink } from "@goat/shared/markdownLinks";
import type * as Path from "effect/Path";
import type * as CodexSchema from "effect-codex-app-server/schema";
import type { CodexDynamicToolProjection } from "./CodexAdapterV2.ts";

/** Append saved images only when the answer does not already render that file. */
export function appendGeneratedImageMarkdown(
  text: string,
  paths: ReadonlySet<string>,
  cwd: string,
  path: Path.Path,
): string {
  const embeddedPaths = new Set(
    markdownImageHrefs(text).flatMap((href) => {
      const target = parseMarkdownFileLink(href);
      return target === null ? [] : [path.resolve(cwd, target.path)];
    }),
  );
  const missing = [...paths].filter(
    (savedPath) => !embeddedPaths.has(path.resolve(cwd, savedPath)),
  );
  return appendGeneratedImageEmbeds(text, missing, "Generated image");
}

export type CodexImageGenerationItem = Extract<
  CodexSchema.V2ItemCompletedNotification__ThreadItem,
  { type: "imageGeneration" }
>;

// Codex 0.164 uploads generated images to its attachment store and sends a
// `fileId` in place of inline bytes when that succeeds. The app-server has no
// request that reads an attachment back, so such an image is only shown when
// Codex also saved it locally (`savedPath`).
export function codexImageGenerationProjection(
  item: CodexImageGenerationItem,
): CodexDynamicToolProjection {
  const inputImages = item.inputImages?.map((image) => image.path) ?? [];
  return {
    toolName: "imageGeneration",
    input: {
      prompt: item.revisedPrompt ?? "",
      ...(inputImages.length === 0 ? {} : { inputImages }),
    },
    ...("result" in item
      ? { output: [{ type: "image", mimeType: "image/png", data: item.result }] }
      : {}),
    status: "completed",
  };
}
