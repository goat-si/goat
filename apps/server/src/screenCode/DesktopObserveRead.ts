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
  idsFromTree,
  labelsFromTree,
  keepTreeLines,
  namesFromTree,
  parseTree,
} from "./DesktopTreeText.ts";

export type DesktopRow = ScreenObservationDraft["elements"][number];
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

/** The read's elements with a token, named by their label, a label line, or the text under them. */
export const desktopRows = (
  elements: ReadonlyArray<Record<string, unknown>>,
  markdown: string,
): DesktopRow[] => {
  const lines = parseTree(markdown);
  const [names, labels, ids] = [namesFromTree(lines), labelsFromTree(lines), idsFromTree(lines)];
  return elements.flatMap((entry) => {
    const token = string(entry.element_token);
    if (!token) return [];
    const index = natural(entry.element_index);
    const label = string(entry.label) ?? "";
    const named =
      index === undefined
        ? label
        : label === ""
          ? (names.get(index) ?? "")
          : label === entry.value
            ? (labels.get(index) ?? label)
            : label;
    const id = index === undefined ? undefined : ids.get(index);
    return [
      {
        role: string(entry.role) ?? "unknown",
        name: named,
        ...(typeof entry.value === "string" ? { text: entry.value } : {}),
        ...(index === undefined ? {} : { index }),
        ...elementDetail(entry),
        ...(id === undefined ? {} : { id }),
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
export const pageRows = (pages: DesktopPages, after: number) =>
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
