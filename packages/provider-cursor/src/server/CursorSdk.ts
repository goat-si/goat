import { containRejections } from "@goat/shared/processErrorNet";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Agent, createAgentPlatform, SqliteLocalAgentStore } from "./sdk.ts";

/**
 * After a local exec fails, the SDK writes a final frame to the exec's stream from
 * a promise nothing awaits. If that stream has already closed, the write rejects.
 * The SDK's class is minified, so only its name and message identify it.
 */
const classifyCursorRejection = (reason: unknown) =>
  reason instanceof Error &&
  reason.name === "WriteIterableClosedError" &&
  reason.message === "WritableIterable is closed"
    ? "Cursor SDK wrote to a closed exec stream."
    : undefined;

/** Keeps Cursor's rejection classifier registered while in-process agents run. */
export class CursorSdk extends Context.Service<
  CursorSdk,
  {
    readonly Agent: typeof Agent;
    readonly createAgentPlatform: typeof createAgentPlatform;
    readonly SqliteLocalAgentStore: typeof SqliteLocalAgentStore;
  }
>()("@goat/provider-cursor/server/CursorSdk") {}

export const layer = Layer.effect(
  CursorSdk,
  Effect.acquireRelease(
    Effect.sync(() => containRejections(classifyCursorRejection)),
    (release) => Effect.sync(release),
  ).pipe(Effect.as(CursorSdk.of({ Agent, createAgentPlatform, SqliteLocalAgentStore }))),
);
