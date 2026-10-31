import type { ScreenObservationDraft } from "./ScreenObservations.ts";

type Element = ScreenObservationDraft["elements"][number];

const snapshotRefPattern = /^aria-ref=t3-.+-((?:f\d+)?e\d+)$/; // goat-rename: legacy: browser ref namespace.
const snapshotRefPrefix = "aria-ref=t3-"; // goat-rename: legacy: browser ref namespace.
const nativeRef = (token: string) => token.replace(snapshotRefPattern, "aria-ref=$1");

export const hasFrameRefs = (draft: ScreenObservationDraft) =>
  draft.elements.some((element) => /^aria-ref=f\d+e\d+$/.test(nativeRef(element.driverToken)));

const identity = (element: Element) =>
  JSON.stringify([element.role, element.name, nativeRef(element.driverToken)]);

const elementLine = (line: string) => {
  const match = /^(\s*-\s*'?\w[\w-]*(?:\s+"(?:[^"\\]|\\.)*")?)((?:\s+\[[^\]]+\])*)/.exec(line);
  if (!match) return { comparable: line.trim(), focused: false };
  const attributes = match[2] ?? "";
  const focused = /(?:^|\s)\[(?:active|focused)\](?=\s|$)/.test(attributes);
  const normalized = attributes
    .replace(/\s+\[(?:active|focused)\](?=\s|$)/g, "")
    .replace(/\[ref=[^\]]+\]/, "[ref]");
  return { comparable: `${match[1]}${normalized}${line.slice(match[0].length)}`.trim(), focused };
};

const comparableLine = (line: string) => {
  const end = line.indexOf("\n");
  return end < 0
    ? elementLine(line).comparable
    : `${elementLine(line.slice(0, end)).comparable}${line.slice(end)}`;
};

const rows = (draft: ScreenObservationDraft) => {
  const elements = new Map(draft.elements.map((element) => [element.driverToken, element]));
  if (elements.size !== draft.elements.length) return undefined;
  const nativeRefs = new Set(draft.elements.map((element) => nativeRef(element.driverToken)));
  if (nativeRefs.size !== draft.elements.length) return undefined;
  if (
    draft.elements.some(
      (element) =>
        element.driverToken.startsWith(snapshotRefPrefix) &&
        nativeRef(element.driverToken) === element.driverToken,
    )
  )
    return undefined;
  const found = new Set<string>();
  const byIdentity = new Map<string, { line: string; element: Element; index: number }>();
  const plain: string[] = [];
  let textParent: { key: string; depth: number } | undefined;
  for (const line of draft.indexedText.split("\n")) {
    const ref = line.match(/\[ref=([^\]]+)\]/)?.[1];
    if (!ref) {
      const depth = line.length - line.trimStart().length;
      const parent =
        textParent && depth > textParent.depth ? byIdentity.get(textParent.key) : undefined;
      if (parent && /^-\s*text:/.test(line.trim())) {
        parent.line += `\n${line}`;
        continue;
      }
      if (line.trim()) plain.push(line);
      continue;
    }
    const token = `aria-ref=${ref}`;
    const element = elements.get(token);
    if (!element || found.has(token)) return undefined;
    found.add(token);
    const index = element.index ?? draft.elements.indexOf(element);
    const key = identity(element);
    if (byIdentity.has(key)) return undefined;
    byIdentity.set(key, { line, element, index });
    textParent = { key, depth: line.length - line.trimStart().length };
  }
  return found.size === elements.size ? { byIdentity, plain } : undefined;
};

export const diffTabObservation = (
  previous: ScreenObservationDraft,
  current: ScreenObservationDraft,
  baseObservationId: string,
): { text: string; elements: ScreenObservationDraft["elements"] } | undefined => {
  const old = rows(previous);
  const next = rows(current);
  if (!old || !next) return undefined;
  let nextIndex = Math.max(-1, ...Array.from(old.byIdentity.values(), (row) => row.index)) + 1;
  const elements = current.elements.map((element) => ({
    ...element,
    index: old.byIdentity.get(identity(element))?.index ?? nextIndex++,
  }));
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [key, row] of old.byIdentity) {
    if (!next.byIdentity.has(key))
      removed.push(`- ${row.line.replace(/ ?\[ref=[^\]]+\]/, ` [${row.index}]`)}`);
  }
  for (const [key, row] of next.byIdentity) {
    const prior = old.byIdentity.get(key);
    if (!prior) changed.push(`+ ${row.line}`);
    else if (comparableLine(prior.line) !== comparableLine(row.line)) changed.push(`~ ${row.line}`);
  }
  const count = (lines: string[]) => {
    const counts = new Map<string, number>();
    for (const line of lines) {
      const key = elementLine(line).comparable;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  const oldPlain = count(old.plain);
  const newPlain = count(next.plain);
  for (const line of old.plain) {
    const key = elementLine(line).comparable;
    const remaining = newPlain.get(key) ?? 0;
    if (remaining > 0) newPlain.set(key, remaining - 1);
    else removed.push(`- ${line}`);
  }
  for (const line of next.plain) {
    const key = elementLine(line).comparable;
    const remaining = oldPlain.get(key) ?? 0;
    if (remaining > 0) oldPlain.set(key, remaining - 1);
    else changed.push(`+ ${line}`);
  }
  const focused = (data: NonNullable<ReturnType<typeof rows>>) => {
    for (const [key, row] of data.byIdentity) {
      if (elementLine(row.line.split("\n", 1)[0] ?? "").focused) return key;
    }
    return data.plain.some((line) => elementLine(line).focused) ? null : undefined;
  };
  const oldFocus = focused(old);
  const newFocus = focused(next);
  if (oldFocus !== newFocus) {
    if (newFocus === undefined) changed.push("focus none");
    else if (newFocus !== null) {
      const row = next.byIdentity.get(newFocus);
      const index = row && elements.find((element) => identity(element) === newFocus)?.index;
      if (index !== undefined) changed.push(`focus [${index}]`);
    }
  }
  return {
    text: [...removed, ...changed].join("\n") || `no change since ${baseObservationId}`,
    elements,
  };
};
