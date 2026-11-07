import { IsoDateTime } from "@goat/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Json from "./gitCafePullRequestJson.ts";

// A pull action replies with the pull it left; `closedAt`/`mergedAt` are read only when sent.
const decodeActionReply = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      ...Json.GitCafePull.fields,
      closedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
      mergedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
    }),
  ),
);

export function gitCafeActionSummary(
  reply: string,
  input: { readonly host: string; readonly repository: string },
) {
  const left = decodeActionReply(reply);
  if (Option.isNone(left)) return;
  // The reply carries no line totals or conflict state, so they stay absent.
  const {
    additions: _additions,
    deletions: _deletions,
    mergeability: _mergeability,
    ...summary
  } = Json.toChangeRequest(left.value, input);
  return {
    ...summary,
    ...(left.value.headOid === null ? {} : { headSha: left.value.headOid }),
    ...(left.value.closedAt === undefined ? {} : { closedAt: left.value.closedAt }),
    ...(left.value.mergedAt === undefined ? {} : { mergedAt: left.value.mergedAt }),
  };
}
