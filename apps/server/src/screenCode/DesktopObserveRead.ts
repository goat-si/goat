/**
 * Desktop reads beyond one whole tree: the elements a driver read names, a query's filter and
 * what it could not search, the pages of a read cut for budget, and the smaller walks a window
 * too large for one answer gets.
 */
import type { ScreenObservation, ScreenTargetRef } from "@goat/contracts";
import { fail } from "./DesktopDriverReplies.ts";
import { type Placed, type Rect, sameRect } from "./DesktopFrames.ts";
import type { Viewport } from "./DesktopObservationBudget.ts";
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
  /** Rows with frames in window points from origin, as the read's observation gave them. */
  readonly rows: ReadonlyArray<DesktopRow>;
  readonly text: string;
  readonly given: Set<number>;
  readonly ids: Set<string>;
  /** The window the frames were measured from; a page drops them once the window has moved. */
  readonly origin?: Rect;
  /** Frames the read could not place in its window. */
  readonly dropped: number;
  readonly screen: ScreenPlacement;
}

/** A full read too large to carry walks fewer elements, in this order, before it gives up. */
export const READ_BOUNDS = [4096, 1024, 256] as const;

const withoutFrame = ({ frame: _frame, ...row }: DesktopRow): DesktopRow => row;

/**
 * Rows as the agent sees them: frames in window points from origin. A row keeps its frame only
 * when its own parents reach a window at origin. A read that repeats a token or an index cannot
 * say whose parents are whose, so it places none.
 */
export const placeInWindow = (
  rows: ReadonlyArray<DesktopRow>,
  entries: ReadonlyArray<Record<string, unknown>>,
  frames: ReadonlyMap<string, Placed>,
  origin: Rect | undefined,
): { readonly rows: DesktopRow[]; readonly dropped: number } => {
  const tokens = new Set<string>();
  const indexes = new Set<number>();
  let repeated = false;
  for (const entry of entries) {
    const token = string(entry.element_token);
    const index = natural(entry.element_index);
    if ((token && tokens.has(token)) || (index !== undefined && indexes.has(index)))
      repeated = true;
    if (token) tokens.add(token);
    if (index !== undefined) indexes.add(index);
  }
  const from = repeated ? undefined : origin;
  let dropped = 0;
  const placed = rows.map((row) => {
    const frame = row.frame;
    if (frame === undefined) return row;
    const window = frames.get(row.driverToken)?.window;
    if (from && window && sameRect(window, from))
      return { ...row, frame: { ...frame, x: frame.x - from.x, y: frame.y - from.y } };
    dropped++;
    return withoutFrame(row);
  });
  return { rows: placed, dropped };
};

/** Why frames are missing from an observation, when some are. */
export const framesOmission = (dropped: number): NonNullable<ScreenObservation["omitted"]> =>
  dropped === 0
    ? []
    : [
        {
          kind: "frames",
          detail: `Frames left out for ${dropped} elements this read could not place in its window, so their window points are unknown.`,
        },
      ];

/** Where a read's window and elements sit on screen, for the budget's visible-first cut. */
export interface ScreenPlacement {
  readonly viewport?: Viewport;
  readonly screenFrames: ReadonlyMap<number, Viewport>;
}
/** The read's rows (screen frames) and window bounds as the budget measures them. */
export const screenPlacement = (
  rows: ReadonlyArray<DesktopRow>,
  bounds: Rect | undefined,
): ScreenPlacement => ({
  ...(bounds === undefined
    ? {}
    : { viewport: { x: bounds.x, y: bounds.y, width: bounds.w, height: bounds.h } }),
  screenFrames: new Map(
    rows.flatMap((row) =>
      row.index === undefined || row.frame === undefined ? [] : [[row.index, row.frame] as const],
    ),
  ),
});

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

/** The driver's state and geometry for one element, in the observation's own names and screen points. */
const elementDetail = (entry: Record<string, unknown>): ScreenElementDetail => {
  const frame = object(entry.frame);
  const actions = (Array.isArray(entry.actions) ? entry.actions : [])
    .filter((action): action is string => typeof action === "string")
    .map(actionName);
  const parent = natural(entry.parent_index);
  const selection = object(entry.selected_text_range);
  const location = natural(selection?.location);
  const length = natural(selection?.length);
  const valueDescription = string(entry.value_description);
  const url = string(entry.url);
  return {
    ...(actions.length > 0 ? { actions } : {}),
    ...(typeof entry.enabled === "boolean" ? { enabled: entry.enabled } : {}),
    ...(typeof entry.selected === "boolean" ? { selected: entry.selected } : {}),
    ...(typeof entry.focused === "boolean" ? { focused: entry.focused } : {}),
    // A caret selects "", which is a reading of its own.
    ...(typeof entry.selected_text === "string"
      ? { selectedText: entry.selected_text.slice(0, 4096) }
      : {}),
    ...(location !== undefined &&
    length !== undefined &&
    (selection?.units === undefined || selection.units === "utf16")
      ? { selectedTextRange: { location, length } }
      : {}),
    ...(valueDescription === undefined
      ? {}
      : { valueDescription: valueDescription.slice(0, 1024) }),
    ...(url === undefined ? {} : { url: url.slice(0, 8192) }),
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

/**
 * A page's draft: those rows under the lines above them, which stay as context. Frames stay
 * only while the window is where the read measured it (basis is the host's current one).
 */
const pageDraft = (
  pages: DesktopPages,
  after: number,
  targetRef: ScreenTargetRef,
  generation: number,
  basis: Rect | undefined,
): ScreenObservationDraft => {
  const rows = pageRows(pages, after);
  const placed = pages.origin !== undefined && basis !== undefined && sameRect(pages.origin, basis);
  const moved = placed ? 0 : rows.filter((row) => row.frame !== undefined).length;
  const omitted = [
    ...framesOmission(pages.dropped),
    ...(moved === 0
      ? []
      : [
          {
            kind: "frames" as const,
            detail:
              "Frames left out: the window moved or was not measured since this read; observe again for window points.",
          },
        ]),
  ];
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
    elements: placed ? rows : rows.map(withoutFrame),
    ...(omitted.length === 0 ? {} : { omitted }),
    ...pages.screen,
  };
};

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

export const buildObservedDraft = (input: {
  readonly targetRef: ScreenTargetRef;
  readonly generation: number;
  readonly state: Record<string, unknown>;
  readonly filtered: boolean;
  readonly limit: number;
  readonly shown: ReadonlyArray<DesktopRow>;
  readonly shownText: string;
  readonly omitted: NonNullable<ScreenObservation["omitted"]>;
  /** Screen geometry for the budget; shown frames are window points. */
  readonly screen: ScreenPlacement;
  readonly fallbackTitle: string | undefined;
}): ScreenObservationDraft => {
  const title = (
    string(input.state.window_title) ??
    string(input.state.title) ??
    input.fallbackTitle
  )?.slice(0, 1024);
  const url = string(input.state.url)?.slice(0, 8192);
  return {
    targetRef: input.targetRef,
    targetGeneration: input.generation,
    surfaceGeneration: input.generation,
    ...(title === undefined ? {} : { title }),
    ...(url === undefined ? {} : { url }),
    indexedText: input.shownText,
    complete: input.state.elements_complete === true && !input.filtered,
    truncated: input.state.truncated === true || input.limit < READ_BOUNDS[0],
    loading: false,
    elements: input.shown,
    ...(input.omitted.length === 0 ? {} : { omitted: input.omitted }),
    ...input.screen,
  };
};

export const renderPageObservation = (
  observations: import("./ScreenObservations.ts").ScreenObservations,
  pages: DesktopPages | undefined,
  boundId: string | undefined,
  ref: ScreenTargetRef,
  epoch: number,
  /** The window basis the host holds now; a screenshot that showed the window moved cleared it. */
  basis: Rect | undefined,
  args: Record<string, unknown>,
  treeBytes: number,
): {
  readonly observation?: ScreenObservation;
  readonly error?: import("@goat/contracts").ScreenRunError;
} => {
  const from = natural(args.after);
  if (from === undefined)
    return { error: fail("invalid_argument", "Pass after the number the omission names.") };
  const base = string(args.baseObservationId);
  if (!pages || pages.base !== boundId || (base !== undefined && base !== pages.base))
    return {
      error: fail("stale_reference", "A newer read ended that read's pages; observe again."),
    };
  try {
    const observation = observations.renderObservation({
      draft: pageDraft(pages, from, ref, epoch, basis),
      mode: "query",
      scope: `after [${from}]`,
      page: pages.base,
      limits: { treeBytes },
    });
    for (const element of observation.elements) pages.given.add(element.index);
    pages.ids.add(observation.observationId);
    return { observation };
  } catch (cause) {
    return { error: renderFailure(cause) };
  }
};
