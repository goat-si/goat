import { compareSemverVersions } from "@goat/shared/semver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";

/** The pinned release comes from dl.google.com and the native CLI from Google's storage bucket. */
export const ANTIGRAVITY_DOWNLOAD_HOSTS: ReadonlySet<string> = new Set([
  "dl.google.com",
  "storage.googleapis.com",
]);

/** Fails the request instead of following a redirect the host allow-list never saw. */
export const refuseRedirects = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, FetchHttpClient.RequestInit, { redirect: "error" });

const ANTIGRAVITY_CLI_MANIFEST_BASE =
  "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";

const Manifest = Schema.Struct({
  version: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/u)),
  url: Schema.String,
  sha512: Schema.String.check(Schema.isPattern(/^[a-fA-F0-9]{128}$/u)),
});
const decodeManifest = Schema.decodeUnknownOption(Manifest);

export interface AntigravityCliReleaseAsset {
  readonly version: string;
  readonly url: string;
  readonly sha512: string;
  readonly executable: { readonly name: string };
  readonly format: "tar.gz" | "executable";
}

export function antigravityCliTarget(platform: NodeJS.Platform, arch: string, musl = false) {
  if (!["darwin", "linux", "win32"].includes(platform) || !["x64", "arm64"].includes(arch)) {
    return null;
  }
  const os = platform === "win32" ? "windows" : platform;
  return `${os}_${arch === "x64" ? "amd64" : arch}${platform === "linux" && musl ? "_musl" : ""}`;
}

export function parseAntigravityCliRelease(
  value: unknown,
  platform: NodeJS.Platform,
  arch: string,
  musl = false,
): AntigravityCliReleaseAsset | null {
  const decoded = decodeManifest(value);
  if (decoded._tag === "None" || antigravityCliTarget(platform, arch, musl) === null) return null;
  const manifest = decoded.value;
  if (compareSemverVersions(manifest.version, "1.5.0") < 0) return null;
  const os = platform === "darwin" ? "mac" : platform === "win32" ? "windows" : "linux";
  const cpu = arch === "x64" ? "x64" : "arm64";
  const suffix = platform === "linux" && musl ? "_musl" : "";
  const extension = platform === "win32" ? "exe" : "tar.gz";
  const folder = `${platform === "win32" ? "windows" : platform}-${arch === "arm64" ? "arm" : "x64"}${suffix ? "-musl" : ""}`;
  const prefix = `https://storage.googleapis.com/antigravity-public/antigravity-cli/${manifest.version}-`;
  const rest = manifest.url.startsWith(prefix) ? manifest.url.slice(prefix.length) : "";
  if (
    !/^\d+\//u.test(rest) ||
    rest.replace(/^\d+\//u, "") !== `${folder}/cli_${os}_${cpu}${suffix}.${extension}`
  ) {
    return null;
  }
  return {
    version: manifest.version,
    url: manifest.url,
    sha512: manifest.sha512.toLowerCase(),
    executable: { name: platform === "win32" ? "agy.exe" : "antigravity" },
    format: platform === "win32" ? "executable" : "tar.gz",
  };
}

/** Whether this is a musl Linux, which has its own native CLI build and no pinned runtime. */
export const hostUsesMusl = (input: {
  readonly fs: FileSystem.FileSystem;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}) =>
  input.platform === "linux"
    ? input.fs
        .exists(
          input.arch === "arm64" ? "/lib/libc.musl-aarch64.so.1" : "/lib/libc.musl-x86_64.so.1",
        )
        .pipe(Effect.orElseSucceed(() => false))
    : Effect.succeed(false);

/** Reads Google's CLI manifest for this host; null when it is unreachable or unusable. */
export const lookupAntigravityCliRelease = Effect.fn("AntigravityInstallation.lookupCliRelease")(
  function* (input: {
    readonly http: HttpClient.HttpClient;
    readonly fs: FileSystem.FileSystem;
    readonly platform: NodeJS.Platform;
    readonly arch: string;
  }) {
    const { http, platform, arch } = input;
    const musl = yield* hostUsesMusl(input);
    const target = antigravityCliTarget(platform, arch, musl);
    if (target === null) return null;
    return yield* http.get(`${ANTIGRAVITY_CLI_MANIFEST_BASE}/${target}.json`).pipe(
      refuseRedirects,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.map((json) => parseAntigravityCliRelease(json, platform, arch, musl)),
      Effect.timeout("10 seconds"),
      Effect.orElseSucceed(() => null),
    );
  },
);
