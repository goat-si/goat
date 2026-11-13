// @effect-diagnostics-next-line nodeBuiltinImport:off -- Paths resolve like Codex's own config pointer.
import * as NodePath from "node:path";

import { expandHomePath } from "@goat/provider-core/server/pathExpansion";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

/** Larger files are not Codex catalogs GOAT can compare; such a process is never called outdated. */
const MAX_CATALOG_BYTES = 64 * 1024 * 1024;

type Entries = ReadonlyMap<string, string>;

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const parseEntries = (text: string): Entries | undefined => {
  try {
    const models = record(JSON.parse(text))?.models;
    if (!Array.isArray(models)) return undefined;
    const entries = new Map<string, string>();
    for (const model of models) {
      const slug = record(model)?.slug;
      if (typeof slug === "string") entries.set(slug, JSON.stringify(model));
    }
    return entries;
  } catch {
    return undefined;
  }
};

/**
 * Codex's app-server reads `model_catalog_json` once, at startup, and keeps using that copy. A model
 * is outdated when the file now describes it differently from what the process read. When GOAT
 * cannot know what the process read, because the file changed after the process started and before
 * GOAT first looked, every model the file describes counts as outdated.
 */
export const makeCodexCatalogFreshness = <E>(input: {
  /** When the process started reading its catalog. */
  readonly startedAtMs: number;
  /** The process's effective config, answered by the process itself. */
  readonly readConfig: Effect.Effect<{ readonly config: unknown }, E>;
  readonly cwd: string;
  readonly home: string | undefined;
  readonly fileSystem: FileSystem.FileSystem;
}) => {
  let catalogPath: Option.Option<string | undefined> = Option.none();
  let baseline: Entries | "unknown" | undefined;
  let current: { readonly identity: string; readonly entries: Entries | undefined } | undefined;

  const resolvePath = input.readConfig.pipe(
    Effect.map(({ config }) => {
      const pointer = record(config)?.model_catalog_json;
      if (typeof pointer !== "string" || pointer.length === 0) return undefined;
      if (pointer.startsWith("~") && input.home === undefined) return undefined;
      return NodePath.resolve(input.cwd, expandHomePath(pointer, input.home ?? ""));
    }),
    Effect.timeoutOption("10 seconds"),
    Effect.map(Option.getOrUndefined),
    // A process that cannot say where its catalog is is not asked again.
    Effect.orElseSucceed(() => undefined),
    Effect.tap((filename) => Effect.sync(() => (catalogPath = Option.some(filename)))),
  );

  const read = Effect.fnUntraced(function* (filename: string) {
    const stat = yield* input.fileSystem.stat(filename);
    const mtimeMs = Option.getOrElse(
      Option.map(stat.mtime, (date) => date.getTime()),
      () => Number.POSITIVE_INFINITY,
    );
    const identity = `${String(Option.getOrElse(stat.ino, () => 0))}:${mtimeMs}:${stat.size}`;
    if (current?.identity !== identity)
      current = {
        identity,
        entries:
          stat.type === "File" && Number(stat.size) <= MAX_CATALOG_BYTES
            ? parseEntries(yield* input.fileSystem.readFileString(filename))
            : undefined,
      };
    return { mtimeMs, entries: current.entries };
  });

  return Effect.fn("CodexCatalogFreshness.outdated")(function* (
    model: string,
    options?: { readonly cachedOnly?: boolean },
  ) {
    // Asking the process for its config waits on it; a cached-only check reads only the file.
    const filename = Option.isSome(catalogPath)
      ? catalogPath.value
      : options?.cachedOnly === true
        ? undefined
        : yield* resolvePath;
    if (filename === undefined) return false;
    const now = yield* read(filename).pipe(
      Effect.timeoutOption("2 seconds"),
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
    if (now?.entries === undefined) return false;
    baseline ??= now.mtimeMs < input.startedAtMs ? now.entries : "unknown";
    const entry = now.entries.get(model);
    return entry !== undefined && (baseline === "unknown" || baseline.get(model) !== entry);
  });
};
