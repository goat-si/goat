import type { Nodes } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

export interface GoatBotReplyPart {
  readonly kind: "text" | "table";
  /** The blocks as the reply wrote them, byte-exact. */
  readonly text: string;
  /** What the card renders: `text`, plus the reply's definitions it refers to. */
  readonly source: string;
}

export interface GoatBotReplySplit {
  readonly parts: ReadonlyArray<GoatBotReplyPart>;
}

// ChatMarkdown's block grammar, so a card holds exactly the table that document draws.
const parser = unified().use(remarkParse).use(remarkGfm).freeze();

const MAX_CACHED_REPLIES = 64;

// Streaming re-renders every row; a row whose text did not change keeps its split.
const splits = new Map<string, GoatBotReplySplit>();

/** Splits an answer at its top-level tables, so a client can draw each one on its own card. */
export function goatBotReplySplit(text: string): GoatBotReplySplit {
  const cached = splits.get(text);
  if (cached !== undefined) {
    splits.delete(text);
    splits.set(text, cached);
    return cached;
  }
  const split = splitAtTables(text);
  splits.set(text, split);
  for (const oldest of splits.keys()) {
    if (splits.size <= MAX_CACHED_REPLIES) break;
    splits.delete(oldest);
  }
  return split;
}

interface BlockSpan {
  readonly node: Nodes;
  readonly start: number;
  readonly end: number;
}

interface DefinitionSpan {
  readonly identifier: string;
  readonly source: string;
  readonly start: number;
  readonly end: number;
}

function splitAtTables(text: string): GoatBotReplySplit {
  const whole: GoatBotReplySplit = { parts: [card("text", text, text)] };
  // Every GFM table has a pipe; skipping the parse for the rest keeps streamed prose cheap.
  if (!text.includes("|")) return whole;
  const tree = parser.parse(text);
  const spans: BlockSpan[] = [];
  for (const node of tree.children) {
    // A definition renders nothing on its own; a card that refers to one carries it by source.
    if (isDefinition(node)) continue;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return whole;
    spans.push({ node, start, end });
  }
  if (!spans.some((span) => span.node.type === "table")) return whole;

  const definitions = definitionsOf(text, tree.children);
  const parts: GoatBotReplyPart[] = [];
  const push = (kind: GoatBotReplyPart["kind"], start: number, end: number) => {
    const source = text.slice(start, end);
    parts.push(card(kind, source, withDefinitions(source, start, end, definitions)));
  };
  let run: BlockSpan[] = [];
  const flush = () => {
    const first = run[0];
    const last = run[run.length - 1];
    if (first !== undefined && last !== undefined) push("text", first.start, last.end);
    run = [];
  };
  for (const span of spans) {
    if (span.node.type === "table") {
      flush();
      push("table", span.start, span.end);
    } else {
      run.push(span);
    }
  }
  flush();

  return { parts: parts.length > 0 ? parts : whole.parts };
}

const card = (kind: GoatBotReplyPart["kind"], text: string, source: string): GoatBotReplyPart => ({
  kind,
  text,
  source,
});

/** A card's source plus the reply's definitions written outside it that it refers to, so a
    reference written after its table still resolves without repeating a footnote elsewhere. */
function withDefinitions(
  source: string,
  start: number,
  end: number,
  definitions: ReadonlyArray<DefinitionSpan>,
): string {
  const elsewhere = definitions.filter(
    (definition) => definition.end <= start || definition.start >= end,
  );
  if (elsewhere.length === 0) return source;
  // A reference link only parses when its definition is present, so read the card with them all.
  const referenced = referencedIdentifiers(
    `${source}\n\n${elsewhere.map((definition) => definition.source).join("\n\n")}`,
  );
  const used = elsewhere.filter((definition) => referenced.has(definition.identifier));
  return used.length === 0
    ? source
    : `${source}\n\n${used.map((definition) => definition.source).join("\n\n")}`;
}

function referencedIdentifiers(text: string): ReadonlySet<string> {
  const identifiers = new Set<string>();
  const collect = (nodes: ReadonlyArray<Nodes>) => {
    for (const node of nodes) {
      // A definition's own label is not a reference to it.
      if (isDefinition(node)) continue;
      if (node.type === "linkReference" || node.type === "footnoteReference") {
        identifiers.add(node.identifier);
      }
      if ("children" in node) collect(node.children);
    }
  };
  collect(parser.parse(text).children);
  return identifiers;
}

const isDefinition = (node: Nodes) =>
  node.type === "definition" || node.type === "footnoteDefinition";

function definitionsOf(
  text: string,
  nodes: ReadonlyArray<Nodes>,
  found: DefinitionSpan[] = [],
): DefinitionSpan[] {
  for (const node of nodes) {
    if (isDefinition(node)) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) {
        found.push({ identifier: node.identifier, source: text.slice(start, end), start, end });
      }
    }
    if ("children" in node) definitionsOf(text, node.children, found);
  }
  return found;
}
