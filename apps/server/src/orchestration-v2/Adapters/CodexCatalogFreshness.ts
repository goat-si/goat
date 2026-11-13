// @effect-diagnostics-next-line nodeBuiltinImport:off -- Paths resolve like Codex's own config pointer.
import * as NodePath from "node:path";

import { expandHomePath } from "@goat/provider-core/server/pathExpansion";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

/** Larger files are not Codex catalogs GOAT can compare; such a process is never called outdated. */
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
/** A process that did not say where its catalog is, is asked again only after this long. */
const CONFIG_RETRY_MS = 60_000;

type Entries = ReadonlyMap<string, string>;
type FileInfo = Effect.Success<ReturnType<FileSystem.FileSystem["stat"]>>;

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

const describe = (stat: FileInfo) => {
  const mtimeMs = Option.getOrElse(
    Option.map(stat.mtime, (date) => date.getTime()),
    () => Number.POSITIVE_INFINITY,
  );
  return {
    mtimeMs,
    identity: `${String(Option.getOrElse(stat.ino, () => 0))}:${mtimeMs}:${stat.size}`,
    readable: stat.type === "File" && Number(stat.size) <= MAX_CATALOG_BYTES,
  };
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
  let configFailedAtMs: number | undefined;
  let baseline: Entries | "unknown" | undefined;
  /** GOAT's last successful read of the catalog file. */
  let current: { readonly identity: string; readonly entries: Entries } | undefined;
  let refreshing = false;

  const lookupFailed = Effect.fnUntraced(function* (detail: string) {
    if (configFailedAtMs === undefined) yield* Effect.logWarning(detail);
    configFailedAtMs = yield* Clock.currentTimeMillis;
    return undefined;
  });

  const resolvePath = Effect.gen(function* () {
    if (
      configFailedAtMs !== undefined &&
      (yield* Clock.currentTimeMillis) - configFailedAtMs < CONFIG_RETRY_MS
    )
      return undefined;
    const answer = yield* input.readConfig.pipe(
      Effect.timeoutOption("10 seconds"),
      Effect.orElseSucceed(() => Option.none<{ readonly config: unknown }>()),
    );
    if (Option.isNone(answer))
      return yield* lookupFailed("Codex did not say where its model catalog is; retrying later");
    const pointer = record(answer.value.config)?.model_catalog_json;
    if (typeof pointer === "string" && pointer.startsWith("~") && input.home === undefined)
      return yield* lookupFailed("Codex's model catalog path needs a home directory GOAT lacks");
    const filename =
      typeof pointer !== "string" || pointer.length === 0
        ? undefined
        : NodePath.resolve(input.cwd, expandHomePath(pointer, input.home ?? ""));
    catalogPath = Option.some(filename);
    return filename;
  });

  const read = Effect.fnUntraced(function* (filename: string) {
    const before = describe(yield* input.fileSystem.stat(filename));
    if (current?.identity === before.identity) return;
    const entries = before.readable
      ? parseEntries(yield* input.fileSystem.readFileString(filename))
      : undefined;
    // A rewrite during the read would pair new entries with the old time, so that read is dropped.
    // So is a file that is not a catalog GOAT can parse: it never counts as read.
    if (
      entries === undefined ||
      describe(yield* input.fileSystem.stat(filename)).identity !== before.identity
    )
      return;
    current = { identity: before.identity, entries };
    baseline ??= before.mtimeMs < input.startedAtMs ? entries : "unknown";
  });
  const refresh = (filename: string) =>
    read(filename).pipe(Effect.timeoutOption("2 seconds"), Effect.ignoreCause);

  const judge = (model: string) => {
    const entry = current?.entries.get(model);
    if (entry === undefined || baseline === undefined) return false;
    return baseline === "unknown" || baseline.get(model) !== entry;
  };
  /** One background lookup at a time; placement never waits on the process or the file. */
  const inBackground = Effect.fn("CodexCatalogFreshness.inBackground")(function* <E2>(
    effect: Effect.Effect<void, E2>,
  ) {
    if (refreshing) return;
    refreshing = true;
    yield* effect.pipe(
      Effect.ignoreCause,
      Effect.ensuring(Effect.sync(() => (refreshing = false))),
      Effect.forkDetach,
    );
  });

  return Effect.fn("CodexCatalogFreshness.outdated")(function* (
    model: string,
    options?: { readonly cachedOnly?: boolean },
  ) {
    if (options?.cachedOnly === true) {
      // Placement holds dispatch: one bounded stat, and the read and parse run in the background.
      if (Option.isNone(catalogPath)) {
        yield* inBackground(
          resolvePath.pipe(Effect.flatMap((path) => (path ? refresh(path) : Effect.void))),
        );
        // Until the process says where its catalog is, or that it has none, it may hold a stale one.
        return true;
      }
      const known = catalogPath.value;
      if (known === undefined) return false;
      const seen = yield* input.fileSystem.stat(known).pipe(
        Effect.map(describe),
        Effect.timeoutOption("50 millis"),
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
      // Unconfirmed counts as changed: the file did not answer, or GOAT has no read to compare.
      const changed = seen === undefined || seen.identity !== current?.identity;
      if (changed) yield* inBackground(refresh(known));
      // Until a background read confirms the file, a changed one counts as changing this model.
      return changed || judge(model);
    }
    const filename = Option.isSome(catalogPath) ? catalogPath.value : yield* resolvePath;
    if (filename !== undefined) yield* refresh(filename);
    return judge(model);
  });
};
