import type { AgentSessionImportSource } from "@goat/contracts";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

export function transcriptIdentity(filePath: string, stats: FileSystem.File.Info) {
  return {
    filePath,
    size: Number(stats.size),
    mtimeMs: Option.match(stats.mtime, { onNone: () => null, onSome: (date) => date.getTime() }),
    device: Number(stats.dev),
    inode: Option.match(stats.ino, { onNone: () => null, onSome: String }),
    birthtimeMs: Option.match(stats.birthtime, {
      onNone: () => null,
      onSome: (date) => date.getTime(),
    }),
  };
}

type TranscriptIdentity = Pick<
  AgentSessionImportSource,
  "filePath" | "size" | "mtimeMs" | "device" | "inode" | "birthtimeMs"
>;

const fileIdKey = (inode: TranscriptIdentity["inode"]) => (inode === null ? null : String(inode));

export function sameTranscriptIdentity(
  left: TranscriptIdentity,
  right: TranscriptIdentity,
): boolean {
  // Unsafe legacy numbers may already have lost file ID precision.
  if (
    (typeof left.inode === "number" && !Number.isSafeInteger(left.inode)) ||
    (typeof right.inode === "number" && !Number.isSafeInteger(right.inode))
  ) {
    return false;
  }
  return (
    left.filePath === right.filePath &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.device === right.device &&
    fileIdKey(left.inode) === fileIdKey(right.inode) &&
    left.birthtimeMs === right.birthtimeMs
  );
}
