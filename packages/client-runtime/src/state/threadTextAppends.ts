import {
  OrchestrationV2GetThreadProjectionError,
  type OrchestrationV2ResolvedThreadStreamItem,
  type OrchestrationV2ThreadStreamItem,
  type ThreadId,
} from "@goat/contracts";
import { makeThreadTextAppendDecoder } from "@goat/shared/threadTextAppend";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/**
 * Wrap exactly one subscription. A mismatched append fails it as an expected error, so the
 * subscription retries and resumes from its last applied sequence with whole entities.
 */
export const resolveThreadTextAppends = <E, R>(
  threadId: ThreadId,
  stream: Stream.Stream<OrchestrationV2ThreadStreamItem, E, R>,
): Stream.Stream<
  OrchestrationV2ResolvedThreadStreamItem,
  E | OrchestrationV2GetThreadProjectionError,
  R
> =>
  Stream.suspend(() => {
    const decode = makeThreadTextAppendDecoder();
    return Stream.mapEffect(stream, (item) => {
      const resolved = decode(item);
      return resolved === null
        ? Effect.fail(
            new OrchestrationV2GetThreadProjectionError({
              threadId,
              message: "Live thread text went out of step; resynchronizing.",
            }),
          )
        : Effect.succeed(resolved);
    });
  });
