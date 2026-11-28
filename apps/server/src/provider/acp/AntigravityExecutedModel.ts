// @effect-diagnostics nodeBuiltinImport:off -- reads Antigravity transcript.jsonl read-only with O_NOFOLLOW.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { antigravityManagedPath, antigravityProfileRoot } from "./AntigravityProfilePaths.ts";

const NATIVE_ID = /^[A-Za-z0-9-]{1,64}$/;
const TRANSCRIPT_BYTE_CAP = 256 * 1024;

class AntigravityExecutedModelReadError extends Data.TaggedError(
  "AntigravityExecutedModelReadError",
)<{ readonly cause: unknown }> {}

const ExecutedModelTranscriptLine = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.optional(Schema.String),
    model: Schema.optional(Schema.String),
  }),
);
const decodeExecutedModelTranscriptLine = Schema.decodeUnknownOption(ExecutedModelTranscriptLine);

/**
 * The model named on the latest `PLANNER_RESPONSE` since the last user prompt in the session's
 * `transcript.jsonl` tail. agy reports the model it ran only there, not over ACP.
 */
export const readAntigravityExecutedModel = Effect.fn("readAntigravityExecutedModel")(
  function* (input: { readonly profileDirectory: string; readonly sessionId: string }) {
    if (!NATIVE_ID.test(input.sessionId)) return undefined;
    const read = async (): Promise<string | undefined> => {
      const profileRoot = await antigravityProfileRoot(input.profileDirectory);
      if (profileRoot === undefined) return undefined;
      const transcript = await antigravityManagedPath(
        profileRoot,
        [
          "antigravity-acp",
          "brain",
          input.sessionId,
          ".system_generated",
          "logs",
          "transcript.jsonl",
        ],
        "file",
      );
      if (transcript === undefined) return undefined;
      const handle = await NodeFSP.open(
        transcript.path,
        NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) return undefined;
        const start = Math.max(0, stat.size - TRANSCRIPT_BYTE_CAP);
        const buffer = Buffer.alloc(stat.size - start);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
        const lines = buffer.toString("utf8", 0, bytesRead).split("\n");
        for (let index = lines.length - 1; index >= 0; index -= 1) {
          const line = lines[index];
          if (line === undefined) continue;
          const step = Option.getOrUndefined(decodeExecutedModelTranscriptLine(line));
          if (step === undefined) continue;
          if (step.type === "USER_INPUT") return undefined;
          const model = step.type === "PLANNER_RESPONSE" ? step.model?.trim() : undefined;
          if (model) return model;
        }
        return undefined;
      } finally {
        await handle.close();
      }
    };
    return yield* Effect.tryPromise({
      try: read,
      catch: (cause) => new AntigravityExecutedModelReadError({ cause }),
    }).pipe(Effect.orElseSucceed(() => undefined));
  },
);
