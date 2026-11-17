import { GitCommandError, ReviewDiffFileStat } from "@goat/contracts";
import * as Digest from "effect/crypto/Digest";
import type * as SecureRandom from "effect/crypto/SecureRandom";
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
  random: SecureRandom.SecureRandom["Service"],
  digest: Digest.Digest["Service"],
  cwd: string,
  metadataOnly: boolean,
) {
  // Metadata has no content identity, so invalidate content caches on each preview.
  const revision = metadataOnly
    ? yield* random.uuidV4().pipe(
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              operation: "GitVcsDriver.getReviewDiffPreview.revision",
              command: "random.uuidV4",
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
    return yield* digest.digest(Digest.sha256, data).pipe(
      Effect.map(Hex.encode),
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation: "GitVcsDriver.getReviewDiffPreview.hash",
            command: "digest.digest SHA-256",
            cwd,
            detail: "Failed to hash review diff.",
            cause,
          }),
      ),
    );
  });
});
