import { GitCommandError, ReviewDiffFileStat } from "@goat/contracts";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Schema from "effect/Schema";

const encodeHash = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.Array(ReviewDiffFileStat)])),
);
const encodeRevisionHash = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Tuple([Schema.String, Schema.Array(ReviewDiffFileStat), Schema.String]),
  ),
);

export const makeReviewDiffHash = Effect.fn("GitVcsDriver.makeReviewDiffHash")(function* (
  crypto: Crypto.Crypto,
  cwd: string,
  metadataOnly: boolean,
) {
  // Metadata has no content identity, so invalidate content caches on each preview.
  const revision = metadataOnly
    ? yield* crypto.randomUUIDv4().pipe(
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              operation: "GitVcsDriver.getReviewDiffPreview.revision",
              command: "crypto.randomUUIDv4",
              cwd,
              detail: "Failed to generate review revision.",
              cause,
            }),
        ),
      )
    : null;
  return Effect.fn("GitVcsDriver.reviewDiffHash")(function* (
    diff: string,
    files: ReadonlyArray<ReviewDiffFileStat>,
  ) {
    const data = new TextEncoder().encode(
      revision === null ? encodeHash([diff, files]) : encodeRevisionHash([diff, files, revision]),
    );
    return yield* crypto.digest("SHA-256", data).pipe(
      Effect.map(Hex.encode),
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation: "GitVcsDriver.getReviewDiffPreview.hash",
            command: "crypto.digest SHA-256",
            cwd,
            detail: "Failed to hash review diff.",
            cause,
          }),
      ),
    );
  });
});
