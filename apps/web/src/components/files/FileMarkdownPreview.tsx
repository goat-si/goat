import type { ScopedThreadRef } from "@goat/contracts";
import { useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import type { ComposerThreadTarget } from "~/composerDraftStore";
import { resolvePathLinkTarget } from "@goat/shared/fileLinks";
import { maskMarkdownFrontmatter } from "@goat/shared/markdownFrontmatter";
import { FileMarkdownSelectionToolbar } from "./FileMarkdownSelectionToolbar";

export function FileMarkdownPreview(props: {
  readonly cwd: string;
  readonly relativePath: string;
  readonly text: string;
  readonly threadRef: ScopedThreadRef;
  readonly composerDraftTarget?: ComposerThreadTarget | undefined;
  readonly workspaceMutationId: string | null;
  readonly onTaskListChange?:
    | ((input: { readonly markerOffset: number; readonly checked: boolean }) => void)
    | undefined;
}) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const lastSeparator = Math.max(
    props.relativePath.lastIndexOf("/"),
    props.relativePath.lastIndexOf("\\"),
  );
  const imageBaseDir =
    lastSeparator >= 0
      ? resolvePathLinkTarget(props.relativePath.slice(0, lastSeparator), props.cwd)
      : props.cwd;

  return (
    <div ref={setViewport}>
      <ChatMarkdown
        text={maskMarkdownFrontmatter(props.text)}
        cwd={props.cwd}
        imageBaseDir={imageBaseDir}
        threadRef={props.threadRef}
        workspaceMutationId={props.workspaceMutationId}
        className="mx-auto max-w-4xl px-6 py-5"
        onTaskListChange={props.onTaskListChange}
      />
      <FileMarkdownSelectionToolbar
        viewport={viewport}
        cwd={props.cwd}
        relativePath={props.relativePath}
        composerDraftTarget={props.composerDraftTarget}
      />
    </div>
  );
}
