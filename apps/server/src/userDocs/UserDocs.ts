// @effect-diagnostics nodeBuiltinImport:off - Resolves the repository's docs/user beside this module in source runs.
import * as NodeURL from "node:url";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import packageJson from "../../package.json" with { type: "json" };
import {
  parseUserGuide,
  searchUserGuides,
  type UserGuideMatch,
  type UserGuidePage,
} from "./userGuides.ts";

/** The guides the pack build inlines (apps/server/vite.config.ts); absent in source runs. */
declare const __GOAT_USER_DOCS__: Readonly<Record<string, string>> | undefined;

/** Characters of markdown one read returns before it continues through a cursor. */
export const USER_GUIDE_READ_LIMIT = 24_000;

export class UserDocsUnavailableError extends Schema.TaggedError<UserDocsUnavailableError>()(
  "UserDocsUnavailableError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `GOAT's user guides are not available on this server: ${this.reason}`;
  }
}

export class UserGuideNotFoundError extends Schema.TaggedError<UserGuideNotFoundError>()(
  "UserGuideNotFoundError",
  {
    page: Schema.String,
    section: Schema.optionalKey(Schema.String),
    nearest: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    const target = this.section === undefined ? this.page : `${this.page} > ${this.section}`;
    return this.nearest.length === 0
      ? `No user guide matches ${target}.`
      : `No user guide matches ${target}. Nearest: ${this.nearest.join(", ")}.`;
  }
}

export class UserGuideCursorError extends Schema.TaggedError<UserGuideCursorError>()(
  "UserGuideCursorError",
  {},
) {
  override get message(): string {
    return "The cursor does not belong to this page or section; read it again without one.";
  }
}

export interface UserGuideSearchResult {
  readonly build: string;
  readonly words: ReadonlyArray<string>;
  readonly matches: ReadonlyArray<UserGuideMatch>;
  readonly total: number;
  readonly truncated: boolean;
}

export interface UserGuideIndex {
  readonly build: string;
  readonly guides: ReadonlyArray<{
    readonly page: string;
    readonly title: string;
    readonly url: string;
  }>;
}

export interface UserGuideRead {
  readonly build: string;
  readonly page: string;
  readonly title: string;
  readonly heading: string | null;
  readonly url: string;
  readonly markdown: string;
  /** The page's sections, to pass back as section; only for a whole-page read. */
  readonly sections: ReadonlyArray<{
    readonly heading: string;
    readonly depth: 2 | 3;
    readonly url: string;
  }>;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
}

export class UserDocs extends Context.Service<
  UserDocs,
  {
    readonly search: (input: {
      readonly query: string;
      readonly limit?: number | undefined;
    }) => Effect.Effect<UserGuideSearchResult, UserDocsUnavailableError>;
    readonly index: Effect.Effect<UserGuideIndex, UserDocsUnavailableError>;
    readonly read: (input: {
      readonly page: string;
      readonly section?: string | undefined;
      readonly cursor?: string | undefined;
    }) => Effect.Effect<
      UserGuideRead,
      UserDocsUnavailableError | UserGuideNotFoundError | UserGuideCursorError
    >;
  }
>()("goat/userDocs/UserDocs") {}

const pageOf = (file: string) => file.replace(/\.md$/, "");

/** The inlined guides in a packed build, else the repository's docs/user beside this module. */
const loadGuides = Effect.gen(function* () {
  const bundled = typeof __GOAT_USER_DOCS__ === "undefined" ? undefined : __GOAT_USER_DOCS__;
  if (bundled !== undefined)
    return Object.entries(bundled).map(([page, markdown]) => parseUserGuide(page, markdown));
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = NodeURL.fileURLToPath(new URL("../../../../docs/user/", import.meta.url));
  const files = yield* fs
    .readDirectory(directory)
    .pipe(
      Effect.mapError(() => new UserDocsUnavailableError({ reason: "this build has no guides" })),
    );
  return yield* Effect.forEach(files.filter((file) => file.endsWith(".md")).sort(), (file) =>
    fs.readFileString(path.join(directory, file)).pipe(
      Effect.map((markdown) => parseUserGuide(pageOf(file), markdown)),
      Effect.mapError(() => new UserDocsUnavailableError({ reason: `${file} could not be read` })),
    ),
  );
});

/** Pages whose id or title shares the most words with what was asked for. */
function nearestPages(pages: ReadonlyArray<UserGuidePage>, asked: string): ReadonlyArray<string> {
  const words = asked
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return pages
    .map((page) => ({
      page: page.page,
      hits: words.filter(
        (word) => page.page.includes(word) || page.title.toLowerCase().includes(word),
      ).length,
    }))
    .filter((entry) => entry.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 3)
    .map((entry) => entry.page);
}

/** The cursor names the read it continues, so a cursor from another page is refused. */
const cursorFor = (key: string, offset: number) =>
  Buffer.from(JSON.stringify([key, offset])).toString("base64url");
function offsetFrom(cursor: string | undefined, key: string): number | undefined {
  if (cursor === undefined) return 0;
  try {
    const [owner, offset] = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as unknown[];
    return owner === key && typeof offset === "number" && Number.isInteger(offset) && offset > 0
      ? offset
      : undefined;
  } catch {
    return undefined;
  }
}

/** Up to the read limit, ending on a line boundary when one is near. */
function window(text: string, offset: number) {
  if (text.length - offset <= USER_GUIDE_READ_LIMIT)
    return { markdown: text.slice(offset), next: null };
  const hardEnd = offset + USER_GUIDE_READ_LIMIT;
  const lineEnd = text.lastIndexOf("\n", hardEnd);
  const end = lineEnd > offset + USER_GUIDE_READ_LIMIT / 2 ? lineEnd + 1 : hardEnd;
  return { markdown: text.slice(offset, end), next: end };
}

const make = Effect.gen(function* () {
  const build = packageJson.version;
  // Loaded once: inlined text costs nothing, and a source run reads 46 small files.
  const loaded = yield* Effect.exit(loadGuides);
  const pages: Effect.Effect<
    ReadonlyArray<UserGuidePage>,
    UserDocsUnavailableError
  > = Exit.isSuccess(loaded) ? Effect.succeed(loaded.value) : Effect.failCause(loaded.cause);

  const search: UserDocs["Service"]["search"] = ({ query, limit = 8 }) =>
    pages.pipe(
      Effect.map((guides) => {
        const found = searchUserGuides(guides, query);
        const bounded = Math.max(1, Math.min(25, limit));
        return {
          build,
          words: found.words,
          matches: found.matches.slice(0, bounded),
          total: found.matches.length,
          truncated: found.matches.length > bounded,
        };
      }),
    );

  const index: UserDocs["Service"]["index"] = pages.pipe(
    Effect.map((guides) => ({
      build,
      guides: [...guides]
        .sort((a, b) => a.title.localeCompare(b.title, "en"))
        .map(({ page, title, url }) => ({ page, title, url })),
    })),
  );

  const read: UserDocs["Service"]["read"] = Effect.fn("UserDocs.read")(function* ({
    page,
    section,
    cursor,
  }) {
    const guides = yield* pages;
    const guide = guides.find((candidate) => candidate.page === pageOf(page.trim().toLowerCase()));
    if (guide === undefined)
      return yield* new UserGuideNotFoundError({ page, nearest: nearestPages(guides, page) });
    const wanted = section?.trim().toLowerCase();
    const part =
      wanted === undefined
        ? undefined
        : guide.sections.find(
            (candidate) =>
              candidate.anchor === wanted.replace(/^#/, "") ||
              candidate.heading.toLowerCase() === wanted,
          );
    if (wanted !== undefined && part === undefined)
      return yield* new UserGuideNotFoundError({
        page: guide.page,
        section: section ?? "",
        nearest: guide.sections
          .filter((candidate) =>
            wanted.split(/\s+/).some((word) => candidate.heading.toLowerCase().includes(word)),
          )
          .slice(0, 3)
          .map((candidate) => candidate.heading),
      });
    const text =
      part === undefined
        ? guide.markdown
        : `${"#".repeat(part.depth)} ${part.heading}\n\n${part.text}`;
    const key = part === undefined ? guide.page : `${guide.page}#${part.anchor}`;
    const offset = offsetFrom(cursor, key);
    if (offset === undefined || offset > text.length) return yield* new UserGuideCursorError();
    const { markdown, next } = window(text, offset);
    return {
      build,
      page: guide.page,
      title: guide.title,
      heading: part?.heading ?? null,
      url: part === undefined ? guide.url : `${guide.url}#${part.anchor}`,
      markdown,
      sections:
        part === undefined && offset === 0
          ? guide.sections.map(({ heading, depth, anchor }) => ({
              heading,
              depth,
              url: `${guide.url}#${anchor}`,
            }))
          : [],
      truncated: next !== null,
      nextCursor: next === null ? null : cursorFor(key, next),
    };
  });

  return UserDocs.of({ search, index, read });
});

export const layer = Layer.effect(UserDocs, make);
