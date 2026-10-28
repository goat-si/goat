/**
 * What the desktop driver's indexed tree text says about elements that its element list leaves
 * out: names written as text under unnamed rows and cells, label lines beside values, and the
 * accessibility ids on each line. The driver's own label always wins when it has one.
 */

interface TreeLine {
  readonly depth: number;
  readonly index?: number;
  readonly role: string;
  /** The quoted title or value a display-only line shows. */
  readonly words?: string;
}

// `- [12] AXRow "title" = "value" (description) [id=… actions=[…]]`; unnumbered lines lack `[n]`.
const LINE = /^(\s*)- (?:\[(\d+)\] )?(\w+)(.*)$/;
const QUOTED = /^\s*(?:"((?:[^"\\]|\\.)*)")?(?:\s*=\s*"((?:[^"\\]|\\.)*)")?/;
/** Containers the driver leaves unnamed whose name is the text written in them. */
const NAMED_BY_TEXT: ReadonlySet<string> = new Set(["AXRow", "AXCell", "AXOutlineRow"]);
const TEXT_ROLES: ReadonlySet<string> = new Set(["AXStaticText", "AXHeading"]);

const unquote = (value: string) => {
  try {
    return String(JSON.parse(`"${value}"`));
  } catch {
    return value;
  }
};

export const parseTree = (markdown: string): ReadonlyArray<TreeLine> =>
  markdown.split("\n").flatMap((line) => {
    const parsed = LINE.exec(line);
    if (!parsed) return [];
    const [, indent = "", index, role = "", rest = ""] = parsed;
    const quoted = QUOTED.exec(rest);
    const raw = quoted?.[2] ?? quoted?.[1];
    return [
      {
        depth: indent.length,
        role,
        ...(index === undefined ? {} : { index: Number(index) }),
        ...(raw === undefined ? {} : { words: unquote(raw).trim() }),
      },
    ];
  });

/** The numbered ancestor of each line, by position. */
const owners = (lines: ReadonlyArray<TreeLine>) => {
  const owner: Array<number | undefined> = [];
  const open: Array<{ readonly depth: number; readonly index?: number }> = [];
  for (const line of lines) {
    while (open.length > 0 && (open.at(-1)?.depth ?? 0) >= line.depth) open.pop();
    owner.push([...open].reverse().find((each) => each.index !== undefined)?.index);
    open.push({ depth: line.depth, ...(line.index === undefined ? {} : { index: line.index }) });
  }
  return owner;
};

/**
 * Names for unnamed rows and cells: the first display-only text written under them, taken by the
 * nearest numbered ancestor only, so a name never comes from (or passes through) a numbered child.
 */
export const namesFromTree = (lines: ReadonlyArray<TreeLine>): ReadonlyMap<number, string> => {
  const names = new Map<number, string>();
  const owner = owners(lines);
  const roleOf = new Map(
    lines.flatMap((line) => (line.index === undefined ? [] : [[line.index, line.role] as const])),
  );
  lines.forEach((line, position) => {
    if (line.index !== undefined || !TEXT_ROLES.has(line.role) || !line.words) return;
    const index = owner[position];
    if (index === undefined || names.has(index) || !NAMED_BY_TEXT.has(roleOf.get(index) ?? ""))
      return;
    names.set(index, line.words.slice(0, 1024));
  });
  return names;
};

/** Indexes written on more than one line: text inside a title or value wrote the others. */
export const repeatedIndexes = (lines: ReadonlyArray<TreeLine>): ReadonlySet<number> => {
  const seen = new Set<number>();
  const repeated = new Set<number>();
  for (const line of lines)
    if (line.index !== undefined) (seen.has(line.index) ? repeated : seen).add(line.index);
  return repeated;
};

interface Listed {
  readonly index: number;
  readonly role: string;
  readonly label?: string;
  readonly value?: string;
}
/**
 * Indexes whose one line starts as the driver writes that element from its listed role, label and
 * value. The driver writes text unescaped, so any other line for an index may be text posing as it.
 */
const verifiedIndexes = (markdown: string, entries: ReadonlyArray<Listed>): ReadonlySet<number> => {
  const byIndex = new Map<number, string[]>();
  for (const raw of markdown.split("\n")) {
    const line = raw.trimStart();
    const index = /^- \[(\d+)\] /.exec(line)?.[1];
    if (index !== undefined)
      byIndex.set(Number(index), [...(byIndex.get(Number(index)) ?? []), line]);
  }
  const verified = new Set<number>();
  for (const { index, role, label, value } of entries) {
    const lines = byIndex.get(index);
    const line = lines?.length === 1 ? lines[0] : undefined;
    if (!line || /[\r\n]/.test((label ?? "") + (value ?? ""))) continue;
    const shown =
      label === undefined
        ? [""]
        : [
            ` "${label}"`,
            ...(value === undefined ? [] : [` = "${value}" (${label})`]),
            ` (${label})`,
            ` = "${label}"`,
            ` [id=${label}`,
          ];
    if (
      shown.some((words) => {
        const head = `- [${index}] ${role}${words}`;
        const next = line.charAt(head.length);
        return line.startsWith(head) && (next === "" || next === " " || words.startsWith(" [id="));
      })
    )
      verified.add(index);
  }
  return verified;
};

/** The tree text with the number taken off every line that does not verifiably show its element. */
export const unmarkUnverified = (markdown: string, entries: ReadonlyArray<Listed>): string => {
  const verified = verifiedIndexes(markdown, entries);
  return markdown.replace(/^(\s*- )\[(\d+)\] /gm, (marker, head: string, index: string) =>
    verified.has(Number(index)) ? marker : head,
  );
};

/**
 * Whether some string in the read spans lines: a listed label or value with a line break, a line
 * that is not a tree line, or one with an unpaired quote. Text lines are then not trusted to name.
 */
export const spansLines = (markdown: string, entries: ReadonlyArray<Listed>): boolean =>
  entries.some((entry) => /[\r\n]/.test((entry.label ?? "") + (entry.value ?? ""))) ||
  markdown
    .split("\n")
    .some(
      (line) =>
        line.trim() !== "" && (!LINE.test(line) || (line.match(/"/g)?.length ?? 0) % 2 === 1),
    );

const isLabel = (line: TreeLine | undefined): line is TreeLine & { readonly words: string } =>
  line !== undefined &&
  line.index === undefined &&
  line.role === "AXStaticText" &&
  line.words !== undefined &&
  line.words.length > 0 &&
  line.words.length <= 60 &&
  !/[.!?]$/.test(line.words);

/**
 * Labels for value elements: a numbered element whose only words are its value takes the
 * display-only text line just before it at the same depth (`Image Size` beside `550 × 332 pixels`).
 */
export const labelsFromTree = (lines: ReadonlyArray<TreeLine>): ReadonlyMap<number, string> => {
  const labels = new Map<number, string>();
  lines.forEach((line, position) => {
    const previous = lines[position - 1];
    if (line.index !== undefined && isLabel(previous) && previous.depth === line.depth)
      labels.set(line.index, previous.words);
  });
  return labels;
};

/**
 * The tree text with each lone label/value pair of display-only texts on one line
 * (`- AXStaticText "Chip" = "Apple M5 Max"`): two text lines that are their parent's only children.
 */
export const pairTreeText = (markdown: string): string => {
  const raw = markdown.split("\n");
  const parsed = raw.map((line) => {
    const match = LINE.exec(line);
    const quoted = match ? QUOTED.exec(match[4] ?? "") : null;
    const words = quoted?.[2] ?? quoted?.[1];
    return match
      ? {
          depth: (match[1] ?? "").length,
          role: match[3] ?? "",
          ...(match[2] === undefined ? {} : { index: Number(match[2]) }),
          ...(words === undefined ? {} : { words: unquote(words).trim() }),
        }
      : undefined;
  });
  const out: string[] = [];
  for (let at = 0; at < raw.length; at++) {
    const first = parsed[at];
    const second = parsed[at + 1];
    const before = parsed[at - 1];
    const after = parsed[at + 2];
    const lone =
      first !== undefined &&
      second !== undefined &&
      second.depth === first.depth &&
      (before === undefined || before.depth < first.depth) &&
      (after === undefined || after.depth < first.depth);
    if (
      lone &&
      isLabel(first) &&
      second.index === undefined &&
      second.role === "AXStaticText" &&
      second.words !== undefined &&
      second.words.length > 0
    ) {
      out.push(
        `${" ".repeat(first.depth)}- AXStaticText ${JSON.stringify(first.words)} = ${JSON.stringify(second.words)}`,
      );
      at++;
      continue;
    }
    out.push(raw[at] ?? "");
  }
  return out.join("\n");
};

/** A custom action the driver reports as `name:<label>\\ntarget:…\\nselector:…` shows as its label. */
export const actionName = (action: string): string => {
  const named = /^name:([^\n]*)\n/.exec(action);
  return (named?.[1] ?? action).trim();
};

/** The same, inside the tree text's `actions=[…]` lists, where the driver escapes the newlines. */
export const cleanActionText = (markdown: string): string =>
  markdown.replace(/name:([^,\]\\]*?)\\ntarget:[^,\]]*?\\nselector:[^,\]]*/g, "$1");

/** Actions every container offers; an element with only these is not a control. */
const PASSIVE_ACTIONS: ReadonlySet<string> = new Set([
  "AXShowDefaultUI",
  "AXShowAlternateUI",
  "AXShowMenu",
  "AXScrollToVisible",
  "AXRaise",
]);
const FIELD_ROLES: ReadonlySet<string> = new Set([
  "AXTextField",
  "AXSearchField",
  "AXTextArea",
  "AXComboBox",
  "AXSecureTextField",
]);
const CONTROL_ROLES: ReadonlySet<string> = new Set([
  "AXButton",
  "AXCheckBox",
  "AXRadioButton",
  "AXPopUpButton",
  "AXMenuButton",
  "AXSlider",
  "AXLink",
  "AXTab",
  "AXDisclosureTriangle",
  "AXIncrementor",
  "AXColorWell",
  ...FIELD_ROLES,
]);

/**
 * What an interactive-only read keeps: controls with an action of their own, every text field,
 * disabled controls (shown with `enabled:false`, so a flow's next step stays visible), and named
 * rows and cells.
 */
export const isInteractive = (element: {
  readonly role: string;
  readonly name: string;
  readonly actions?: ReadonlyArray<string>;
}) =>
  FIELD_ROLES.has(element.role) ||
  CONTROL_ROLES.has(element.role) ||
  (element.actions ?? []).some((action) => !PASSIVE_ACTIONS.has(action)) ||
  (NAMED_BY_TEXT.has(element.role) && element.name !== "");

/**
 * The tree text narrowed to the numbered lines in keep, the unnumbered text under them (which may
 * name them), and the lines above them, which stay as context without their numbers.
 */
export const keepTreeLines = (markdown: string, keep: ReadonlySet<number>): string => {
  const raw = markdown.split("\n");
  const included = new Set<number>();
  const open: Array<{
    readonly depth: number;
    readonly position: number;
    readonly index?: number;
  }> = [];
  raw.forEach((line, position) => {
    const parsed = LINE.exec(line);
    if (!parsed) return;
    const depth = (parsed[1] ?? "").length;
    while (open.length > 0 && (open.at(-1)?.depth ?? 0) >= depth) open.pop();
    const index = parsed[2] === undefined ? undefined : Number(parsed[2]);
    const owner = [...open].reverse().find((ancestor) => ancestor.index !== undefined)?.index;
    if (index === undefined ? owner !== undefined && keep.has(owner) : keep.has(index)) {
      included.add(position);
      for (const ancestor of open) included.add(ancestor.position);
    }
    open.push({ depth, position, ...(index === undefined ? {} : { index }) });
  });
  return raw
    .filter((_, position) => included.has(position))
    .map((line) => {
      const index = LINE.exec(line)?.[2];
      return index !== undefined && !keep.has(Number(index))
        ? line.replace(`[${index}] `, "")
        : line;
    })
    .join("\n");
};
