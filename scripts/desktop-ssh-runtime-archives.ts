// @effect-diagnostics nodeBuiltinImport:off - Hash the same archive bytes the desktop bundles.
import * as NodeCrypto from "node:crypto";
import { cliArchiveFileName, cliArchiveTarCommand, parseChecksums } from "@goat/shared/cliRelease";
import { collectUint8StreamText } from "@goat/shared/collectStreamText";
import * as HostProcess from "@goat/shared/HostProcess";
import {
  isOfficeCjkFontAsset,
  MAX_OFFICE_CJK_FONT_ARCHIVE_BYTES,
  OFFICE_CJK_FONT_MANIFEST_SUFFIX,
  readOfficeCjkFile,
} from "@goat/shared/officeCjkFontAssets";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export const parseWslRuntimeArchiveMembers = (listing: string): ReadonlyArray<string> =>
  listing
    .split(/\r?\n/)
    .map((member) => member.replace(/^\.\//, "").replace(/\/$/, ""))
    .filter((member) => member.length > 0);

export class SshRuntimeArchiveValidationError extends Schema.TaggedError<SshRuntimeArchiveValidationError>()(
  "SshRuntimeArchiveValidationError",
  { message: Schema.String },
) {}

export const SSH_RUNTIME_PLATFORM_KEYS = ["darwin-arm64", "linux-x64", "linux-arm64"] as const;
export const SSH_RUNTIME_RESOURCE_SOURCE_DIR = "apps/desktop/prod-resources/ssh-runtime/archives";
export const SSH_RUNTIME_EXTRA_RESOURCES = [
  {
    from: SSH_RUNTIME_RESOURCE_SOURCE_DIR,
    to: "ssh-runtime/archives",
    filter: ["*.tar.gz", "*.tar.gz.sha256", `*.tar.gz${OFFICE_CJK_FONT_MANIFEST_SUFFIX}`],
  },
] as const;

export const validateSshRuntimeArchives = Effect.fn("validateSshRuntimeArchives")(
  function* (input: {
    readonly directory: string;
    readonly version: string;
    readonly requireAll: boolean;
    readonly requireSidecars?: boolean;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const archives: Array<{
      fileName: string;
      bytes: Uint8Array;
      sha256: string;
      fontMembers: ReadonlyArray<string>;
    }> = [];
    for (const key of SSH_RUNTIME_PLATFORM_KEYS) {
      const fileName = cliArchiveFileName(input.version, key);
      const archivePath = path.join(input.directory, fileName);
      if (!(yield* fs.exists(archivePath))) {
        if (input.requireAll)
          return yield* new SshRuntimeArchiveValidationError({
            message: `Missing SSH runtime archive ${archivePath}`,
          });
        continue;
      }
      const stat = yield* fs.stat(archivePath);
      if (stat.type !== "File" || stat.size > 256n * 1024n * 1024n) {
        return yield* new SshRuntimeArchiveValidationError({
          message: `Invalid SSH runtime archive ${archivePath}`,
        });
      }
      const bytes = yield* fs.readFile(archivePath);
      if (BigInt(bytes.byteLength) !== stat.size || bytes.byteLength > 256 * 1024 * 1024) {
        return yield* new SshRuntimeArchiveValidationError({
          message: `SSH runtime archive changed while reading ${archivePath}`,
        });
      }
      const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
      const sidecar = `${archivePath}.sha256`;
      const hasSidecar = yield* fs.exists(sidecar);
      if (input.requireSidecars && !hasSidecar) {
        return yield* new SshRuntimeArchiveValidationError({
          message: `Missing SSH runtime checksum ${sidecar}`,
        });
      }
      if (hasSidecar) {
        const checksum = yield* fs.readFileString(sidecar);
        if (
          parseChecksums(checksum).get(fileName) !== sha256 ||
          (input.requireSidecars && checksum !== `${sha256}  ${fileName}\n`)
        ) {
          return yield* new SshRuntimeArchiveValidationError({
            message: `Invalid or noncanonical SSH runtime checksum ${sidecar}`,
          });
        }
      }
      const tarCommand = cliArchiveTarCommand(yield* HostProcess.Platform, process.env);
      const listing = yield* runArchiveCommand(tarCommand, ["-tzf", archivePath]);
      const members = parseWslRuntimeArchiveMembers(listing);
      const stem = fileName.slice(0, -".tar.gz".length);
      const required = [
        `${stem}/goat`,
        `${stem}/client/index.html`,
        `${stem}/resource-monitor/${key}/goat-resource-monitor`,
        `${stem}/screen-code/quickjs.wasm`,
      ];
      const pty = [
        `${stem}/node_modules/node-pty/build/Release/pty.node`,
        `${stem}/node_modules/node-pty/prebuilds/${key}/pty.node`,
      ];
      if (
        members.length === 0 ||
        members.some(
          (member) =>
            member.split("/").some((segment) => segment === "..") ||
            (member !== stem && !member.startsWith(`${stem}/`)) ||
            member.endsWith("/bin.mjs"),
        ) ||
        required.some((member) => !members.includes(member)) ||
        !pty.some((member) => members.includes(member))
      ) {
        return yield* new SshRuntimeArchiveValidationError({
          message: `Incomplete or wrong-version SSH runtime archive ${archivePath}`,
        });
      }
      const fontMembers = members.filter((member) => {
        const prefix = `${stem}/client/assets/`;
        return member.startsWith(prefix) && isOfficeCjkFontAsset(member.slice(prefix.length));
      });
      archives.push({ fileName, bytes, sha256, fontMembers });
    }
    if (archives.length === 0)
      return yield* new SshRuntimeArchiveValidationError({
        message: `No SSH runtime archives for ${input.version} in ${input.directory}`,
      });
    return archives;
  },
);

export const stageSshRuntimeArchivesWithManifests = Effect.fn(
  "stageSshRuntimeArchivesWithManifests",
)(function* (input: {
  readonly sourceDirectory: string;
  readonly destinationDirectory: string;
  readonly clientAssetsDirectory?: string;
  readonly version: string;
  readonly requireAll: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const tar = cliArchiveTarCommand(platform, process.env);
  // Validate the entire input before creating any destination resources.
  const archives = yield* validateSshRuntimeArchives({
    directory: input.sourceDirectory,
    version: input.version,
    requireAll: input.requireAll,
  });
  const sourceEntries = new Set(yield* fs.readDirectory(input.sourceDirectory));
  const preTrimmed = archives.find(({ fileName }) =>
    sourceEntries.has(fileName + OFFICE_CJK_FONT_MANIFEST_SUFFIX),
  );
  if (preTrimmed) {
    return yield* new SshRuntimeArchiveValidationError({
      message: `${preTrimmed.fileName} in ${input.sourceDirectory} has already been trimmed for desktop packaging. Supply the full CLI archive instead.`,
    });
  }
  yield* fs.makeDirectory(input.destinationDirectory, { recursive: true });
  const sharedFonts = new Map<string, { sha256: string; bytes: bigint }>();
  let removedFontBytes = 0n;
  const expectedFontManifests = new Map<string, string>();

  for (const archive of archives) {
    const destination = path.join(input.destinationDirectory, archive.fileName);
    let sha256 = archive.sha256;
    if (input.clientAssetsDirectory && archive.fontMembers.length > 0) {
      const fonts = yield* trimRuntimeFonts({
        archive,
        destination,
        clientAssetsDirectory: input.clientAssetsDirectory,
        tar,
        platform,
      });
      for (const [name, font] of fonts) {
        sharedFonts.set(name, font);
        removedFontBytes += font.bytes;
      }
      sha256 = hash(yield* fs.readFile(destination));
      const manifest = [...fonts].map(([name, font]) => `${font.sha256}  ${name}\n`).join("");
      yield* fs.writeFileString(destination + OFFICE_CJK_FONT_MANIFEST_SUFFIX, manifest);
      expectedFontManifests.set(archive.fileName, manifest);
    } else {
      // Stage the original bytes we hashed, not a second read of a mutable source.
      yield* fs.writeFile(destination, archive.bytes);
    }
    yield* fs.writeFileString(destination + ".sha256", `${sha256}  ${archive.fileName}\n`);
  }

  const staged = yield* validateSshRuntimeArchives({
    directory: input.destinationDirectory,
    version: input.version,
    requireAll: input.requireAll,
    requireSidecars: true,
  });
  for (const archive of staged) {
    if (expectedFontManifests.has(archive.fileName) && archive.fontMembers.length > 0) {
      return yield* new SshRuntimeArchiveValidationError({
        message: `Duplicate CJK fonts remain in staged SSH archive ${archive.fileName}`,
      });
    }
  }
  yield* Effect.logInfo(
    `Staged SSH runtime archives: ${staged.length} archives, ${staged.reduce((total, archive) => total + archive.bytes.byteLength, 0)} bytes (plus canonical SHA-256 sidecars).`,
  );
  const sharedFontBytes = [...sharedFonts.values()].reduce((total, font) => total + font.bytes, 0n);
  yield* Effect.logInfo(
    `[desktop-artifact] CJK fonts: ${sharedFontBytes} bytes shared from the desktop web client, ${removedFontBytes} duplicate bytes removed from bundled SSH archives.`,
  );
  return {
    fontBytes: { sharedBytes: Number(sharedFontBytes), removedBytes: Number(removedFontBytes) },
    expectedFontManifests,
  };
});

export const stageSshRuntimeArchives = Effect.fn("stageSshRuntimeArchives")(function* (
  input: Parameters<typeof stageSshRuntimeArchivesWithManifests>[0],
) {
  return (yield* stageSshRuntimeArchivesWithManifests(input)).fontBytes;
});

const hash = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const trimRuntimeFonts = Effect.fn("desktopArtifact.trimRuntimeFonts")(function* (input: {
  readonly archive: { readonly bytes: Uint8Array; readonly fontMembers: ReadonlyArray<string> };
  readonly destination: string;
  readonly clientAssetsDirectory: string;
  readonly tar: string;
  readonly platform: NodeJS.Platform;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const work = yield* fs.makeTempDirectoryScoped({ prefix: "goat-trim-runtime-" });
  const source = path.join(work, "source.tar.gz");
  yield* fs.writeFile(source, input.archive.bytes);
  yield* runArchiveCommand(input.tar, ["-xzf", source, "-C", work, ...input.archive.fontMembers]);

  const fonts = new Map<string, { sha256: string; bytes: bigint }>();
  let remaining = MAX_OFFICE_CJK_FONT_ARCHIVE_BYTES;
  for (const member of input.archive.fontMembers) {
    const name = path.basename(member);
    const remote = yield* readOfficeCjkFile(work, path.join(work, member), remaining);
    const local = yield* readOfficeCjkFile(
      input.clientAssetsDirectory,
      path.join(input.clientAssetsDirectory, name),
      remote.byteLength,
    );
    const sha256 = hash(remote);
    if (sha256 !== hash(local)) {
      return yield* new SshRuntimeArchiveValidationError({
        message: `Bundled SSH font ${name} differs from the desktop web client`,
      });
    }
    remaining -= remote.byteLength;
    fonts.set(name, { sha256, bytes: BigInt(remote.byteLength) });
  }

  if (input.platform === "linux") {
    // GNU tar deletes members only from an uncompressed tar.
    const unpacked = path.join(work, "trimmed.tar");
    const gzip = yield* spawner.spawn(
      ChildProcess.make("gzip", ["-dc", source], { stderr: "inherit" }),
    );
    yield* gzip.stdout.pipe(Stream.run(fs.sink(unpacked)));
    if (Number(yield* gzip.exitCode) !== 0) {
      return yield* new SshRuntimeArchiveValidationError({
        message: "Cannot decompress SSH runtime",
      });
    }
    // macOS bsdtar's archives stop short of GNU's 10240-byte record, which breaks --delete.
    yield* runArchiveCommand(input.tar, [
      "--delete",
      "-b",
      "1",
      "-f",
      unpacked,
      ...input.archive.fontMembers,
    ]);
    yield* runArchiveCommand("gzip", ["-n", unpacked]);
    yield* fs.copyFile(unpacked + ".gz", input.destination);
  } else {
    // Read entries from the original archive so a Windows build never has to materialize POSIX links.
    yield* runArchiveCommand(input.tar, [
      "-czf",
      input.destination,
      ...input.archive.fontMembers.flatMap((member) => ["--exclude", member]),
      `@${source}`,
    ]);
  }

  return fonts;
}, Effect.scoped);

const runArchiveCommand = Effect.fn("desktopArtifact.runArchiveCommand")(function* (
  program: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(ChildProcess.make(program, args, { stdin: "ignore" }));
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectUint8StreamText({ stream: child.stdout }),
      collectUint8StreamText({ stream: child.stderr }),
      child.exitCode,
    ],
    { concurrency: "unbounded" },
  );
  if (Number(exitCode) !== 0 || stdout.truncated || stdout.invalidUtf8) {
    return yield* new SshRuntimeArchiveValidationError({
      message: `${program} ${args[0]} failed for SSH runtime: ${stderr.text.trim()}`,
    });
  }
  return stdout.text;
});
