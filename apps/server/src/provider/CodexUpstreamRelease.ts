import { parseChecksums } from "@goat/shared/cliRelease";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { Version, type CodexReleaseAsset } from "./CodexInstallationRelease.ts";

const UPSTREAM_LATEST_URL = "https://registry.npmjs.org/@openai/codex/latest";
const UPSTREAM_RELEASES_URL = "https://github.com/openai/codex/releases/download";
// An upstream release has no recorded size; current packages are about 160 MB.
export const UPSTREAM_MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const decodeNpmLatest = Schema.decodeUnknownEffect(Schema.Struct({ version: Version }));

// npm names the latest stable release; its GitHub release lists the package
// checksums, so an upstream update stays SHA-256 verified.
export const lookupCodexUpstreamRelease = Effect.fn("CodexInstallation.lookupUpstream")(
  function* (input: {
    readonly http: HttpClient.HttpClient;
    readonly target: string;
    readonly isSupported: (version: string) => Effect.Effect<boolean>;
  }) {
    const latest = yield* input.http
      .execute(HttpClientRequest.get(UPSTREAM_LATEST_URL))
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
    const { version } = yield* latest.json.pipe(Effect.flatMap(decodeNpmLatest));
    // Managed resolution refuses anything else, so offering it would break sessions.
    if (!(yield* input.isSupported(version))) return null;
    const releaseUrl = `${UPSTREAM_RELEASES_URL}/rust-v${version}`;
    const checksums = yield* input.http
      .execute(HttpClientRequest.get(`${releaseUrl}/codex-package_SHA256SUMS`))
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.text),
      );
    const fileName = `codex-package-${input.target}.tar.gz`;
    const sha256 = parseChecksums(checksums).get(fileName);
    if (!sha256) return null;
    return {
      version,
      target: input.target,
      url: `${releaseUrl}/${fileName}`,
      sha256,
      archiveBytes: null,
    } satisfies CodexReleaseAsset;
  },
);
