/**
 * Clean markdown from serialized page HTML, after browser-use's extract_clean_markdown
 * (browser_use/dom/markdown_extractor.py): markdownify conventions with noise subtrees dropped,
 * SPA JSON blobs filtered, blank runs collapsed, and the same size statistics.
 */

export interface CleanMarkdownOptions {
  readonly extractLinks?: boolean;
  readonly extractImages?: boolean;
  readonly maxChars?: number;
}

export interface CleanMarkdownStats {
  readonly originalHtmlChars: number;
  readonly initialMarkdownChars: number;
  readonly filteredCharsRemoved: number;
  readonly finalMarkdownChars: number;
  /** The markdown is cut by maxChars, or a subtree nested past the render depth was left out. */
  readonly truncated: boolean;
}

export interface CleanMarkdown {
  readonly markdown: string;
  readonly stats: CleanMarkdownStats;
}

interface ElementNode {
  readonly kind: "element";
  readonly tag: string;
  readonly attrs: ReadonlyMap<string, string>;
  readonly children: Array<HtmlNode>;
  readonly foreign: boolean;
}
type HtmlNode = ElementNode | { readonly kind: "text"; text: string };

// Markers live in the rendered text until the final pass; input never carries them.
const CODE = "\u0000";
const DROP_OPEN = "\u0001";
const DROP_CLOSE = "\u0002";
const INDENT = "\u0003";
const MAX_RENDER_DEPTH = 400;
const MAX_COLSPAN = 1000;

const set = (...tags: Array<string>): ReadonlySet<string> => new Set(tags);
const words = (list: string) => set(...list.split(" "));
const VOID = words("area base br col embed hr img input keygen link meta param source track wbr");
const RAW_TEXT = words("script style xmp iframe noembed noframes noscript plaintext");
const RCDATA = set("textarea", "title");
const NOISE = words(
  "script style noscript svg template head title meta link base iframe frame frameset object " +
    "embed canvas video audio input textarea select option datalist",
);
const BLOCKS = words(
  "p div section article main header footer nav aside form fieldset figure figcaption address " +
    "details summary dl dt dd center hgroup search legend body html",
);
const CLOSES_P = words(
  "p div section article main header footer nav aside form fieldset figure figcaption address " +
    "details dl dt dd center hgroup search blockquote h1 h2 h3 h4 h5 h6 hr menu ol ul pre table " +
    "li",
);
const TABLE_BOUNDS = set("table", "template");
const TABLE_PARTS = set("table", "caption", "thead", "tbody", "tfoot", "tr", "td", "th");
/** End tags outside the table model never close past a table or cell. */
const END_TAG_SCOPE = set("table", "td", "th", "caption", "template");
/** Start tags that close an open element first, and the elements that stop the search. */
const IMPLIED_CLOSES: ReadonlyMap<
  string,
  { readonly close: ReadonlySet<string>; readonly within: ReadonlySet<string> }
> = new Map([
  ["li", { close: set("li"), within: set("ul", "ol", "menu", "table", "td", "th", "blockquote") }],
  ["dt", { close: set("dt", "dd"), within: set("dl", "table", "td", "th") }],
  ["dd", { close: set("dt", "dd"), within: set("dl", "table", "td", "th") }],
  ["tr", { close: set("tr"), within: TABLE_BOUNDS }],
  ["td", { close: set("td", "th"), within: set("tr", "table", "template") }],
  ["th", { close: set("td", "th"), within: set("tr", "table", "template") }],
  ["thead", { close: set("thead", "tbody", "tfoot"), within: TABLE_BOUNDS }],
  ["tbody", { close: set("thead", "tbody", "tfoot"), within: TABLE_BOUNDS }],
  ["tfoot", { close: set("thead", "tbody", "tfoot"), within: TABLE_BOUNDS }],
  ["option", { close: set("option"), within: set("select", "datalist", "optgroup") }],
]);
const P_SCOPE = set("button", "table", "td", "th", "caption", "template", "object");

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  hellip: "\u2026",
  mdash: String.fromCodePoint(0x2014),
  ndash: "\u2013",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  laquo: "\u00ab",
  raquo: "\u00bb",
  middot: "\u00b7",
  bull: "\u2022",
  times: "\u00d7",
  divide: "\u00f7",
  deg: "\u00b0",
  euro: "\u20ac",
  pound: "\u00a3",
  yen: "\u00a5",
  cent: "\u00a2",
  sect: "\u00a7",
  para: "\u00b6",
  shy: "\u00ad",
  larr: "\u2190",
  rarr: "\u2192",
  uarr: "\u2191",
  darr: "\u2193",
};
/** Names browsers also decode without a trailing semicolon. */
const LEGACY_ENTITIES = set("amp", "lt", "gt", "quot", "nbsp", "copy", "reg");

const decodeEntities = (value: string): string =>
  value.includes("&")
    ? value.replace(
        /&(#[xX][0-9a-fA-F]{1,8}|#[0-9]{1,8}|[a-zA-Z][a-zA-Z0-9]{1,31})(;?)/g,
        (match, body: string, semicolon: string) => {
          if (body.startsWith("#")) {
            const hex = body[1] === "x" || body[1] === "X";
            const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
            const invalid = code <= 3 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff);
            return invalid ? "\ufffd" : String.fromCodePoint(code);
          }
          const decoded = NAMED_ENTITIES[body];
          if (decoded === undefined) return match;
          return semicolon || LEGACY_ENTITIES.has(body) ? decoded : match;
        },
      )
    : value;

/** Drops the marker characters (U+0000 to U+0003) the renderer reserves. */
const withoutMarkers = (text: string): string => {
  let out = "";
  let from = 0;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) > 3) continue;
    out += text.slice(from, index);
    from = index + 1;
  }
  return from === 0 ? text : out + text.slice(from);
};

const isSpace = (code: number) =>
  code === 32 || code === 9 || code === 10 || code === 12 || code === 13;
const isAlpha = (code: number) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
const endsName = (html: string, index: number, stops: string) =>
  isSpace(html.charCodeAt(index)) || stops.includes(html[index] ?? "");

interface StartTag {
  readonly name: string;
  readonly attrs: Map<string, string>;
  readonly selfClosing: boolean;
  readonly end: number;
}

/** Scans a start tag char by char so ">" inside a quoted value stays in it; undefined at EOF. */
const scanStartTag = (html: string, start: number): StartTag | undefined => {
  let index = start + 1;
  while (index < html.length && !endsName(html, index, "/>")) index++;
  const name = html.slice(start + 1, index).toLowerCase();
  const attrs = new Map<string, string>();
  let selfClosing = false;
  while (index < html.length) {
    const char = html[index];
    if (isSpace(html.charCodeAt(index))) {
      index++;
      continue;
    }
    if (char === ">") return { name, attrs, selfClosing, end: index + 1 };
    if (char === "/") {
      index++;
      selfClosing = html[index] === ">";
      continue;
    }
    selfClosing = false;
    const nameStart = index;
    index++;
    while (index < html.length && !endsName(html, index, "/>=")) index++;
    const attrName = html.slice(nameStart, index).toLowerCase();
    while (index < html.length && isSpace(html.charCodeAt(index))) index++;
    let value = "";
    if (html[index] === "=") {
      index++;
      while (index < html.length && isSpace(html.charCodeAt(index))) index++;
      const quote = html[index];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, index + 1);
        if (close === -1) return undefined;
        value = html.slice(index + 1, close);
        index = close + 1;
      } else {
        const valueStart = index;
        while (index < html.length && !endsName(html, index, ">")) index++;
        value = html.slice(valueStart, index);
      }
    }
    if (!attrs.has(attrName)) attrs.set(attrName, decodeEntities(value));
  }
  return undefined;
};

/** The "</name" that ends raw text: the name must be followed by whitespace, "/", ">" or EOF. */
const rawTextEnd = (html: string, from: number, name: string): number => {
  for (let at = html.indexOf("</", from); at !== -1; at = html.indexOf("</", at + 2)) {
    const after = at + 2 + name.length;
    if (html.slice(at + 2, after).toLowerCase() !== name) continue;
    if (after >= html.length || endsName(html, after, "/>")) return at;
  }
  return -1;
};

const makeElement = (
  tag: string,
  attrs: ReadonlyMap<string, string>,
  foreign: boolean,
): ElementNode => ({ kind: "element", tag, attrs, children: [], foreign });

/** Tolerant tree building: implied closes, stray end tags ignored, truncated tags dropped. */
const parseHtml = (html: string): ElementNode => {
  const root = makeElement("#root", new Map(), false);
  const stack: Array<ElementNode> = [root];
  const top = () => stack.at(-1) ?? root;
  const addText = (text: string) => {
    if (!text) return;
    const parent = top();
    const last = parent.children.at(-1);
    if (last?.kind === "text") last.text += text;
    else parent.children.push({ kind: "text", text });
  };
  const closeWithin = (close: ReadonlySet<string>, within: ReadonlySet<string>) => {
    for (let depth = stack.length - 1; depth > 0; depth--) {
      const tag = stack[depth]?.tag ?? "";
      if (close.has(tag)) {
        stack.length = depth;
        return;
      }
      if (within.has(tag)) return;
    }
  };
  const open = (tag: StartTag) => {
    if (CLOSES_P.has(tag.name)) closeWithin(set("p"), P_SCOPE);
    const implied = IMPLIED_CLOSES.get(tag.name);
    if (implied) closeWithin(implied.close, implied.within);
    const parent = top();
    const foreign = parent.foreign || tag.name === "svg" || tag.name === "math";
    const element = makeElement(tag.name, tag.attrs, foreign);
    parent.children.push(element);
    // HTML ignores "/>" on its own elements; only foreign content (svg, math) self-closes.
    if (!VOID.has(tag.name) && !(tag.selfClosing && foreign)) stack.push(element);
    return element;
  };

  let index = 0;
  while (index < html.length) {
    const lt = html.indexOf("<", index);
    if (lt === -1) {
      addText(decodeEntities(html.slice(index)));
      break;
    }
    addText(decodeEntities(html.slice(index, lt)));
    index = lt;
    const next = html.charCodeAt(index + 1);
    if (html.startsWith("<!--", index)) {
      const end = html.indexOf("-->", index + 4);
      index = end === -1 ? html.length : end + 3;
    } else if (next === 33 || next === 63) {
      const end = html.indexOf(">", index + 2);
      index = end === -1 ? html.length : end + 1;
    } else if (next === 47) {
      const end = html.indexOf(">", index + 2);
      if (end === -1) break;
      const name = /^[^\s/>]*/.exec(html.slice(index + 2, end))?.[0].toLowerCase() ?? "";
      if (name === "br") open({ name, attrs: new Map(), selfClosing: false, end });
      else if (name) closeWithin(set(name), TABLE_PARTS.has(name) ? TABLE_BOUNDS : END_TAG_SCOPE);
      index = end + 1;
    } else if (!isAlpha(next)) {
      addText("<");
      index++;
    } else {
      const tag = scanStartTag(html, index);
      if (!tag) break;
      index = tag.end;
      if (!RAW_TEXT.has(tag.name) && !RCDATA.has(tag.name)) {
        open(tag);
        continue;
      }
      const element = open({ ...tag, selfClosing: false });
      const end = rawTextEnd(html, index, tag.name);
      const body = html.slice(index, end === -1 ? html.length : end);
      element.children.push({
        kind: "text",
        text: RCDATA.has(tag.name) ? decodeEntities(body) : body,
      });
      if (stack.at(-1) === element) stack.pop();
      const close = end === -1 ? -1 : html.indexOf(">", end);
      index = close === -1 ? html.length : close + 1;
    }
  }
  return root;
};

const HIDDEN_STYLE =
  /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!\s*important\s*)?(?:;|$)/i;

const isNoise = (element: ElementNode): boolean => {
  if (NOISE.has(element.tag))
    return !(element.tag === "template" && element.attrs.has("shadowrootmode"));
  if (element.attrs.has("hidden") || element.attrs.has("inert")) return true;
  if (element.attrs.get("aria-hidden")?.trim().toLowerCase() === "true") return true;
  const style = element.attrs.get("style");
  return style !== undefined && HIDDEN_STYLE.test(style);
};

const SENSITIVE_QUERY =
  /token|secret|passw|session|cookie|credential|authoriz|^auth$|api[-_]?key|csrf|xsrf/i;
const LINK_SCHEMES = set("http:", "https:", "mailto:");
const IMAGE_SCHEMES = set("http:", "https:");
const PLACEHOLDER_BASE = "https://placeholder.invalid/";

/** Allowed-scheme URL with sensitive query values redacted; relative URLs keep their form. */
const safeUrl = (raw: string | undefined, schemes: ReadonlySet<string>): string | undefined => {
  if (raw === undefined) return undefined;
  let cleaned = "";
  for (const char of raw) {
    const code = char.charCodeAt(0);
    if (code > 32 && code !== 127) cleaned += char;
  }
  if (!cleaned || cleaned.startsWith("#")) return undefined;
  const url = URL.parse(cleaned, PLACEHOLDER_BASE);
  if (url === null || !schemes.has(url.protocol)) return undefined;
  for (const key of Array.from(url.searchParams.keys()))
    if (SENSITIVE_QUERY.test(key)) url.searchParams.set(key, "redacted");
  const destination = /^[a-z][a-z0-9+.-]*:/i.test(cleaned)
    ? url.href
    : cleaned.startsWith("//")
      ? url.href.slice(url.protocol.length)
      : (cleaned.split(/[?#]/, 1)[0] ?? "") + url.search + url.hash;
  return destination
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")
    .replaceAll(" ", "%20")
    .replaceAll("<", "%3C")
    .replaceAll(">", "%3E");
};

const escapeLabel = (label: string) => label.replace(/[\\[\]]/g, "\\$&");
const collapse = (text: string) => text.replace(/[ \t\n\r\f]+/g, " ");
const dropped = (text: string) => DROP_OPEN + text + DROP_CLOSE;

const TYPE_BLOB = /\{"\$type":[^}]{100,}\}/g;
const NESTED_BLOB = /\{"[^"]{5,}":\{[^}]{100,}\}/g;
const isJson = (text: string) => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

/** Trims spaces (never INDENT) from each line and squeezes blank runs; blankLines=false drops them. */
const tidyLines = (text: string, blankLines: boolean): string => {
  const lines: Array<string> = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^[ \t]+|[ \t]+$/g, "");
    if (line || (blankLines && lines.length > 0 && lines.at(-1) !== "")) lines.push(line);
  }
  while (lines.at(-1) === "") lines.pop();
  return lines.join("\n");
};

/** Keeps outer whitespace outside the delimiters, as markdownify's chomp does. */
const chomp = (inner: string, wrap: (middle: string) => string) => {
  const middle = inner.trim();
  if (!middle) return inner;
  const lead = inner.slice(0, inner.length - inner.trimStart().length);
  return lead + wrap(middle) + inner.slice(inner.trimEnd().length);
};

const INLINE_MARKS: ReadonlyMap<string, string> = new Map([
  ["strong", "**"],
  ["b", "**"],
  ["em", "*"],
  ["i", "*"],
  ["del", "~~"],
  ["s", "~~"],
  ["strike", "~~"],
]);

interface RenderContext {
  /** Table cells and headings: one line, so blocks and breaks become spaces. */
  readonly inline: boolean;
  readonly link: boolean;
  readonly depth: number;
}

const renderMarkdown = (root: ElementNode, options: CleanMarkdownOptions) => {
  const codeBlocks: Array<string> = [];
  let depthCut = false;

  const textOf = (element: ElementNode): string => {
    let out = "";
    const pending: Array<HtmlNode> = [];
    const pushChildren = (parent: ElementNode) => {
      for (let index = parent.children.length - 1; index >= 0; index--) {
        const child = parent.children[index];
        if (child) pending.push(child);
      }
    };
    pushChildren(element);
    for (let next = pending.pop(); next; next = pending.pop()) {
      if (next.kind === "text") out += next.text;
      else if (next.tag === "br") out += "\n";
      else if (!isNoise(next)) pushChildren(next);
    }
    return out;
  };

  const renderText = (value: string): string => {
    const text = collapse(value);
    const trimmed = text.trim();
    if (trimmed.length > 100 && "{[".includes(trimmed[0] ?? "") && isJson(trimmed))
      return dropped(text);
    return text.replace(TYPE_BLOB, dropped).replace(NESTED_BLOB, dropped);
  };

  const children = (parent: ElementNode, context: RenderContext) => {
    let out = "";
    const nested = { ...context, depth: context.depth + 1 };
    for (const child of parent.children) out += node(child, nested);
    return out;
  };

  const block = (inner: string, context: RenderContext) => {
    const body = inner.trim();
    if (!body) return context.inline ? " " : "";
    return context.inline ? " " + body + " " : "\n\n" + body + "\n\n";
  };

  const listItem = (item: ElementNode, marker: string, context: RenderContext) => {
    const inner = tidyLines(children(item, context), false);
    if (!inner) return "";
    const indent = INDENT.repeat(marker.length);
    return inner
      .split("\n")
      .map((line, index) => (index === 0 ? marker : indent) + line)
      .join("\n");
  };

  const list = (target: ElementNode, context: RenderContext) => {
    const start = target.attrs.get("start")?.trim() ?? "";
    let number = /^\d+$/.test(start) ? Number(start) : 1;
    const nested = { ...context, depth: context.depth + 1 };
    let out = "";
    for (const child of target.children) {
      if (child.kind !== "element" || child.tag !== "li" || isNoise(child)) {
        out += node(child, nested);
        continue;
      }
      const marker = target.tag === "ol" ? String(number++) + ". " : "- ";
      out += context.inline
        ? " " + children(child, nested) + " "
        : "\n" + listItem(child, marker, nested) + "\n";
    }
    return block(out, context);
  };

  const cellText = (cell: ElementNode, context: RenderContext) =>
    collapse(children(cell, { ...context, inline: true }))
      .trim()
      .replaceAll("|", "\\|");

  const table = (target: ElementNode, context: RenderContext) => {
    const rows: Array<{ readonly cells: Array<string>; readonly header: boolean }> = [];
    let caption = "";
    const addRow = (row: ElementNode, theadRows: number) => {
      const cells: Array<string> = [];
      let allHeaders = true;
      for (const cell of row.children) {
        if (cell.kind !== "element" || (cell.tag !== "td" && cell.tag !== "th") || isNoise(cell))
          continue;
        if (cell.tag === "td") allHeaders = false;
        cells.push(cellText(cell, context));
        const span = Number.parseInt(cell.attrs.get("colspan") ?? "1", 10);
        for (let extra = 1; extra < Math.min(MAX_COLSPAN, span); extra++) cells.push("");
      }
      if (cells.length > 0) rows.push({ cells, header: allHeaders || theadRows === 1 });
    };
    const isRow = (child: HtmlNode): child is ElementNode =>
      child.kind === "element" && child.tag === "tr" && !isNoise(child);
    for (const child of target.children) {
      if (child.kind !== "element" || isNoise(child)) continue;
      if (child.tag === "caption") caption = cellText(child, context);
      else if (child.tag === "tr") addRow(child, 0);
      else if (child.tag === "thead" || child.tag === "tbody" || child.tag === "tfoot") {
        const sectionRows = child.children.filter(isRow);
        for (const row of sectionRows) addRow(row, child.tag === "thead" ? sectionRows.length : 0);
      }
    }
    if (context.inline)
      return " " + [caption, ...rows.flatMap((row) => row.cells)].filter(Boolean).join(" ") + " ";
    if (rows.length === 0) return block(caption, context);
    const width = Math.min(MAX_COLSPAN, Math.max(...rows.map((row) => row.cells.length)));
    const line = (cells: ReadonlyArray<string>) =>
      "| " + Array.from({ length: width }, (_, index) => cells[index] ?? "").join(" | ") + " |";
    const separator = line(Array.from({ length: width }, () => "---"));
    const [first, ...rest] = rows;
    const body = first?.header
      ? [line(first.cells), separator, ...rest.map((row) => line(row.cells))]
      : [line([]), separator, ...rows.map((row) => line(row.cells))];
    return "\n\n" + (caption ? caption + "\n\n" : "") + body.join("\n") + "\n\n";
  };

  const preformatted = (target: ElementNode, context: RenderContext) => {
    const raw = textOf(target);
    if (context.inline) return " " + collapse(raw).trim() + " ";
    const code = raw.replace(/^\n+/, "").replace(/\n+$/, "");
    if (!code.trim()) return "";
    codeBlocks.push(code);
    return "\n\n" + CODE + String(codeBlocks.length - 1) + CODE + "\n\n";
  };

  const inlineCode = (target: ElementNode) => {
    const code = collapse(textOf(target));
    if (!code.trim()) return code;
    const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
    const fence = "`".repeat(longest + 1);
    const pad = longest > 0 ? " " : "";
    const rendered = fence + pad + code + pad + fence;
    return /^\{["\w].*\}$/s.test(code.trim()) ? dropped(rendered) : rendered;
  };

  const anchor = (target: ElementNode, context: RenderContext) => {
    if (!options.extractLinks || context.link) return children(target, context);
    const inner = children(target, { ...context, link: true });
    const href = safeUrl(target.attrs.get("href"), LINK_SCHEMES);
    if (href === undefined || inner.trim().includes("\n")) return inner;
    return chomp(inner, (label) => "[" + escapeLabel(collapse(label)) + "](" + href + ")");
  };

  const image = (target: ElementNode, context: RenderContext) => {
    const alt = collapse(target.attrs.get("alt") ?? "").trim();
    if (!options.extractImages || context.link) return alt;
    const src = safeUrl(target.attrs.get("src"), IMAGE_SCHEMES);
    return src === undefined ? alt : "![" + escapeLabel(alt) + "](" + src + ")";
  };

  const blockquote = (target: ElementNode, context: RenderContext) => {
    if (context.inline) return " " + children(target, context) + " ";
    const body = tidyLines(children(target, context), true);
    if (!body) return "";
    const quoted = body.split("\n").map((line) => (line ? "> " + line : ">"));
    return "\n\n" + quoted.join("\n") + "\n\n";
  };

  const element = (target: ElementNode, context: RenderContext): string => {
    const { tag } = target;
    if (/^h[1-6]$/.test(tag)) {
      const title = collapse(children(target, { ...context, inline: true })).trim();
      if (!title) return "";
      if (context.inline) return " " + title + " ";
      return "\n\n" + "#".repeat(Number(tag[1])) + " " + title + "\n\n";
    }
    const mark = INLINE_MARKS.get(tag);
    if (mark) return chomp(children(target, context), (middle) => mark + middle + mark);
    switch (tag) {
      case "br":
        return context.inline ? " " : "\n";
      case "hr":
        return context.inline ? " " : "\n\n---\n\n";
      case "a":
        return anchor(target, context);
      case "img":
        return image(target, context);
      case "code":
      case "kbd":
      case "samp":
        return inlineCode(target);
      case "pre":
        return preformatted(target, context);
      case "ul":
      case "ol":
      case "menu":
        return list(target, context);
      case "li":
        return context.inline
          ? " " + children(target, context) + " "
          : "\n\n" + listItem(target, "- ", context) + "\n\n";
      case "table":
        return table(target, context);
      case "blockquote":
        return blockquote(target, context);
      default:
        return BLOCKS.has(tag)
          ? block(children(target, context), context)
          : children(target, context);
    }
  };

  const node = (target: HtmlNode, context: RenderContext): string => {
    if (target.kind === "text") return renderText(target.text);
    if (isNoise(target)) return "";
    if (context.depth > MAX_RENDER_DEPTH) {
      depthCut = true;
      return "";
    }
    return element(target, context);
  };

  const rendered = children(root, { inline: false, link: false, depth: 0 });
  return { rendered, codeBlocks, depthCut: () => depthCut };
};

/** Keeps or removes the DROP_OPEN..DROP_CLOSE spans the renderer marked as JSON noise. */
const resolveDrops = (text: string, keep: boolean): string => {
  let out = "";
  let from = 0;
  for (let open = text.indexOf(DROP_OPEN); open !== -1; open = text.indexOf(DROP_OPEN, from)) {
    const close = text.indexOf(DROP_CLOSE, open + 1);
    if (close === -1) break;
    out += text.slice(from, open) + (keep ? text.slice(open + 1, close) : "");
    from = close + 1;
  }
  return out + text.slice(from);
};

const restoreCode = (line: string, codeBlocks: ReadonlyArray<string>): string => {
  const open = line.indexOf(CODE);
  const close = open === -1 ? -1 : line.indexOf(CODE, open + 1);
  if (close === -1) return line;
  const code = codeBlocks[Number(line.slice(open + 1, close))] ?? "";
  const prefix = line.slice(0, open);
  // List markers become spaces and quote markers stay, so the block remains in its container.
  const continuation = prefix.replace(/[^>\s]/g, " ");
  const longest = Math.max(2, ...(code.match(/`{3,}/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const body = code
    .split("\n")
    .map((codeLine) => (codeLine ? continuation + codeLine : continuation.trimEnd()));
  const trailing = line.slice(close + 1).trim();
  return [prefix + fence, ...body, continuation + fence, ...(trailing ? [trailing] : [])].join(
    "\n",
  );
};

/** Final pass: tidy lines, collapse blank runs, then put code blocks back inside their container. */
const finish = (text: string, codeBlocks: ReadonlyArray<string>): string =>
  tidyLines(text, true)
    .split("\n")
    .map((line) => {
      const spaced = line.replaceAll(INDENT, " ");
      return spaced.trim() ? spaced.trimEnd() : "";
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .split("\n")
    .map((line) => restoreCode(line, codeBlocks))
    .join("\n");

const truncate = (text: string, maxChars: number | undefined) => {
  if (maxChars === undefined || !Number.isFinite(maxChars)) return { text, truncated: false };
  const limit = Math.max(0, Math.floor(maxChars));
  if (text.length <= limit) return { text, truncated: false };
  let end = limit;
  const newline = text.lastIndexOf("\n", limit);
  if (newline >= limit / 2) end = newline;
  else {
    const before = text.charCodeAt(end - 1);
    if (end > 0 && before >= 0xd800 && before <= 0xdbff) end--;
  }
  return { text: text.slice(0, end).trimEnd(), truncated: true };
};

export const extractCleanMarkdown = (
  html: string,
  options: CleanMarkdownOptions = {},
): CleanMarkdown => {
  const page = renderMarkdown(parseHtml(withoutMarkers(html)), options);
  const initial = finish(resolveDrops(page.rendered, true), page.codeBlocks);
  const filtered = finish(resolveDrops(page.rendered, false), page.codeBlocks);
  const final = truncate(filtered, options.maxChars);
  return {
    markdown: final.text,
    stats: {
      originalHtmlChars: html.length,
      initialMarkdownChars: initial.length,
      filteredCharsRemoved: initial.length - filtered.length,
      finalMarkdownChars: final.text.length,
      truncated: final.truncated || page.depthCut(),
    },
  };
};
