import { type UsageSummary, type UsageSummaryInput, WS_METHODS } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { request } from "../rpc/client.ts";

/**
 * With nothing to show yet, the server's last scan answers first, then a plain
 * read, then a read that waits for slow sources.
 */
export function readUsageSummary(
  input: UsageSummaryInput,
  emit: (summary: UsageSummary) => Effect.Effect<void>,
  previous: Option.Option<UsageSummary>,
) {
  const settled = (summary: UsageSummary) =>
    !summary.sources.some((source) => source.refreshing === true);
  const read = request(WS_METHODS.serverGetUsageSummary, input).pipe(
    Effect.filterOrElse(settled, (summary) =>
      emit(summary).pipe(
        Effect.andThen(request(WS_METHODS.serverGetUsageSummary, { ...input, awaitRefresh: true })),
        Effect.catch((error) =>
          Effect.logWarning("Could not refresh slow usage sources.").pipe(
            Effect.annotateLogs({ ...safeErrorLogAttributes(error) }),
            Effect.as(summary),
          ),
        ),
      ),
    ),
  );
  if (Option.isSome(previous)) return read;
  return request(WS_METHODS.serverGetUsageSummary, { ...input, provisional: true }).pipe(
    Effect.matchEffect({
      // The saved answer only speeds things up; without it the plain read still answers.
      onFailure: () => read,
      onSuccess: (saved) =>
        settled(saved) ? Effect.succeed(saved) : emit(saved).pipe(Effect.andThen(read)),
    }),
  );
}
