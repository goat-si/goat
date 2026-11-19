import type { CodexWebSearchItem } from "./CodexWebSearch.ts";

export const MAX_TRACKED_WEB_SEARCHES = 128;
export const MAX_WEB_SEARCH_BYTES = 8192;
const MAX_ID_CHARS = 256;
const MAX_TEXT_CHARS = 768;
const MAX_QUERIES = 32;

function fittingSearch(item: CodexWebSearchItem): CodexWebSearchItem | undefined {
  let chars = item.id.length + (item.query?.length ?? 0);
  const action = item.action;
  let cleanAction: CodexWebSearchItem["action"];
  if (action == null) cleanAction = action;
  else if (action.type === "search") {
    chars += action.query?.length ?? 0;
    if ((action.queries?.length ?? 0) > MAX_WEB_SEARCH_BYTES / 2) return undefined;
    for (const query of action.queries ?? []) {
      chars += query.length + 3;
      if (chars > MAX_WEB_SEARCH_BYTES) return undefined;
    }
    cleanAction = {
      type: "search",
      ...(action.query === undefined ? {} : { query: action.query }),
      ...(action.queries === undefined ? {} : { queries: action.queries }),
    };
  } else if (action.type === "openPage") {
    chars += action.url?.length ?? 0;
    cleanAction = { type: "openPage", ...(action.url === undefined ? {} : { url: action.url }) };
  } else if (action.type === "findInPage") {
    chars += (action.url?.length ?? 0) + (action.pattern?.length ?? 0);
    cleanAction = {
      type: "findInPage",
      ...(action.url === undefined ? {} : { url: action.url }),
      ...(action.pattern === undefined ? {} : { pattern: action.pattern }),
    };
  } else cleanAction = { type: "other" };
  if (chars > MAX_WEB_SEARCH_BYTES) return undefined;
  const clean = {
    id: item.id,
    type: "webSearch" as const,
    ...(item.query === undefined ? {} : { query: item.query }),
    ...(cleanAction === undefined ? {} : { action: cleanAction }),
  };
  return new TextEncoder().encode(JSON.stringify(clean)).length <= MAX_WEB_SEARCH_BYTES
    ? clean
    : undefined;
}

export function trackCodexWebSearch(
  items: Map<string, CodexWebSearchItem>,
  item: CodexWebSearchItem,
): void {
  const fitting = fittingSearch(item);
  if (fitting !== undefined) {
    items.delete(item.id);
    if (items.size >= MAX_TRACKED_WEB_SEARCHES) {
      const oldest = items.keys().next().value;
      if (oldest !== undefined) items.delete(oldest);
    }
    items.set(item.id, fitting);
    return;
  }
  if (item.id.length > MAX_ID_CHARS) return;
  let remaining = MAX_TEXT_CHARS;
  const take = (text: string | null | undefined): string | null | undefined => {
    if (text == null) return text;
    const bounded = text.slice(0, remaining);
    remaining -= bounded.length;
    return bounded;
  };
  const query = take(item.query);
  const action = item.action;
  let boundedAction: CodexWebSearchItem["action"];
  if (action == null) boundedAction = action;
  else if (action.type === "search") {
    const actionQuery = take(action.query);
    const queries =
      action.queries?.slice(0, MAX_QUERIES).map((value) => take(value) ?? "") ?? action.queries;
    boundedAction = {
      type: "search",
      ...(actionQuery === undefined ? {} : { query: actionQuery }),
      ...(queries === undefined ? {} : { queries }),
    };
  } else if (action.type === "openPage") {
    const url = take(action.url);
    boundedAction = { type: "openPage", ...(url === undefined ? {} : { url }) };
  } else if (action.type === "findInPage") {
    const url = take(action.url);
    const pattern = take(action.pattern);
    boundedAction = {
      type: "findInPage",
      ...(url === undefined ? {} : { url }),
      ...(pattern === undefined ? {} : { pattern }),
    };
  } else boundedAction = { type: "other" };
  const bounded = {
    id: item.id,
    type: "webSearch" as const,
    ...(query === undefined ? {} : { query }),
    ...(boundedAction === undefined ? {} : { action: boundedAction }),
  };
  items.delete(item.id);
  if (items.size >= MAX_TRACKED_WEB_SEARCHES) {
    const oldest = items.keys().next().value;
    if (oldest !== undefined) items.delete(oldest);
  }
  items.set(item.id, bounded);
}
