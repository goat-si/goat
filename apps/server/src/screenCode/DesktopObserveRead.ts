/**
 * Desktop reads beyond one whole tree: the elements a driver read names, a query's filter and
 * what it could not search, the pages of a read cut for budget, and the smaller walks a window
 * too large for one answer gets.
 */
import type { ScreenObservation, ScreenTargetRef } from "@goat/contracts";
import { fail } from "./DesktopDriverReplies.ts";
import type { ScreenElementDetail, ScreenObservationDraft } from "./ScreenObservations.ts";
import {
  actionName,
  cleanActionText,
  keepTreeLines,
  namesFromTree,
  pairTreeText,
  parseTree,
  repeatedIndexes,
  spansLines,
  unmarkUnverified,
} from "./DesktopTreeText.ts";

export type DesktopRow = ScreenObservationDraft["elements"][number] & {
  /** True when the element had no label of its own and took text written under it. */
  readonly lifted?: boolean;
  /** Raw action names as the driver reported them, before custom-action trimming. */
  readonly rawActions?: ReadonlyArray<string>;
};
export interface DesktopQuery {
  readonly role?: string;
  readonly name?: string;
  readonly text?: string;
  readonly id?: string;
}
/** The rest of a read cut for budget: its rows and text, and what earlier pages carried. */
export interface DesktopPages {
  /** The observation the pages continue; a newer read of the window ends them. */
  readonly base: string;
  readonly rows: ReadonlyArray<DesktopRow>;
  readonly text: string;
  readonly given: Set<number>;
  readonly ids: Set<string>;
}

/** A full read too large to carry walks fewer elements, in this order, before it gives up. */
export const READ_BOUNDS = [4096, 1024, 256] as const;

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const natural = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** The driver's state and geometry for one element, in the observation's own names. */
const elementDetail = (entry: Record<string, unknown>): ScreenElementDetail => {
  const frame = object(entry.frame);
  const actions = (Array.isArray(entry.actions) ? entry.actions : [])
    .filter((action): action is string => typeof action === "string")
    .map(actionName);
  const parent = natural(entry.parent_index);
  return {
    ...(actions.length > 0 ? { actions } : {}),
    ...(typeof entry.enabled === "boolean" ? { enabled: entry.enabled } : {}),
    ...(typeof entry.selected === "boolean" ? { selected: entry.selected } : {}),
    ...(frame && finite(frame.x) && finite(frame.y) && finite(frame.w) && finite(frame.h)
      ? { frame: { x: frame.x, y: frame.y, width: frame.w, height: frame.h } }
      : {}),
    ...(finite(entry.min) && finite(entry.max)
      ? { range: { min: entry.min, max: entry.max } }
      : {}),
    ...(parent === undefined ? {} : { parent }),
  };
};

/** The read's elements with a token, named by their label or, when unnamed, the text under them. */
export const desktopRows = (
  elements: ReadonlyArray<Record<string, unknown>>,
  markdown: string,
): DesktopRow[] => {
  const lines = parseTree(markdown);
  const repeated = repeatedIndexes(lines);
  // Text spanning lines can pose as tree lines, so then no name is taken from text. Otherwise an
  // unnamed element takes text written under it, which only its own content can write.
  const names = spansLines(markdown, listedOf(elements)) ? new Map() : namesFromTree(lines);
  return elements.flatMap((entry) => {
    const token = string(entry.element_token);
    if (!token) return [];
    const index = natural(entry.element_index);
    const label = string(entry.label) ?? "";
    const liftedName =
      index !== undefined && label === "" && !repeated.has(index) ? names.get(index) : undefined;
    const named = liftedName ?? label;
    const rawActions = (Array.isArray(entry.actions) ? entry.actions : []).filter(
      (action): action is string => typeof action === "string",
    );
    // Only a structured id: tree text is written unescaped and can pose as metadata.
    const id = string(entry.identifier)?.slice(0, 400);
    return [
      {
        role: string(entry.role) ?? "unknown",
        name: named,
        ...(typeof entry.value === "string" ? { text: entry.value } : {}),
        ...(index === undefined ? {} : { index }),
        ...elementDetail(entry),
        ...(id === undefined ? {} : { id }),
        ...(liftedName !== undefined && liftedName !== "" ? { lifted: true } : {}),
        ...(rawActions.length > 0 ? { rawActions } : {}),
        driverToken: token,
      },
    ];
  });
};

const field = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, 400) : undefined;
/** A query's fields, or undefined when it names none. */
export const desktopQuery = (value: unknown): DesktopQuery | undefined => {
  const given = object(value);
  const query = Object.fromEntries(
    (["role", "name", "text", "id"] as const).flatMap((key) => {
      const wanted = field(given?.[key]);
      return wanted === undefined ? [] : [[key, wanted]];
    }),
  ) as DesktopQuery;
  return Object.keys(query).length > 0 ? query : undefined;
};
/** The substring the driver filters by; a role alone filters a bounded read here. */
export const driverQuery = (query: DesktopQuery) => query.text ?? query.name ?? query.id;

const bareRole = (role: string) => role.toLowerCase().replace(/^ax/, "");
const has = (haystack: string | undefined, needle: string) =>
  (haystack ?? "").toLowerCase().includes(needle.toLowerCase());
/** Every field the query names matches this one element. */
export const matchesQuery = (row: DesktopRow, query: DesktopQuery) =>
  (query.role === undefined || bareRole(row.role) === bareRole(query.role)) &&
  (query.name === undefined || has(row.name, query.name)) &&
  (query.text === undefined || has(row.name, query.text) || has(row.text, query.text)) &&
  (query.id === undefined || row.id === query.id);

/**
 * What a query could not search. Only a walk the driver finished and did not compact proves an
 * absence; ordinary macOS reads compact or skip parts, so a miss there proves nothing.
 */
export const queryOmission = (
  state: Record<string, unknown>,
  matched: number,
  /** The driver filtered the read, so names GOAT takes from text under an element were not there. */
  filtered = false,
): NonNullable<ScreenObservation["omitted"]> => {
  if (state.truncated === true) {
    const reason = string(state.truncation_reason)?.slice(0, 40) ?? "element limit";
    return [
      {
        kind: "budget",
        detail: `The search stopped early (${reason}) within up to 4,096 elements; a more specific name or text reaches the rest.`,
      },
    ];
  }
  if (filtered && matched === 0)
    return [
      {
        kind: "budget",
        detail:
          "Not found in the driver's filtered read; names taken from text under an element were not searched.",
      },
    ];
  return state.elements_complete === true || matched > 0
    ? []
    : [
        {
          kind: "budget",
          detail:
            "Not found in what was read; compacted or skipped parts of the window were not searched.",
        },
      ];
};
/** What a full read walked when the whole window would not fit. */
export const boundedReadDetail = (limit: number) =>
  `Read stopped at ${limit} elements; observe({query:{name}}) searches up to 4,096.`;

/** The next page: the read's elements from index after on that no earlier page carried. */
const pageRows = (pages: DesktopPages, after: number) =>
  pages.rows.filter(
    (row) => row.index !== undefined && row.index >= after && !pages.given.has(row.index),
  );

/** A page's draft: those rows under the lines above them, which stay as context. */
export const pageDraft = (
  pages: DesktopPages,
  after: number,
  targetRef: ScreenTargetRef,
  generation: number,
): ScreenObservationDraft => {
  const rows = pageRows(pages, after);
  return {
    targetRef,
    targetGeneration: generation,
    surfaceGeneration: generation,
    indexedText: keepTreeLines(
      pages.text,
      new Set(rows.flatMap((row) => (row.index === undefined ? [] : [row.index]))),
    ),
    complete: false,
    truncated: false,
    loading: false,
    elements: rows,
  };
};

/** The window's bounds as a draft's viewport: elements outside them go first when over budget. */
export const viewportOf = (
  bounds:
    | { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
    | undefined,
) =>
  bounds === undefined
    ? {}
    : { viewport: { x: bounds.x, y: bounds.y, width: bounds.w, height: bounds.h } };

export const renderFailure = (cause: unknown) =>
  fail(
    cause instanceof Error && cause.message === "Screen observation metadata exceeds tree budget"
      ? "tree_limit"
      : "downstream_failure",
  );

/** What to do about a read too large to carry, by what was read. */
export const tooLargeStep = (capture: boolean, query: boolean) =>
  capture
    ? "This window's capture answer is larger than GOAT carries in one read; nothing changed. Observe again."
    : query
      ? "Too many matches to return; use a more specific name or text."
      : "This window's accessibility tree is larger than GOAT carries even at 256 elements; nothing changed. Take a screenshot of it, or observe({query:{name}}).";

/**
 * A filtered read's tree text, rebuilt from the driver's element list: the filter can keep a line
 * written inside another element's text and drop the real one, while each entry is one element.
 */
const structuredTree = (elements: ReadonlyArray<Record<string, unknown>>): string =>
  elements
    .map((entry) => {
      const index = natural(entry.element_index);
      const label = string(entry.label);
      const value = string(entry.value);
      return [
        `${"  ".repeat(Math.min(natural(entry.depth) ?? 0, 64))}- `,
        index === undefined ? "" : `[${index}] `,
        string(entry.role) ?? "unknown",
        label === undefined ? "" : ` ${JSON.stringify(label)}`,
        value === undefined || value === label ? "" : ` = ${JSON.stringify(value)}`,
      ].join("");
    })
    .join("\n");

/** The read's tree text: a filtered read may keep a line another element's text wrote and drop the real one. */
export const treeOf = (
  state: Record<string, unknown>,
  elements: ReadonlyArray<Record<string, unknown>>,
  filtered: boolean,
) =>
  filtered
    ? structuredTree(elements)
    : typeof state.tree_markdown === "string"
      ? state.tree_markdown
      : "";
/**
 * The tree text as shown: numbers kept only where a line verifiably shows its element (all of a
 * read rebuilt from the element list, when no elements are given), labels paired, actions named.
 */
export const shownTree = (markdown: string, elements?: ReadonlyArray<Record<string, unknown>>) =>
  cleanActionText(
    pairTreeText(elements ? unmarkUnverified(markdown, listedOf(elements)) : markdown),
  );

/** The listed elements' index, role, label and value, for checking tree lines against them. */
const listedOf = (elements: ReadonlyArray<Record<string, unknown>>) =>
  elements.flatMap((entry) => {
    const index = natural(entry.element_index);
    return index === undefined
      ? []
      : [
          {
            index,
            role: string(entry.role) ?? "",
            ...(typeof entry.label === "string" ? { label: entry.label } : {}),
            ...(typeof entry.value === "string" ? { value: entry.value } : {}),
          },
        ];
  });

export const observeScope = (
  followedSheet: boolean,
  fromSheetId: number,
  windowId: number,
  query: boolean,
  interactive: boolean,
): string | undefined => {
  const base = followedSheet ? `sheet ${fromSheetId} of window ${windowId}` : undefined;
  return query
    ? `${base ?? "window"} query`
    : interactive
      ? `${base ?? "window"} interactive`
      : base;
};
