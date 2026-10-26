import { ComputerUseLeaseThreadUpdate } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";

const decodeUpdate = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ComputerUseLeaseThreadUpdate),
);

/** An unrecognized thread transition cannot leave the previous control authorized. */
export const threadLeaseUpdateLines = <E>(lines: Stream.Stream<string, E>) =>
  lines.pipe(
    Stream.filter((line) => line.trim().length > 0),
    Stream.mapEffect((line) =>
      decodeUpdate(line).pipe(Effect.withSpan("ComputerUseLeaseProxyThread.decodeUpdate")),
    ),
  );
