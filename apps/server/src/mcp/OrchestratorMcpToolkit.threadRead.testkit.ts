import { OrchestratorMcpThreadReadResult, type ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";

const decodeThreadRead = Schema.decodeUnknownEffect(OrchestratorMcpThreadReadResult);

/** A tracer that records the context-transfer and message projection queries a call makes. */
export function projectionQueryTracer() {
  const transferReads: Array<string> = [];
  const messageReads: Array<string> = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        const query = span.attributes.get("db.query.text");
        if (typeof query !== "string") return;
        if (/SELECT[\s\S]*FROM orchestration_v2_projection_context_transfers/i.test(query)) {
          transferReads.push(query);
        }
        if (/SELECT\s+payload_json\s+FROM orchestration_v2_projection_messages/i.test(query)) {
          messageReads.push(query);
        }
      };
      return span;
    },
  });
  return { tracer, transferReads, messageReads };
}

/**
 * The full text of the one cut-off item on a goat_thread_read page, read on with `itemId` and
 * `textOffset` until a page reaches its end; `beforePage` runs before each follow-on read.
 */
export const readRestOfItem = <ReadError, CheckError, R>(input: {
  readonly page: unknown;
  readonly threadId: ThreadId;
  readonly read: (
    args: Record<string, unknown>,
  ) => Effect.Effect<{ readonly structuredContent?: unknown }, ReadError, R>;
  readonly beforePage: Effect.Effect<void, CheckError, R>;
}) =>
  Effect.gen(function* () {
    const first = yield* decodeThreadRead(input.page).pipe(Effect.orDie);
    const item = first.items.find((candidate) => candidate.textTruncated);
    if (item === undefined) return "";
    let text = item.text ?? "";
    let textOffset = item.nextTextOffset;
    while (textOffset !== null) {
      yield* input.beforePage;
      const next = yield* input.read({ threadId: input.threadId, itemId: item.itemId, textOffset });
      const page = yield* decodeThreadRead(next.structuredContent).pipe(Effect.orDie);
      text += page.items[0]?.text ?? "";
      textOffset = page.items[0]?.nextTextOffset ?? null;
    }
    return text;
  });
