import { WORKSPACE_BROWSER_PREVIEW_EXTENSIONS } from "@goat/shared/filePreview";
import type * as Path from "effect/Path";

export const PREVIEW_ASSET_EXTENSIONS = new Set([
  ...WORKSPACE_BROWSER_PREVIEW_EXTENSIONS,
  // Keep HTML dependency grants independent of newly supported file viewers.
  ".avif",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
  ".m4v",
  ".mp4",
  ".ogv",
  ".webm",
  ".aac",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
  ".css",
  ".js",
  ".mjs",
  ".otf",
  ".ttf",
  ".woff",
  ".woff2",
]);

export const isPreviewDependencyPath = (filePath: string, path: Path.Path) =>
  filePath.length > 0 &&
  !filePath.includes("\0") &&
  !filePath.split(/[\\/]/).some((segment) => segment.startsWith(".")) &&
  PREVIEW_ASSET_EXTENSIONS.has(path.extname(filePath).toLowerCase());
