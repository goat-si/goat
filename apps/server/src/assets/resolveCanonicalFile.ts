import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { makeIsServerInternalPath } from "../auth/serverInternalPaths.ts";
import { optionOnNotFound } from "./workspaceAssetFile.ts";
import { realPathWithoutNativeResolver } from "./MediaFile.ts";

export const resolveCanonicalFile = Effect.fn("AssetAccess.resolveCanonicalFile")(function* (
  filePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const nativeCanonicalFile = yield* optionOnNotFound(fileSystem.realPath(filePath));
  const canonicalFile = Option.isSome(nativeCanonicalFile)
    ? nativeCanonicalFile.value
    : yield* realPathWithoutNativeResolver(filePath);
  if (canonicalFile === null) return null;

  const info = yield* optionOnNotFound(fileSystem.stat(canonicalFile));
  if (Option.isNone(info) || info.value.type !== "File") return null;
  const isServerInternalPath = yield* makeIsServerInternalPath;
  return (yield* isServerInternalPath(canonicalFile)) ? null : canonicalFile;
});
