import { FILE_HEADERS_ONLY, formatPatch, structuredPatch } from "diff";
import { unknownRecord } from "./clientPolicy.ts";
import type { AcpToolCallState } from "./runtimeModel.ts";

export function structuredFileChanges(toolCall: AcpToolCallState) {
  const content = toolCall.data.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((entry) => {
    const diff = unknownRecord(entry);
    if (diff?.type !== "diff" || !Array.isArray(diff.changes)) return [];
    return diff.changes.flatMap((candidate) => {
      const change = unknownRecord(candidate);
      const operation = typeof change?.operation === "string" ? change.operation.trim() : "";
      const path = typeof change?.path === "string" ? change.path.trim() : "";
      if (operation.length === 0 || path.length === 0) return [];
      const oldPath = typeof change?.oldPath === "string" ? change.oldPath.trim() : "";
      const fileType = typeof change?.fileType === "string" ? change.fileType.trim() : "";
      const mimeType = typeof change?.mimeType === "string" ? change.mimeType.trim() : "";
      return [
        {
          operation,
          path,
          ...(oldPath.length === 0 ? {} : { oldPath }),
          ...(fileType.length === 0 ? {} : { fileType }),
          ...(mimeType.length === 0 ? {} : { mimeType }),
        },
      ];
    });
  });
}

// Bound diff search to protect the event loop; empty-sided diffs need no search.
const ACP_V1_DIFF_MAX_EDITS = 1_000;

export function acpToolCallDiffPatch(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const diffs = content.flatMap((entry) => {
    const diff = unknownRecord(entry);
    return diff?.type === "diff" ? [diff] : [];
  });
  for (const diff of diffs) {
    const patch = unknownRecord(diff.patch);
    if (typeof patch?.text === "string") return patch.text;
  }
  const v1Patches = diffs.flatMap((diff) => {
    if (typeof diff.path !== "string" || typeof diff.newText !== "string") return [];
    const oldText = typeof diff.oldText === "string" ? diff.oldText : undefined;
    const patch = structuredPatch(
      oldText === undefined ? "/dev/null" : diff.path,
      diff.path,
      oldText ?? "",
      diff.newText,
      undefined,
      undefined,
      {
        context: 3,
        maxEditLength: oldText && diff.newText ? ACP_V1_DIFF_MAX_EDITS : Number.POSITIVE_INFINITY,
      },
    );
    return patch === undefined || patch.hunks.length === 0 ? [] : [patch];
  });
  return v1Patches.length === 0 ? undefined : formatPatch(v1Patches, FILE_HEADERS_ONLY);
}
