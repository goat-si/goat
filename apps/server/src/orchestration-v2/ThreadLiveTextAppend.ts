import type { OrchestrationV2ThreadStreamItem } from "@goat/contracts";
import { makeThreadTextAppendEncoder } from "@goat/shared/threadTextAppend";
import * as Stream from "effect/Stream";

import { makeLiveBodyDeduper } from "./WireProjection.ts";

/**
 * Wraps a whole subscription (snapshot or replay, then live tail): the deduper and the append
 * encoder must each see every delivered record, and appends are encoded after dedupe.
 */
export const withLiveWireTransforms =
  (input: { readonly acceptDedupedBodies?: boolean; readonly acceptTextAppends?: boolean }) =>
  <E, R>(
    stream: Stream.Stream<OrchestrationV2ThreadStreamItem, E, R>,
  ): Stream.Stream<OrchestrationV2ThreadStreamItem, E, R> => {
    const deduped =
      input.acceptDedupedBodies === true
        ? Stream.suspend(() => Stream.map(stream, makeLiveBodyDeduper()))
        : stream;
    return input.acceptTextAppends === true
      ? Stream.suspend(() => Stream.map(deduped, makeThreadTextAppendEncoder()))
      : deduped;
  };
