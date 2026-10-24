import { useAtomValue } from "@effect/atom-react";
import {
  CLI_ARCHIVE_PLATFORM_KEYS,
  CLI_RELEASE_REPOSITORY,
  cliArchiveFileName,
} from "@goat/shared/cliRelease";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { AsyncResult, Atom } from "effect/reactivity";

const Release = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.Boolean,
  assets: Schema.Array(Schema.Struct({ name: Schema.String })),
});
const decodeRelease = Schema.decodeUnknownEffect(Release);

export const cliReleasePublishedAtom = Atom.family((version: string) =>
  Atom.make(
    Effect.gen(function* () {
      const response = yield* HttpClient.get(
        `https://api.github.com/repos/${CLI_RELEASE_REPOSITORY}/releases/tags/v${encodeURIComponent(version)}`,
      );
      if (response.status === 404) return false;
      const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
        Effect.flatMap((ok) => ok.json),
      );
      const release = yield* decodeRelease(body);
      const names = new Set(release.assets.map((asset) => asset.name));
      return (
        !release.draft &&
        release.tag_name === `v${version}` &&
        names.has("SHA256SUMS") &&
        CLI_ARCHIVE_PLATFORM_KEYS.every((key) => names.has(cliArchiveFileName(version, key)))
      );
    }).pipe(
      // This public metadata check needs no credentials or tracing headers.
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.provide(FetchHttpClient.layer),
    ),
  ).pipe(
    Atom.withRefresh("5 minutes"),
    Atom.keepAlive,
    Atom.withLabel(`cli-release-published:${version}`),
  ),
);

const NO_VERSION_ATOM = Atom.make(AsyncResult.success(false)).pipe(
  Atom.withLabel("cli-release-published:none"),
);

export function useCliReleasePublished(version: string | null): boolean {
  const result = useAtomValue(version ? cliReleasePublishedAtom(version) : NO_VERSION_ATOM);
  return AsyncResult.getOrElse(result, () => false);
}
