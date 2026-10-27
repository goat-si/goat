import * as Schema from "effect/Schema";
import { snapshotTransportHints } from "./hints.ts";

export const MAX_SNAPSHOT_TEXT_BYTES = 20_000;
const MAX_SNAPSHOT_VISIBLE_TEXT_CHARS = 8_000;
const MAX_SNAPSHOT_ELEMENT_NAME_CHARS = 200;
const MAX_SNAPSHOT_LOG_ENTRIES = 40;
const MAX_SNAPSHOT_LOG_TEXT_CHARS = 500;
export const MAX_SNAPSHOT_IDENTIFIER_CHARS = 2_048;

const encodeJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const utf8Length = (text: string) => Buffer.byteLength(text, "utf8");
export const cutText = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

const cutEntryStrings = <A>(entry: A): A =>
  typeof entry === "object" && entry !== null
    ? (Object.fromEntries(
        Object.entries(entry).map(([key, value]) => [
          key,
          typeof value === "string" ? cutText(value, MAX_SNAPSHOT_LOG_TEXT_CHARS) : value,
        ]),
      ) as A)
    : entry;

const hasLongString = (entry: unknown, max: number) =>
  typeof entry === "object" &&
  entry !== null &&
  Object.values(entry).some((value) => typeof value === "string" && value.length > max);

export type SnapshotMetadata = {
  readonly url: string;
  readonly title: string;
  readonly visibleText: string;
  readonly interactiveElements: ReadonlyArray<{
    readonly name: string;
    readonly [key: string]: unknown;
  }>;
  readonly consoleEntries: ReadonlyArray<unknown>;
  readonly networkEntries: ReadonlyArray<unknown>;
  readonly actionTimeline: ReadonlyArray<unknown>;
  readonly [key: string]: unknown;
};

export const boundSnapshotMetadata = (metadata: SnapshotMetadata) => {
  const omitted: Array<string> = [];
  const { accessibilityTree, ...withoutTree } = metadata;
  const ariaTree = typeof accessibilityTree === "string" ? accessibilityTree : undefined;
  if (accessibilityTree !== undefined && ariaTree === undefined) {
    omitted.push("accessibilityTree (use interactiveElements locators or goat_preview_evaluate)");
  }
  const tail = <A>(entries: ReadonlyArray<A>, label: string) => {
    if (entries.length > MAX_SNAPSHOT_LOG_ENTRIES) {
      omitted.push(`${entries.length - MAX_SNAPSHOT_LOG_ENTRIES} older ${label}`);
    }
    const kept = entries.slice(-MAX_SNAPSHOT_LOG_ENTRIES);
    if (kept.some((entry) => hasLongString(entry, MAX_SNAPSHOT_LOG_TEXT_CHARS))) {
      omitted.push(`${label} text after ${MAX_SNAPSHOT_LOG_TEXT_CHARS} characters`);
    }
    return kept.map(cutEntryStrings);
  };
  if (
    metadata.url.length > MAX_SNAPSHOT_IDENTIFIER_CHARS ||
    metadata.title.length > MAX_SNAPSHOT_IDENTIFIER_CHARS
  ) {
    omitted.push(`url or title after ${MAX_SNAPSHOT_IDENTIFIER_CHARS} characters`);
  }
  if (
    metadata.interactiveElements.some(
      (element) => element.name.length > MAX_SNAPSHOT_ELEMENT_NAME_CHARS,
    )
  ) {
    omitted.push(`element names longer than ${MAX_SNAPSHOT_ELEMENT_NAME_CHARS} characters`);
  }
  const bounded = {
    ...withoutTree,
    url: cutText(metadata.url, MAX_SNAPSHOT_IDENTIFIER_CHARS),
    title: cutText(metadata.title, MAX_SNAPSHOT_IDENTIFIER_CHARS),
    interactiveElements: metadata.interactiveElements.map((element) => ({
      ...element,
      name: cutText(element.name, MAX_SNAPSHOT_ELEMENT_NAME_CHARS),
    })),
    consoleEntries: tail(metadata.consoleEntries, "console entries"),
    networkEntries: tail(metadata.networkEntries, "network entries"),
    actionTimeline: tail(metadata.actionTimeline, "action timeline entries"),
  };

  // Per-field character caps can still exceed the total byte ceiling.
  const shedOrder = [
    "actionTimeline",
    "networkEntries",
    "consoleEntries",
    "interactiveElements",
  ] as const;
  const lists: Record<(typeof shedOrder)[number], ReadonlyArray<unknown>> = {
    interactiveElements: bounded.interactiveElements,
    consoleEntries: bounded.consoleEntries,
    networkEntries: bounded.networkEntries,
    actionTimeline: bounded.actionTimeline,
  };
  const dropped: Record<(typeof shedOrder)[number], number> = {
    interactiveElements: 0,
    consoleEntries: 0,
    networkEntries: 0,
    actionTimeline: 0,
  };
  const rawDiff =
    typeof metadata.diff === "object" && metadata.diff !== null ? metadata.diff : undefined;
  const diffAdded =
    rawDiff && "added" in rawDiff && Array.isArray(rawDiff.added) ? rawDiff.added : [];
  const diffRemoved =
    rawDiff && "removed" in rawDiff && Array.isArray(rawDiff.removed) ? rawDiff.removed : [];
  let keptAdded = diffAdded,
    keptRemoved = diffRemoved;
  let visibleTextChars = Math.min(metadata.visibleText.length, MAX_SNAPSHOT_VISIBLE_TEXT_CHARS);
  let ariaTreeChars = Math.min(ariaTree?.length ?? 0, 20_000);
  const value = () => ({
    ...bounded,
    ...(ariaTree === undefined ? {} : { accessibilityTree: cutText(ariaTree, ariaTreeChars) }),
    visibleText: cutText(metadata.visibleText, visibleTextChars),
    ...lists,
    ...(rawDiff ? { diff: { ...rawDiff, added: keptAdded, removed: keptRemoved } } : {}),
    ...snapshotTransportHints(
      metadata,
      omitted.length > 0 ||
        visibleTextChars < metadata.visibleText.length ||
        ariaTreeChars < (ariaTree?.length ?? 0) ||
        Object.values(dropped).some((count) => count > 0) ||
        keptAdded.length < diffAdded.length ||
        keptRemoved.length < diffRemoved.length,
    ),
  });
  let text = encodeJsonText(value());
  while (utf8Length(text) > MAX_SNAPSHOT_TEXT_BYTES) {
    // Elements carry the locators, so they go last; logs shed newest-last.
    const key =
      shedOrder.find(
        (candidate) => candidate !== "interactiveElements" && lists[candidate].length > 0,
      ) ??
      (visibleTextChars > 0
        ? "visibleText"
        : lists.interactiveElements.length > 0
          ? "interactiveElements"
          : ariaTreeChars > 0
            ? "accessibilityTree"
            : undefined);
    if (key === undefined) {
      if (keptAdded.length > 0) keptAdded = keptAdded.slice(0, Math.floor(keptAdded.length / 2));
      else if (keptRemoved.length > 0)
        keptRemoved = keptRemoved.slice(0, Math.floor(keptRemoved.length / 2));
      else break;
      text = encodeJsonText(value());
      continue;
    }
    if (key === "visibleText") {
      visibleTextChars = Math.floor(visibleTextChars / 2);
    } else if (key === "accessibilityTree") {
      ariaTreeChars = Math.floor(ariaTreeChars / 2);
    } else {
      const keep = Math.floor(lists[key].length / 2);
      dropped[key] += lists[key].length - keep;
      lists[key] =
        keep === 0
          ? []
          : key === "interactiveElements"
            ? lists[key].slice(0, keep)
            : lists[key].slice(-keep);
    }
    text = encodeJsonText(value());
  }
  if (visibleTextChars < metadata.visibleText.length) {
    omitted.push(
      `visibleText after ${visibleTextChars} characters (use goat_preview_read for more)`,
    );
  }
  if (ariaTree !== undefined && ariaTreeChars < ariaTree.length) {
    omitted.push(`accessibilityTree after ${ariaTreeChars} characters`);
  }
  for (const key of shedOrder) {
    if (dropped[key] > 0) {
      omitted.push(`${dropped[key]} of ${bounded[key].length} ${key}`);
    }
  }
  if (keptAdded.length < diffAdded.length || keptRemoved.length < diffRemoved.length)
    omitted.push("diff lines beyond the transport budget");
  return { value: value(), text, omitted };
};
