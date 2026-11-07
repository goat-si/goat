import type { ProviderInstanceId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeBase = Schema.decodeUnknownOption(
  Schema.Struct({ thread_id: Schema.String, end_byte_offset: Schema.Number }),
);
const rolloutId = /[-_]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

type RecordWithBase = {
  readonly type?: string | undefined;
  readonly payload?: { readonly history_base?: unknown } | undefined;
};

export function makeCodexInheritedHistory<T extends RecordWithBase, E, R>(options: {
  readonly candidates: ReadonlyArray<{
    readonly source: string;
    readonly providerInstanceId: ProviderInstanceId;
    readonly transcripts: ReadonlyArray<{ readonly filePath: string }>;
  }>;
  readonly read: (
    path: string,
    offset: number,
    historyBytes: number,
  ) => Effect.Effect<
    { readonly records: ReadonlyArray<T>; readonly historyBytes: number } | null,
    E,
    R
  >;
}) {
  const pathsByProvider = new Map<ProviderInstanceId, ReadonlyMap<string, string>>();
  const baseOf = (records: ReadonlyArray<T>) => {
    const base = Option.getOrUndefined(
      decodeBase(records.find((record) => record.type === "session_meta")?.payload?.history_base),
    );
    return base !== undefined &&
      Number.isSafeInteger(base.end_byte_offset) &&
      base.end_byte_offset >= 0
      ? base
      : undefined;
  };
  return Effect.fn("AgentSessionScanner.readCodexHistoryBase")(function* (
    provider: ProviderInstanceId,
    records: ReadonlyArray<T>,
    historyBytes: number,
  ) {
    let paths = pathsByProvider.get(provider);
    if (paths === undefined) {
      paths = new Map(
        options.candidates.flatMap((candidate) =>
          candidate.source === "codex" && candidate.providerInstanceId === provider
            ? candidate.transcripts.flatMap((transcript) => {
                const id = rolloutId.exec(transcript.filePath)?.[1];
                return id === undefined ? [] : [[id, transcript.filePath] as const];
              })
            : [],
        ),
      );
      pathsByProvider.set(provider, paths);
    }
    const prefixes: Array<ReadonlyArray<T>> = [];
    const visited = new Set<string>();
    for (let base = baseOf(records); base !== undefined;) {
      const path = visited.has(base.thread_id) ? undefined : paths.get(base.thread_id);
      if (path === undefined) return null;
      visited.add(base.thread_id);
      const inherited = yield* options.read(path, base.end_byte_offset, historyBytes);
      if (inherited === null) return null;
      historyBytes = inherited.historyBytes;
      prefixes.unshift(inherited.records.filter((record) => record.type !== "session_meta"));
      base = baseOf(inherited.records);
    }
    return prefixes.flat();
  });
}
