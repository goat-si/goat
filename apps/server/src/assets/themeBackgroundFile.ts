// @effect-diagnostics nodeBuiltinImport:off -- bounded no-follow reads require native open flags.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { EnvironmentThemeId } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { PUBLISHED_BACKGROUND_MAX_BYTES } from "./publishedBackgroundBudget.ts";

export const MAX_THEME_BACKGROUND_TOTAL_BYTES = 32 * 1024 * 1024;
export const THEME_BACKGROUND_EXTENSIONS = ["webp", "png", "jpg", "jpeg"] as const;
const BACKGROUND_READ_CHUNK_BYTES = 256 * 1024;
const MAX_BACKGROUND_READ_CALLS = 1024;
type Extension = (typeof THEME_BACKGROUND_EXTENSIONS)[number];
const isThemeId = Schema.is(EnvironmentThemeId);
const MAX_BACKGROUND_REVISION_CACHE = 32;
const revisionCache = new Map<
  string,
  { readonly fingerprint: string; readonly revision: string; readonly size: number }
>();
type Background = {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly revision: string;
};
export type OpenThemeBackground = {
  readonly handle: NodeFSP.FileHandle;
  readonly info: NodeFS.Stats;
  readonly extension: Extension;
  readonly path: string;
};

function matchesImage(bytes: Buffer, extension: Extension): boolean {
  if (extension === "png")
    return (
      bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    );
  if (extension === "jpg" || extension === "jpeg")
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  );
}

export async function openThemeBackground(
  directory: string,
  themeId: string,
  extension: Extension,
  budget = PUBLISHED_BACKGROUND_MAX_BYTES,
): Promise<OpenThemeBackground | null> {
  if (!isThemeId(themeId)) return null;
  const path = NodePath.join(directory, `${themeId}.${extension}`);
  let handle: NodeFSP.FileHandle | undefined;
  try {
    const before = await NodeFSP.lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.ino === 0) return null;
    handle = await NodeFSP.open(
      path,
      NodeFS.constants.O_RDONLY |
        (NodeFS.constants.O_NOFOLLOW ?? 0) |
        (NodeFS.constants.O_NONBLOCK ?? 0),
    );
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.ino !== before.ino ||
      info.dev !== before.dev ||
      info.size > PUBLISHED_BACKGROUND_MAX_BYTES ||
      info.size > budget ||
      info.size <= 0
    )
      return null;
    const result = { handle, info, extension, path };
    handle = undefined;
    return result;
  } catch (cause) {
    if (
      (cause as NodeJS.ErrnoException).code === "ENOENT" ||
      (cause as NodeJS.ErrnoException).code === "ELOOP"
    )
      return null;
    throw cause;
  } finally {
    if (handle !== undefined) await handle.close();
  }
}

export async function readOpenedThemeBackground(
  file: OpenThemeBackground,
  themeFile: string,
): Promise<Background | null> {
  try {
    const bytes = Buffer.alloc(file.info.size);
    const hash = NodeCrypto.createHash("sha256").update(themeFile).update("\0");
    let position = 0;
    for (let reads = 0; position < bytes.length && reads < MAX_BACKGROUND_READ_CALLS; reads++) {
      const count = Math.min(BACKGROUND_READ_CHUNK_BYTES, bytes.length - position);
      const result = await file.handle.read(bytes, position, count, position);
      if (result.bytesRead <= 0) break;
      hash.update(bytes.subarray(position, position + result.bytesRead));
      position += result.bytesRead;
    }
    const after = await file.handle.stat();
    const current = await NodeFSP.lstat(file.path);
    if (
      position !== bytes.length ||
      after.size !== file.info.size ||
      after.mtimeMs !== file.info.mtimeMs ||
      after.ctimeMs !== file.info.ctimeMs ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.dev !== file.info.dev ||
      current.ino !== file.info.ino ||
      !matchesImage(bytes, file.extension)
    )
      return null;
    return {
      bytes,
      mimeType:
        file.extension === "png"
          ? "image/png"
          : file.extension === "webp"
            ? "image/webp"
            : "image/jpeg",
      revision: `${file.extension}:${hash.digest("hex")}`,
    };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}

export async function closeThemeBackground(file: OpenThemeBackground): Promise<void> {
  await file.handle.close();
}

export async function readThemeBackground(
  directory: string,
  themeId: string,
  themeFile: string,
  budget = PUBLISHED_BACKGROUND_MAX_BYTES,
): Promise<Background | null> {
  for (const extension of THEME_BACKGROUND_EXTENSIONS) {
    const file = await openThemeBackground(directory, themeId, extension, budget);
    if (!file) continue;
    try {
      const image = await readOpenedThemeBackground(file, themeFile);
      if (image) return image;
    } finally {
      await closeThemeBackground(file);
    }
  }
  return null;
}

export async function themeBackgroundRevision(
  directory: string,
  themeId: string,
  themeFile: string,
  budget: number,
): Promise<{ readonly revision: string; readonly size: number } | null> {
  if (!isThemeId(themeId)) return null;
  const key = NodePath.join(directory, themeId);
  const fingerprints: string[] = [];
  for (const extension of THEME_BACKGROUND_EXTENSIONS) {
    try {
      const stat = await NodeFSP.lstat(`${key}.${extension}`, { bigint: true });
      fingerprints.push(
        `${extension}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`,
      );
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      fingerprints.push(`${extension}:missing`);
    }
  }
  const fingerprint = NodeCrypto.createHash("sha256")
    .update(themeFile)
    .update(fingerprints.join("|"))
    .digest("hex");
  const cached = revisionCache.get(key);
  if (cached && cached.fingerprint === fingerprint && budget >= PUBLISHED_BACKGROUND_MAX_BYTES)
    return { revision: cached.revision, size: cached.size };
  const image = await readThemeBackground(directory, themeId, themeFile, budget);
  if (!image) {
    revisionCache.delete(key);
    return null;
  }
  revisionCache.delete(key);
  revisionCache.set(key, { fingerprint, revision: image.revision, size: image.bytes.byteLength });
  if (revisionCache.size > MAX_BACKGROUND_REVISION_CACHE) {
    const oldest = revisionCache.keys().next().value;
    if (oldest !== undefined) revisionCache.delete(oldest);
  }
  return { revision: image.revision, size: image.bytes.byteLength };
}
