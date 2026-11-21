// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect cannot open with O_NOFOLLOW and O_NONBLOCK.
import * as NodeFS from "node:fs";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const officeCjkAsset = /^Noto(?:Sans(?:JP|KR|SC|TC)|SerifSC)-Regular(?:-[\w-]+)?\.otf$/;

export const isOfficeCjkFontAsset = (name: string): boolean => officeCjkAsset.test(name);

export const MAX_OFFICE_CJK_FONT_ARCHIVE_BYTES = 48 * 1024 * 1024;
export const OFFICE_CJK_FONT_MANIFEST_SUFFIX = ".fonts.sha256";

export const MAX_OFFICE_CJK_FONT_MANIFEST_BYTES = 4096;

const fontOpenFlags =
  NodeFS.constants.O_RDONLY |
  (NodeFS.constants.O_NOFOLLOW ?? 0) |
  (NodeFS.constants.O_NONBLOCK ?? 0);

export const readOfficeCjkFile = Effect.fn("officeCjkFontAssets.readRegular")(function* (
  root: string,
  file: string,
  maxBytes: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const info = yield* fs.lstat(file);
  const invalid = () => new Error(`Invalid Office font input: ${file}`);
  if (info.type !== "File" || info.size > BigInt(maxBytes)) {
    return yield* Effect.fail(invalid());
  }

  const canonicalRoot = yield* fs.realPath(root);
  const resolved = yield* fs.realPath(file);
  const relative = path.relative(canonicalRoot, resolved);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative)
  ) {
    return yield* Effect.fail(invalid());
  }

  return yield* Effect.tryPromise(async () => {
    const handle = await NodeFS.promises.open(resolved, fontOpenFlags);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.size !== info.size) throw invalid();

      const bytes = new Uint8Array(Number(info.size) + 1);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, null);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (BigInt(offset) !== info.size) throw invalid();
      return bytes.subarray(0, offset);
    } finally {
      await handle.close();
    }
  });
});
