import { cliArchiveTarCommand, parseChecksums } from "@goat/shared/cliRelease";
import * as HostProcess from "@goat/shared/HostProcess";
import {
  isOfficeCjkFontAsset,
  MAX_OFFICE_CJK_FONT_ARCHIVE_BYTES,
  OFFICE_CJK_FONT_MANIFEST_SUFFIX,
} from "@goat/shared/officeCjkFontAssets";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { SshLaunchError } from "./errors.ts";
import { shellSingleQuote, type RemoteGoatRunnerOptions } from "./remoteRuntime.ts";

export const readBundledOfficeFonts = Effect.fn("ssh.runtimeOfficeFonts.read")(
  function* (archiveDirectory: string, fileName: string, assetDirectory: string | undefined) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const manifest = path.join(archiveDirectory, fileName + OFFICE_CJK_FONT_MANIFEST_SUFFIX);
    if (!(yield* fs.exists(manifest))) return undefined;

    if (!assetDirectory || (yield* fs.stat(manifest)).size > 4096n) {
      return yield* fontError("Missing desktop web assets or oversized SSH font manifest.");
    }
    const text = yield* fs.readFileString(manifest);
    const checksums = parseChecksums(text);
    const names = [...checksums.keys()];
    if (
      names.length === 0 ||
      names.some((name) => !isOfficeCjkFontAsset(name)) ||
      text !== names.map((name) => `${checksums.get(name)}  ${name}\n`).join("")
    ) {
      return yield* fontError("Invalid bundled SSH font manifest.");
    }

    const digest = yield* Digest.Digest;
    const work = yield* fs.makeTempDirectoryScoped({ prefix: "goat-ssh-font-upload-" });
    let remaining = BigInt(MAX_OFFICE_CJK_FONT_ARCHIVE_BYTES);
    for (const [name, checksum] of checksums) {
      const source = path.join(assetDirectory, name);
      const stat = yield* fs.stat(source);
      if (stat.type !== "File" || stat.size > remaining) {
        return yield* fontError(`Invalid size or file type for shared SSH font ${name}.`);
      }
      const bytes = yield* fs.readFile(source);
      remaining -= stat.size;
      if (
        BigInt(bytes.byteLength) !== stat.size ||
        Hex.encode(yield* digest.digest(Digest.sha256, bytes)) !== checksum
      ) {
        return yield* fontError(`Checksum mismatch for shared SSH font ${name}.`);
      }
      yield* fs.writeFile(path.join(work, name), bytes);
    }

    const localArchive = path.join(work, "fonts.tar.gz");
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const tar = cliArchiveTarCommand(yield* HostProcess.Platform, process.env);
    const child = yield* spawner.spawn(
      ChildProcess.make(tar, ["-czf", localArchive, "-C", work, ...names], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    if (
      Number(yield* child.exitCode) !== 0 ||
      (yield* fs.stat(localArchive)).size > BigInt(MAX_OFFICE_CJK_FONT_ARCHIVE_BYTES)
    ) {
      return yield* fontError("Cannot pack shared SSH fonts.");
    }
    const bytes = yield* fs.readFile(localArchive);
    return { bytes, sha256: Hex.encode(yield* digest.digest(Digest.sha256, bytes)) };
  },
  Effect.scoped,
  Effect.catch((cause) =>
    Effect.logWarning("ssh.runtime.bundle.fonts.unavailable", { cause }).pipe(Effect.as(undefined)),
  ),
);

const fontError = (message: string) => new SshLaunchError({ message, stdout: "" });

export function runtimeArchiveUploadScript(
  installer: string,
  source: RemoteGoatRunnerOptions["archiveSource"],
  fonts?: { readonly archiveBytes: number; readonly sha256: string },
): string {
  if (fonts) {
    const anchor = '  rm -f "$GOAT_STAGING/$GOAT_ARCHIVE" "$GOAT_STAGING/SHA256SUMS"';
    if (
      !/^[a-f0-9]{64}$/.test(fonts.sha256) ||
      !Number.isSafeInteger(fonts.archiveBytes) ||
      fonts.archiveBytes <= 0 ||
      installer.split(anchor).length !== 2
    ) {
      throw fontError("Invalid SSH runtime font upload.");
    }
    installer = installer.replace(
      anchor,
      () => `  if ! (
    set -e
    assets="$GOAT_STAGING/client/assets"
    [ -d "$assets" ] && [ ! -L "$GOAT_STAGING/client" ] && [ ! -L "$assets" ] || exit 1
    if command -v sha256sum >/dev/null 2>&1; then
      actual="$(sha256sum "$GOAT_SSH_UPLOADED_FONTS" | cut -d' ' -f1)"
    else
      actual="$(shasum -a 256 "$GOAT_SSH_UPLOADED_FONTS" | cut -d' ' -f1)"
    fi
    [ "$actual" = '${fonts.sha256}' ] || exit 1
    tar -xzf "$GOAT_SSH_UPLOADED_FONTS" -C "$assets"
  ); then
    printf '%s\\n' 'Could not install optional SSH runtime fonts.' >&2
  fi
${anchor}`,
    );
  }
  const readUpload = fonts
    ? `cat > "$archive" || :
[ "$(wc -c < "$archive")" -ge ${fonts.archiveBytes} ]
export GOAT_SSH_UPLOADED_FONTS="$upload_dir/fonts.tar.gz"
tail -c +${fonts.archiveBytes + 1} "$archive" > "$GOAT_SSH_UPLOADED_FONTS" || :
dd bs=1 seek=${fonts.archiveBytes} count=0 of="$archive" 2>/dev/null`
    : 'cat > "$archive"';
  return `set -eu
umask 077
mkdir -p "$HOME/.goat/runtime/goat/versions"
upload_dir="$(mktemp -d "$HOME/.goat/runtime/goat/versions/.upload-XXXXXX")"
trap 'rm -rf "$upload_dir"' EXIT
trap 'exit 1' HUP INT TERM
archive="$upload_dir/archive.tar.gz"
${readUpload}
export GOAT_SSH_UPLOADED_ARCHIVE="$archive"
export GOAT_SSH_ARCHIVE_SOURCE=${shellSingleQuote(source ?? "cache")}
sh -c ${shellSingleQuote(installer)} -- --version
`;
}
