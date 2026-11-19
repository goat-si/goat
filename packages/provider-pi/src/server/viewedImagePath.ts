import { isWorkspaceImagePreviewPath } from "@goat/shared/filePreview";
import { piRecordString } from "./rpc.ts";

export function piViewedImagePath(toolName: string, args: unknown): string | undefined {
  const path =
    toolName === "read"
      ? (piRecordString(args, "path") ?? piRecordString(args, "file_path"))?.trim()
      : undefined;
  return path && path.length <= 4096 && !/[\r\n]/.test(path) && isWorkspaceImagePreviewPath(path)
    ? path
    : undefined;
}
