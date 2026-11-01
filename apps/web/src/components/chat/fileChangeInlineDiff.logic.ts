import type { OrchestrationV2TurnItem } from "@goat/contracts";
import { fileChangeTargetPaths } from "@goat/client-runtime/work-log/file-change-diff";
import { fileBasename } from "@goat/shared/path";

type FileChangeItem = Extract<OrchestrationV2TurnItem, { type: "file_change" }>;

function fileChangeVerb(item: FileChangeItem): string {
  const operations = new Set(item.changes?.map((change) => change.operation));
  if (operations.size !== 1) return "Edited";
  switch ([...operations][0]) {
    case "add":
      return "Created";
    case "delete":
      return "Deleted";
    case "move":
      return "Moved";
    default:
      return "Edited";
  }
}

/** The verb and file name a changed-file row reads as, such as "Edited ChatView.tsx". */
export function fileChangeRowLabel(item: FileChangeItem): string {
  const paths = fileChangeTargetPaths(item);
  const name = fileBasename((paths[0] ?? item.fileName).replaceAll("\\", "/"));
  const more = paths.length > 1 ? ` +${paths.length - 1} more` : "";
  return `${fileChangeVerb(item)} ${name}${more}`;
}
