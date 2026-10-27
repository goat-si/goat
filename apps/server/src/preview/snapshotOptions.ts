import type { PreviewAutomationSnapshot, PreviewAutomationSnapshotInput } from "@goat/contracts";
import type { Locator, Page } from "playwright-core";
import { HIDDEN_ABOVE } from "./pageScope.ts";

const interactive =
  /^\s*- '?(?:button|link|textbox|searchbox|combobox|checkbox|radio|switch|tab|menuitem|option|slider|spinbutton|treeitem)(?=[\s"':])/;
export const narrowTree = (tree: string, interactiveOnly?: boolean) =>
  interactiveOnly
    ? tree
        .split("\n")
        .filter((line) => interactive.test(line))
        .join("\n")
    : tree;

const baselines = new WeakMap<Page, Map<string, { key: string; lines: string[] }>>();
export const resetSnapshotDiff = (page: Page) => {
  baselines.delete(page);
};
const linesOf = (tree: string) =>
  tree
    .split("\n")
    .filter((line) => !line.startsWith("@layers"))
    .map((line) => line.replace(/\s*\[(?:ref=[^\]]+|box=[^\]]+)\]/g, "").trim())
    .filter(Boolean);
const subtract = (left: string[], right: string[]) => {
  const counts = new Map<string, number>();
  for (const line of right) counts.set(line, (counts.get(line) ?? 0) + 1);
  return left.filter((line) => {
    const count = counts.get(line) ?? 0;
    if (!count) return true;
    counts.set(line, count - 1);
    return false;
  });
};

export const snapshotOptionsResult = (
  page: Page,
  result: PreviewAutomationSnapshot,
  input: PreviewAutomationSnapshotInput & { readonly agentSessionId?: string | undefined },
  rawTextLength: number,
  unreadFrames: number,
  rawTreeLength: number,
): PreviewAutomationSnapshot => {
  const omitted: NonNullable<PreviewAutomationSnapshot["omitted"]>[number][] = [];
  if (rawTreeLength > 20_000) omitted.push("tree_budget");
  if (unreadFrames) omitted.push("unread_frames");
  if (rawTextLength > 20_000) omitted.push("text_budget");
  const store = baselines.get(page) ?? new Map();
  baselines.set(page, store);
  const caller = input.agentSessionId ?? "";
  const key = JSON.stringify([result.url, input.scope ?? null, input.interactiveOnly ?? false]);
  const previous = store.get(caller);
  const lines = linesOf(String(result.accessibilityTree));
  const diff = input.diff
    ? previous?.key === key
      ? {
          base: "previous" as const,
          added: subtract(lines, previous.lines),
          removed: subtract(previous.lines, lines),
        }
      : { base: "none" as const, added: [], removed: [] }
    : undefined;
  if (result.treeComplete && omitted.length === 0) store.set(caller, { key, lines });
  else store.delete(caller);
  return {
    ...result,
    ...(omitted.length ? { omitted } : {}),
    ...(diff ? { diff } : {}),
    ...(omitted.length
      ? { next: "Narrow with interactiveOnly or scope, or read the text with goat_preview_read." }
      : /^@layers (?!none)/.test(String(result.accessibilityTree))
        ? { next: "Close the blocking layer first." }
        : {}),
  };
};

export const snapshotPageMetadata = async (page: Page, scope?: Locator) => {
  const metadata = (await page.evaluate(
    `({ url: location.href, title: document.title, loading: document.readyState !== "complete", visibleText: document.body?.innerText || "", interactiveElements: [] })`,
  )) as Pick<
    PreviewAutomationSnapshot,
    "url" | "title" | "loading" | "visibleText" | "interactiveElements"
  >;
  return scope
    ? {
        ...metadata,
        visibleText: await scope.evaluate(
          new Function("node", `return (${HIDDEN_ABOVE})(node) ? "" : node.innerText || "";`) as (
            node: unknown,
          ) => string,
        ),
      }
    : metadata;
};
