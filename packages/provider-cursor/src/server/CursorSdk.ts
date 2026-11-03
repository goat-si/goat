import { containRejections } from "@goat/shared/processErrorNet";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { loadCursorSdk, loadCursorSqlite } from "./sdk.ts";

/**
 * After a local exec fails, the SDK writes a final frame to the exec's stream from
 * a promise nothing awaits. If that stream has already closed, the write rejects.
 * The SDK's class is minified, so only its name and message identify it.
 */
const classifyCursorRejection = (reason: unknown) => {
  if (!(reason instanceof Error)) return undefined;
  if (
    reason.name === "WriteIterableClosedError" &&
    reason.message === "WritableIterable is closed"
  ) {
    return "Cursor SDK wrote to a closed exec stream.";
  }
  if (
    reason.name === "ConnectError" &&
    Reflect.get(reason, "code") === 10 &&
    reason.cause instanceof Error &&
    Reflect.get(reason.cause, "code") === "ERR_STREAM_WRITE_AFTER_END"
  ) {
    return "Cursor SDK wrote to an ended request stream.";
  }
  return undefined;
};

/** Keeps Cursor's rejection classifier registered while in-process agents run. */
export class CursorSdk extends Context.Service<
  CursorSdk,
  {
    readonly load: typeof loadCursorSdk;
    readonly loadSqlite: typeof loadCursorSqlite;
  }
>()("@goat/provider-cursor/server/CursorSdk") {}

export const layer = Layer.effect(
  CursorSdk,
  Effect.acquireRelease(
    Effect.sync(() => containRejections(classifyCursorRejection)),
    (release) => Effect.sync(release),
  ).pipe(Effect.as(CursorSdk.of({ load: loadCursorSdk, loadSqlite: loadCursorSqlite }))),
);
