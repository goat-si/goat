import { AgentSessionImportSource } from "@goat/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const decodeImportedTranscriptPayload = Schema.decodeUnknownOption(
  Schema.Struct({
    cwd: Schema.optional(Schema.String),
    importedTranscripts: Schema.optional(Schema.Array(AgentSessionImportSource)),
  }),
);

/** Each imported transcript, keyed by provider instance and file, with its import's cwd. */
export function importedTranscriptsByFile(
  runtimes: ReadonlyArray<{ readonly runtimePayload: unknown }>,
): ReadonlyMap<
  string,
  ReadonlyArray<{ readonly cwd: string; readonly source: AgentSessionImportSource }>
> {
  return Map.groupBy(
    runtimes.flatMap((runtime) => {
      const payload = decodeImportedTranscriptPayload(runtime.runtimePayload);
      if (Option.isNone(payload) || payload.value.cwd === undefined) return [];
      const cwd = payload.value.cwd;
      return (payload.value.importedTranscripts ?? []).map((source) => ({ cwd, source }));
    }),
    ({ source }) => `${source.providerInstanceId}\0${source.filePath}`,
  );
}
