// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest.
import * as EffectNodeStream from "@effect/platform-node/NodeStream";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as NodeCrypto from "node:crypto";

import * as ServerConfig from "../config.ts";
import { openZipArchive } from "../zipArchive.ts";

// To bump the pin, pick a version from
// https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json,
// download each platform's chrome-headless-shell zip, and replace the version and every byte count
// and SHA-256 below.
const VERSION = "154.0.8037.92";
export type PreviewBrowserVariant = "headless-shell" | "chrome";

const ARCHIVES = {
  linux64: {
    bytes: 120_477_194,
    sha256: "636aa5c79f2693632e9921b8bbb050038ba11672e02346c06c20f991aed096f9",
  },
  "linux-arm64": {
    bytes: 121_182_296,
    sha256: "0ed0e47d9e9f639197f508d62ada09e5c6b4c4c60edab3160a9312a733091df6",
  },
  "mac-arm64": {
    bytes: 99_221_129,
    sha256: "77da14e75d7f2568e6f7898d3df7cdc6faac74b15e903b2c9d486ebb6ca9b929",
  },
  "mac-x64": {
    bytes: 104_748_425,
    sha256: "a54292aaacbb77f76f6ef47558e7c51ab884044e0adacca315567f83c060bcc4",
  },
  win32: {
    bytes: 114_295_943,
    sha256: "56b30d2d6c35775ebf8dc3618680f6529e1c38c87f7feb28a16e9904273d51f7",
  },
  win64: {
    bytes: 120_822_223,
    sha256: "3ac2561f02d9d87aadc0399d00b9002d718a4c365624fa67db9e7bfaf6b1a568",
  },
} as const;

const CHROME_ARCHIVES = {
  linux64: {
    bytes: 196_202_491,
    sha256: "ff43322f335e436b2f4dcdfeeec5db032299e335a7e8c1c618b326e100ce8732",
    executablePath: "chrome",
  },
  "linux-arm64": {
    bytes: 196_517_840,
    sha256: "c0af361aab66b24c72e36a4326dce4d7edf4bc23f9aede8af988c2cb6ea3fec0",
    executablePath: "chrome",
  },
  "mac-arm64": {
    bytes: 191_153_086,
    sha256: "b62e904b6571c5ff5108ed7812cf93ac6d1c4027f10ae47ac34d8e229ed88001",
    executablePath: "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  },
  "mac-x64": {
    bytes: 202_045_791,
    sha256: "9ddd0959603a3cdb90926427b2942279d81414c9aad856c97d405bb406d50e8b",
    executablePath: "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  },
  win32: {
    bytes: 184_469_809,
    sha256: "ed07adc92a948b215fe75d86b02ceb1b6993cad7979d2437e836aaea6b3679d4",
    executablePath: "chrome.exe",
  },
  win64: {
    bytes: 205_614_867,
    sha256: "b897ef3601c947ac0620c784556dec719ac602b0159ce105927acf645ee0f598",
    executablePath: "chrome.exe",
  },
} as const;

const chromePlatform = (platform: NodeJS.Platform, arch: NodeJS.Architecture) => {
  switch (platform) {
    case "linux":
      return arch === "x64" ? "linux64" : arch === "arm64" ? "linux-arm64" : null;
    case "darwin":
      return arch === "arm64" ? "mac-arm64" : arch === "x64" ? "mac-x64" : null;
    case "win32":
      // There is no Windows arm64 build; Windows on Arm runs the x64 one under emulation.
      return arch === "ia32" ? "win32" : arch === "x64" || arch === "arm64" ? "win64" : null;
    default:
      return null;
  }
};

export interface PreviewBrowserRelease {
  readonly version: string;
  readonly platform: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly rootDir?: string;
  readonly executablePath?: string;
}

const previewBrowserRelease = (
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
  variant: PreviewBrowserVariant = "headless-shell",
): PreviewBrowserRelease | null => {
  const chrome = chromePlatform(platform, arch);
  return chrome === null
    ? null
    : variant === "chrome"
      ? {
          version: VERSION,
          platform: chrome,
          url: `https://storage.googleapis.com/chrome-for-testing-public/${VERSION}/${chrome}/chrome-${chrome}.zip`,
          rootDir: `chrome-${chrome}/`,
          ...CHROME_ARCHIVES[chrome],
        }
      : {
          version: VERSION,
          platform: chrome,
          url: `https://storage.googleapis.com/chrome-for-testing-public/${VERSION}/${chrome}/chrome-headless-shell-${chrome}.zip`,
          ...ARCHIVES[chrome],
        };
};

const megabytes = (bytes: number) => Math.round(bytes / 1_000_000);

export class PreviewBrowserInstallError extends Schema.TaggedError<PreviewBrowserInstallError>()(
  "PreviewBrowserInstallError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `GOAT could not install its headless browser: ${this.detail} Try again.`;
  }
}
const isInstallError = Schema.is(PreviewBrowserInstallError);

export class PreviewBrowserInstallingError extends Schema.TaggedError<PreviewBrowserInstallingError>()(
  "PreviewBrowserInstallingError",
  { downloadedBytes: Schema.Number, totalBytes: Schema.Number, unpacking: Schema.Boolean },
) {
  override get message(): string {
    const progress = this.unpacking
      ? "unpacking"
      : `${megabytes(this.downloadedBytes)} of ${megabytes(this.totalBytes)} MB downloaded`;
    return `GOAT is installing its headless browser (${progress}). Try again in a minute.`;
  }
}

export class PreviewBrowserUnsupportedError extends Schema.TaggedError<PreviewBrowserUnsupportedError>()(
  "PreviewBrowserUnsupportedError",
  { platform: Schema.String, arch: Schema.String },
) {
  override get message(): string {
    return `GOAT's headless browser is not available on ${this.platform}-${this.arch}: Chrome for Testing has no headless shell for it.`;
  }
}

export class PreviewBrowser extends Context.Service<
  PreviewBrowser,
  {
    /**
     * Path to the installed headless shell. The first call starts the
     * install; callers wait for it up to a bound and then get its progress
     * instead, while the install keeps running.
     */
    readonly executable: Effect.Effect<
      string,
      PreviewBrowserInstallError | PreviewBrowserInstallingError | PreviewBrowserUnsupportedError
    >;
    readonly installed: Effect.Effect<Option.Option<string>>;
  }
>()("goat/preview/PreviewBrowser") {}

export interface PreviewBrowserOptions {
  readonly baseDir: string;
  readonly release?: PreviewBrowserRelease | null;
  readonly variant?: PreviewBrowserVariant;
  readonly executablePath?: string;
  /** How long a caller waits on an install in progress. Provider tool calls time out near 60s. */
  readonly wait?: Duration.Input;
}

const DOWNLOAD_TIMEOUT = "15 minutes";
const STAGING_STALE_AFTER_MS = 60 * 60_000;
const MAX_SYMLINK_BYTES = 4_096;
const MAX_SYMLINK_HOPS = 40;

const wrapFailure = (detail: string) => (cause: unknown) =>
  isInstallError(cause) ? cause : new PreviewBrowserInstallError({ detail, cause });

type InstallState =
  | { readonly _tag: "idle" }
  | {
      readonly _tag: "installing";
      readonly done: Deferred.Deferred<string, PreviewBrowserInstallError>;
    }
  | { readonly _tag: "installed"; readonly executable: string }
  | { readonly _tag: "failed"; readonly error: PreviewBrowserInstallError };

export const makePreviewBrowser = Effect.fn("PreviewBrowser.make")(function* (
  options: PreviewBrowserOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  // Installs belong to the service, so they finish even when no caller is still waiting.
  const serviceScope = yield* Effect.scope;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const env = yield* HostProcess.Environment;
  const variant: PreviewBrowserVariant =
    options.variant ??
    (env.GOAT_SERVER_BROWSER_VARIANT?.trim() === "chrome" ? "chrome" : "headless-shell");
  const customExecutablePath =
    (options.executablePath ?? env.GOAT_SERVER_BROWSER_EXECUTABLE_PATH)?.trim() || undefined;
  const release =
    options.release === undefined
      ? previewBrowserRelease(platform, arch, variant)
      : options.release;
  const wait = options.wait ?? "45 seconds";
  const toolDirectory = variant === "chrome" ? "chrome" : "chrome-headless-shell";
  const installRoot = path.join(
    options.baseDir,
    "tools",
    toolDirectory,
    release?.platform ?? `${platform}-${arch}`,
  );
  const defaultExecutableName =
    platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell";
  const releaseExecutableRelative = (targetRelease: PreviewBrowserRelease) =>
    targetRelease.executablePath ?? defaultExecutableName;
  const releaseExecutablePath = (targetRelease: PreviewBrowserRelease) =>
    path.join(
      installRoot,
      targetRelease.version,
      ...releaseExecutableRelative(targetRelease).split("/"),
    );
  const gate = yield* Semaphore.make(1);
  let state: InstallState = { _tag: "idle" };
  const progress = { downloadedBytes: 0, unpacking: false };

  const runnableExecutable = (candidate: string) =>
    fs.stat(candidate).pipe(
      Effect.map((info) =>
        info.type === "File" && (platform === "win32" || (info.mode & 0o111) !== 0)
          ? Option.some(candidate)
          : Option.none<string>(),
      ),
      Effect.orElseSucceed(() => Option.none<string>()),
    );

  const installedExecutable = (targetRelease: PreviewBrowserRelease) =>
    runnableExecutable(releaseExecutablePath(targetRelease));

  const download = Effect.fn("PreviewBrowser.download")(
    function* (release: PreviewBrowserRelease, archivePath: string) {
      const response = yield* http
        .execute(HttpClientRequest.get(release.url))
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
      const contentLength = response.headers["content-length"];
      const contentEncoding = response.headers["content-encoding"]?.trim().toLowerCase();
      if (
        (contentEncoding === undefined || contentEncoding === "identity") &&
        contentLength !== undefined &&
        Number(contentLength) !== release.bytes
      ) {
        return yield* new PreviewBrowserInstallError({
          detail: "The download size did not match the pinned release.",
        });
      }
      const hash = NodeCrypto.createHash("sha256");
      yield* response.stream.pipe(
        Stream.tap((chunk) =>
          Effect.suspend(() => {
            progress.downloadedBytes += chunk.byteLength;
            if (progress.downloadedBytes > release.bytes) {
              return Effect.fail(
                new PreviewBrowserInstallError({
                  detail: "The download was larger than the pinned release.",
                }),
              );
            }
            hash.update(chunk);
            return Effect.void;
          }),
        ),
        Stream.run(fs.sink(archivePath, { flag: "wx", mode: 0o600 })),
      );
      if (progress.downloadedBytes !== release.bytes || hash.digest("hex") !== release.sha256) {
        return yield* new PreviewBrowserInstallError({
          detail: "The download failed its size or SHA-256 check. Nothing was installed.",
        });
      }
    },
    Effect.timeout(DOWNLOAD_TIMEOUT),
    Effect.mapError(
      wrapFailure(
        "The download from storage.googleapis.com failed. Check this machine's network access.",
      ),
    ),
  );

  const extract = Effect.fn("PreviewBrowser.extract")(
    function* (release: PreviewBrowserRelease, archivePath: string, destination: string) {
      const archive = yield* openZipArchive(
        archivePath,
        (detail, cause) => new PreviewBrowserInstallError({ detail, cause }),
      );
      const unsafe = new PreviewBrowserInstallError({
        detail: "The archive contains an unexpected or unsafe entry.",
      });
      const root = release.rootDir ?? `chrome-headless-shell-${release.platform}/`;
      const expectedExecutable = releaseExecutableRelative(release);
      const pendingSymlinks: Array<{
        readonly relative: string;
        readonly target: string;
        readonly linkTarget: string;
      }> = [];
      yield* fs.makeDirectory(destination);
      let foundExecutable = false;
      for (;;) {
        const entry = yield* archive.next;
        if (!entry) break;
        const unixMode = entry.externalFileAttributes >>> 16;
        const unixType = unixMode & 0o170000;
        const isDirectory = entry.fileName.endsWith("/");
        const isSymlink = unixType === 0o120000;
        const relative = entry.fileName.startsWith(root) ? entry.fileName.slice(root.length) : null;
        const target = relative === null ? null : path.resolve(destination, relative);
        if (
          relative === null ||
          target === null ||
          (relative !== "" && !target.startsWith(`${destination}${path.sep}`)) ||
          relative.split("/").includes("..") ||
          (isSymlink && (isDirectory || relative === "")) ||
          (!isSymlink && unixType !== 0 && unixType !== (isDirectory ? 0o040000 : 0o100000)) ||
          (entry.generalPurposeBitFlag & 1) !== 0 ||
          ![0, 8].includes(entry.compressionMethod)
        ) {
          return yield* unsafe;
        }
        if (isSymlink) {
          if (entry.uncompressedSize === 0 || entry.uncompressedSize > MAX_SYMLINK_BYTES) {
            return yield* unsafe;
          }
          const linkTarget = yield* Effect.gen(function* () {
            const readable = yield* archive.streamEntry(entry);
            const chunks: Array<Uint8Array> = [];
            let total = 0;
            yield* EffectNodeStream.fromReadable<Uint8Array, PreviewBrowserInstallError>({
              evaluate: () => readable,
              onError: wrapFailure("Could not unpack the browser."),
            }).pipe(
              Stream.runForEach((chunk) =>
                Effect.suspend(() => {
                  total += chunk.byteLength;
                  if (total > MAX_SYMLINK_BYTES) return Effect.fail(unsafe);
                  chunks.push(chunk);
                  return Effect.void;
                }),
              ),
            );
            return Buffer.concat(chunks).toString("utf8");
          }).pipe(Effect.scoped);
          if (
            linkTarget === "" ||
            linkTarget.includes(" ") ||
            linkTarget.includes("\\") ||
            linkTarget.startsWith("/") ||
            path.isAbsolute(linkTarget) ||
            /^[a-zA-Z]:/.test(linkTarget)
          ) {
            return yield* unsafe;
          }
          pendingSymlinks.push({ relative, target, linkTarget });
          continue;
        }
        if (isDirectory) {
          yield* fs.makeDirectory(target, { recursive: true });
          continue;
        }
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        yield* Effect.gen(function* () {
          const readable = yield* archive.streamEntry(entry);
          yield* EffectNodeStream.fromReadable<Uint8Array, PreviewBrowserInstallError>({
            evaluate: () => readable,
            onError: wrapFailure("Could not unpack the browser."),
          }).pipe(Stream.run(fs.sink(target, { flag: "wx" })));
        }).pipe(Effect.scoped);
        // The binary and its shared libraries carry exec bits in the archive.
        if (platform !== "win32" && (unixMode & 0o777) !== 0) {
          yield* fs.chmod(target, unixMode & 0o777);
        }
        if (relative === expectedExecutable) foundExecutable = true;
      }
      if (pendingSymlinks.length > 0) {
        const symlinkMap = new Map<string, string>();
        for (const item of pendingSymlinks) {
          if (symlinkMap.has(item.relative)) return yield* unsafe;
          symlinkMap.set(item.relative, item.linkTarget);
        }
        const withinDestination = (candidate: string) =>
          candidate.startsWith(`${destination}${path.sep}`);
        const resolveLexicalChain = (startRelative: string): boolean => {
          let currentRel = startRelative;
          for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop++) {
            const parts = currentRel.split("/");
            let prefix = "";
            let followed = false;
            for (const [i, part] of parts.entries()) {
              prefix = prefix === "" ? part : `${prefix}/${part}`;
              const link = symlinkMap.get(prefix);
              if (link !== undefined) {
                const baseDir = path.dirname(path.resolve(destination, prefix));
                const resolvedLink = path.resolve(baseDir, link);
                if (!withinDestination(resolvedLink)) return false;
                const rest = parts.slice(i + 1).join("/");
                const nextTarget = rest === "" ? resolvedLink : path.resolve(resolvedLink, rest);
                if (!withinDestination(nextTarget)) return false;
                currentRel = nextTarget
                  .slice(destination.length + 1)
                  .split(path.sep)
                  .join("/");
                followed = true;
                break;
              }
            }
            if (!followed) return true;
          }
          return false;
        };
        for (const item of pendingSymlinks) {
          const parts = item.relative.split("/");
          let ancestor = "";
          for (const part of parts.slice(0, -1)) {
            ancestor = ancestor === "" ? part : `${ancestor}/${part}`;
            if (symlinkMap.has(ancestor)) return yield* unsafe;
          }
          const resolvedImmediate = path.resolve(path.dirname(item.target), item.linkTarget);
          if (!withinDestination(resolvedImmediate) || !resolveLexicalChain(item.relative)) {
            return yield* unsafe;
          }
        }
        for (const item of pendingSymlinks) {
          yield* fs.makeDirectory(path.dirname(item.target), { recursive: true });
          yield* fs.symlink(item.linkTarget, item.target);
        }
      }
      if (!foundExecutable) {
        return yield* new PreviewBrowserInstallError({
          detail: `The archive does not contain ${expectedExecutable}.`,
        });
      }
    },
    Effect.scoped,
    Effect.mapError(
      wrapFailure("Could not unpack the browser. Check free disk space in GOAT's home directory."),
    ),
  );

  const install = Effect.fn("PreviewBrowser.install")(
    function* (release: PreviewBrowserRelease) {
      yield* Effect.gen(function* () {
        yield* fs.makeDirectory(installRoot, { recursive: true });
        // Staging shares the install root's filesystem so publishing is one rename.
        const staging = yield* fs.makeTempDirectoryScoped({
          directory: installRoot,
          prefix: ".install-",
        });
        const archivePath = path.join(staging, "download.zip");
        const unpacked = path.join(staging, "browser");
        yield* download(release, archivePath);
        progress.unpacking = true;
        yield* extract(release, archivePath, unpacked);
        const destination = path.join(installRoot, release.version);
        yield* fs.remove(destination, { recursive: true, force: true });
        yield* fs.rename(unpacked, destination);
      }).pipe(Effect.scoped);
      // Two servers can share a home, so a staging directory touched within the
      // last hour may be another server's install in progress and stays.
      const entries = yield* fs.readDirectory(installRoot);
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.forEach(
        entries.filter((name) => name !== release.version),
        (name) =>
          Effect.gen(function* () {
            const target = path.join(installRoot, name);
            if (name.startsWith(".install-")) {
              const info = yield* fs.stat(target);
              const modifiedAt = Option.match(info.mtime, {
                onNone: () => now,
                onSome: (date) => date.getTime(),
              });
              if (now - modifiedAt < STAGING_STALE_AFTER_MS) return;
            }
            yield* fs.remove(target, { recursive: true, force: true });
          }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not remove an old preview browser.", { name, cause }),
            ),
          ),
        { discard: true },
      );
      return releaseExecutablePath(release);
    },
    Effect.mapError(wrapFailure("Could not save the browser in GOAT's home directory.")),
  );

  const join = (release: PreviewBrowserRelease) =>
    gate.withPermit(
      Effect.gen(function* () {
        if (state._tag === "installing") return state;
        if (state._tag === "failed") {
          const failed = state;
          state = { _tag: "idle" };
          return failed;
        }
        const installed = yield* installedExecutable(release);
        if (Option.isSome(installed)) {
          state = { _tag: "installed", executable: installed.value };
          return state;
        }
        const done = yield* Deferred.make<string, PreviewBrowserInstallError>();
        progress.downloadedBytes = 0;
        progress.unpacking = false;
        const installing: InstallState = { _tag: "installing", done };
        state = installing;
        yield* install(release).pipe(
          Effect.onExit((exit) =>
            gate
              .withPermit(
                Effect.sync(() => {
                  state = Exit.isSuccess(exit)
                    ? { _tag: "installed", executable: exit.value }
                    : {
                        _tag: "failed",
                        error: Option.getOrElse(
                          Cause.findErrorOption(exit.cause),
                          () => new PreviewBrowserInstallError({ detail: "The install stopped." }),
                        ),
                      };
                }),
              )
              .pipe(Effect.andThen(Deferred.done(done, exit))),
          ),
          Effect.ignoreCause,
          Effect.interruptible,
          Effect.forkIn(serviceScope),
        );
        return installing;
      }),
    );

  const clearFailure = (error: PreviewBrowserInstallError) =>
    gate.withPermit(
      Effect.sync(() => {
        if (state._tag === "failed" && state.error === error) state = { _tag: "idle" };
      }),
    );

  const executable = Effect.gen(function* () {
    if (customExecutablePath !== undefined) {
      const runnable = yield* runnableExecutable(customExecutablePath);
      return Option.isSome(runnable)
        ? runnable.value
        : yield* new PreviewBrowserInstallError({
            detail: `The custom browser executable at '${customExecutablePath}' is missing or not executable.`,
          });
    }
    if (release === null) {
      return yield* new PreviewBrowserUnsupportedError({ platform, arch });
    }
    const current = yield* join(release);
    switch (current._tag) {
      case "installed":
        return current.executable;
      case "failed":
        return yield* current.error;
      case "installing":
        return yield* Deferred.await(current.done).pipe(
          Effect.tapError(clearFailure),
          Effect.timeoutOrElse({
            duration: wait,
            orElse: () =>
              Effect.fail(
                new PreviewBrowserInstallingError({
                  downloadedBytes: progress.downloadedBytes,
                  totalBytes: release.bytes,
                  unpacking: progress.unpacking,
                }),
              ),
          }),
        );
    }
  }).pipe(Effect.withSpan("PreviewBrowser.executable"));

  const installed =
    customExecutablePath !== undefined
      ? runnableExecutable(customExecutablePath)
      : release === null
        ? Effect.succeedNone
        : installedExecutable(release);

  return PreviewBrowser.of({ executable, installed });
});

export const layer = Layer.effect(
  PreviewBrowser,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return yield* makePreviewBrowser({ baseDir: config.baseDir });
  }),
);
